import { Hono } from 'hono'
import type { SupportedSport } from '../../curated.js'
import {
  deriveMatchTitle,
  domeEndTimeToIso,
  domeGetMarketPrice,
  domeGetMarketsByEventSlug,
  domeGetSportMarkets,
  domeGroupMatchOutcomes,
  domeMarketToClobTokenIds,
  domeOutcomeLabel,
} from '../../dome.js'
import {
  gammaFetch,
  gammaFetchCached,
  getLivePrice,
  normalizeSoccerOutcomeLabel,
  parseNullableNumber,
  parseNullableString,
  parseStringArray,
  registerTokenIds,
  withDomeFallback,
} from '../read/market-read.js'
import {
  deriveMatchStatus,
  getMainSportsMarkets,
  mapGammaEventToFeaturedMarket,
  SPORT_SERIES,
} from '../read/featured-markets.js'
import { resolveSportsRuleForReadCode } from '../catalog/sports-rules.js'

export function createPolymarketSportsRoutes(): Hono {
  const routes = new Hono()

  // GET /polymarket/sports/:sport
  // Dynamically fetches live games for a sport — no hardcoded slugs needed.
  // Supported: epl, ucl, ipl, fifwc
  routes.get('/sports/:sport', async (c) => {
    const sport = c.req.param('sport').toLowerCase() as SupportedSport
    const seriesId = SPORT_SERIES[sport]

    if (!seriesId) {
      return c.json({ error: `Unsupported sport. Supported: ${Object.keys(SPORT_SERIES).join(', ')}` }, 400)
    }

    // Shared mapper: normalises an event (from either Dome or Gamma) into the response shape
    function mapEventToGame(e: Record<string, unknown>, _source: 'dome' | 'gamma') {
      const markets = (e.markets ?? []) as Record<string, unknown>[]

      const outcomes = markets.map((m) => {
        const outcomePrices = parseStringArray(m.outcomePrices)
        const clobTokenIds = parseStringArray(m.clobTokenIds)

        return {
          label: m.groupItemTitle ?? m.question ?? null,
          price: parseNullableNumber(outcomePrices[0]),
          conditionId: m.conditionId ?? m.condition_id ?? null,
          clobTokenIds,
        }
      })

      return {
        slug: e.slug,
        title: e.title,
        sport,
        startDate: e.startDate ?? null,
        endDate: e.endDate ?? null,
        image: e.image ?? null,
        active: e.active ?? null,
        volume24h: e.volume24hr ?? e.volume24h ?? null,
        liquidity: e.liquidity ?? null,
        negRisk: e.negRisk ?? false,
        outcomes,
        _source, // debug only — strip if noisy
      }
    }

    try {
      const games = await withDomeFallback<unknown[]>(
        `sports/list/${sport}`,
        async () => {
          // Dome: flat list of outcome markets → group by event_slug → fetch prices
          const allMarkets = await domeGetSportMarkets(sport)
          const now = Math.floor(Date.now() / 1000)
          const matchGroups = domeGroupMatchOutcomes(allMarkets)
            // Exclude matches that have already ended
            .filter((g) => !g.endTime || g.endTime > now)

          // Fetch all YES token prices in one parallel batch
          const allTokenIds = matchGroups.flatMap((g) =>
            g.outcomes.map((m) => m.side_a?.id).filter(Boolean) as string[]
          )
          const priceResults = await Promise.allSettled(
            allTokenIds.map((id) => domeGetMarketPrice(id))
          )
          const priceMap = new Map<string, number | null>()
          allTokenIds.forEach((id, i) => {
            const r = priceResults[i]
            priceMap.set(id, r.status === 'fulfilled' ? r.value : null)
          })

          return matchGroups.map((g) => {
            const outcomes = g.outcomes.map((m) => ({
              label: domeOutcomeLabel(m),
              price: priceMap.get(m.side_a?.id ?? '') ?? null,
              conditionId: m.condition_id ?? null,
              clobTokenIds: domeMarketToClobTokenIds(m),
            }))

            return {
              slug: g.eventSlug,
              title: deriveMatchTitle(g.outcomes),
              sport,
              startDate: g.gameStartTime ?? null,
              endDate: domeEndTimeToIso(g.endTime),
              image: g.image ?? null,
              active: true,
              volume24h: g.volume1Week,
              liquidity: null,
              negRisk: true,
              outcomes,
            }
          })
        },
        async () => {
          const res = await gammaFetch(`events?series_id=${seriesId}&active=true&closed=false&limit=20`)
          if (!res.ok) throw new Error(`Gamma API ${res.status} for sport ${sport}`)
          const raw = await res.json()
          if (!Array.isArray(raw)) throw new Error(`Gamma unexpected response for sport ${sport}`)
          return (raw as Record<string, unknown>[])
            .filter((e) => !String(e.slug ?? '').endsWith('-more-markets'))
            .map((e) => mapEventToGame(e, 'gamma'))
        },
      )

      return c.json(games)
    } catch (err) {
      console.error(`[api] Unexpected error in GET /polymarket/sports/${sport}:`, err)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })

  // GET /polymarket/sports/:sport/:slug — full game detail with all outcomes
  routes.get('/sports/:sport/:slug', async (c) => {
    const sportParam = c.req.param('sport').toLowerCase()
    const slug = c.req.param('slug')

    // International cricket uses a shared display sport while Polymarket's
    // durable selectors are codes such as crint. Fetch any main cricket event
    // directly so automatic catalog entries can open without a route rebuild.
    if (sportParam === 'cricket' && slug.toLowerCase().startsWith('cr')) {
      const sport = sportParam
      try {
        const events = await gammaFetchCached<Record<string, unknown>[]>(`events?slug=${encodeURIComponent(slug)}`)
        const e = Array.isArray(events) ? events[0] : null
        if (!e) return c.json({ error: 'Not found' }, 404)

        const tags = Array.isArray(e.tags) ? e.tags : []
        const isCricketEvent = slug.toLowerCase().startsWith('crint-')
          || String(e.seriesSlug ?? '').toLowerCase().includes('cricket')
          || tags.some((tag) => tag && typeof tag === 'object'
            && String((tag as Record<string, unknown>).slug ?? '').toLowerCase().includes('cricket'))
        if (!isCricketEvent) return c.json({ error: 'Not found' }, 404)

        const markets = (e.markets ?? []) as Record<string, unknown>[]
        const mainMarket = markets.find((m) => m.slug === e.slug && m.sportsMarketType === 'moneyline')
          ?? markets.find((m) => m.sportsMarketType === 'moneyline')
        if (!mainMarket) return c.json({ error: 'Not found' }, 404)

        const outcomesRaw = parseStringArray(mainMarket.outcomes)
        const outcomePrices = parseStringArray(mainMarket.outcomePrices)
        const clobTokenIds = parseStringArray(mainMarket.clobTokenIds)
        const outcomes = outcomesRaw.map((label, idx) => ({
          label,
          question: mainMarket.question ?? null,
          price: parseNullableNumber(outcomePrices[idx]),
          conditionId: parseNullableString(mainMarket.conditionId ?? mainMarket.condition_id),
          clobTokenIds: clobTokenIds[idx] ? [clobTokenIds[idx]] : [],
          liquidity: mainMarket.liquidityNum ?? null,
          volume24h: mainMarket.volume24hr ?? null,
          bestBid: mainMarket.bestBid ?? null,
          bestAsk: mainMarket.bestAsk ?? null,
          acceptingOrders: mainMarket.acceptingOrders ?? null,
        }))

        for (const outcome of outcomes) {
          const yesToken = outcome.clobTokenIds?.[0]
          if (yesToken) {
            registerTokenIds([yesToken])
            const live = getLivePrice(yesToken)
            if (live !== null) outcome.price = live
          }
        }

        const gameStart = String(mainMarket.gameStartTime ?? e.startTime ?? '')
        const isActive = (e.active as boolean) ?? false
        const isClosed = (e.closed as boolean) ?? false
        const umaStatus = (mainMarket.umaResolutionStatus as string) ?? null

        return c.json({
          slug: e.slug,
          title: e.title,
          description: e.description ?? null,
          sport,
          status: deriveMatchStatus(
            gameStart || null,
            isActive,
            isClosed,
            outcomes.map((o) => o.price),
            sport,
            umaStatus,
            undefined,
            String(e.slug ?? slug),
          ),
          gameStartTime: gameStart || null,
          startDate: e.startDate ?? null,
          endDate: e.endDate ?? null,
          image: e.image ?? null,
          active: e.active ?? null,
          negRisk: e.negRisk ?? false,
          volume24h: e.volume24hr ?? null,
          liquidity: e.liquidity ?? null,
          teams: mapGammaEventToFeaturedMarket(e, {
            category: 'sports',
            sport,
            mainMoneylineOnly: true,
          })?.teams ?? [],
          outcomes,
        })
      } catch (err) {
        console.error(`[api] Unexpected error in GET /polymarket/sports/${sport}/${slug}:`, err)
        return c.json({ error: 'Internal server error' }, 500)
      }
    }

    const sport = sportParam as SupportedSport
    const seriesId = SPORT_SERIES[sport]

    if (!seriesId) {
      try {
        const resolved = await resolveSportsRuleForReadCode(sportParam)
        if (!resolved) return c.json({ error: 'Unsupported sport code' }, 400)
        return c.json(await gammaSportsDetail({
          sport: sportParam,
          slug,
          seriesId: resolved.seriesId,
          seriesSlug: resolved.seriesSlug,
        }))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('not found')) return c.json({ error: 'Not found' }, 404)
        console.error(`[api] Unexpected error in GET /polymarket/sports/${sportParam}/${slug}:`, err)
        return c.json({ error: 'Internal server error' }, 500)
      }
    }

    // Shared outcome mapper — same shape from Dome or Gamma events
    function mapOutcome(m: Record<string, unknown>) {
      const outcomePrices = parseStringArray(m.outcomePrices)
      const clobTokenIds = parseStringArray(m.clobTokenIds)
      return {
        label: sport === 'ipl' ? m.groupItemTitle ?? null : normalizeSoccerOutcomeLabel(m.groupItemTitle),
        question: m.question ?? null,
        price: parseNullableNumber(outcomePrices[0]),
        conditionId: parseNullableString(m.conditionId ?? m.condition_id),
        clobTokenIds,
        liquidity: m.liquidityNum ?? null,
        volume24h: m.volume24hr ?? null,
        bestBid: m.bestBid ?? null,
        bestAsk: m.bestAsk ?? null,
        acceptingOrders: m.acceptingOrders ?? null,
      }
    }

    try {
      const detail = await withDomeFallback(
        `sports/detail/${sport}/${slug}`,
        async () => {
          // Dome: fetch all outcome markets for this event slug, then get prices
          if (!slug.startsWith(`${sport}-`)) {
            throw new Error(`Dome: slug ${slug} does not match sport ${sport}`)
          }

          const domeMarkets = await domeGetMarketsByEventSlug(slug)
          if (!domeMarkets.length) throw new Error(`Dome: no markets found for event ${slug}`)

          // Parallel price fetches for all YES tokens
          const priceResults = await Promise.allSettled(
            domeMarkets.map((m) => domeGetMarketPrice(m.side_a?.id ?? ''))
          )
          const prices = priceResults.map((r) => (r.status === 'fulfilled' ? r.value : null))

          const outcomes = domeMarkets.map((m, i) => ({
            label: domeOutcomeLabel(m),
            question: m.title,
            price: prices[i],
            conditionId: m.condition_id ?? null,
            clobTokenIds: domeMarketToClobTokenIds(m),
            liquidity: null,
            volume24h: m.volume_1_week ?? null,
            bestBid: null,
            bestAsk: null,
            acceptingOrders: m.status === 'open' ? true : false,
          }))

          const first = domeMarkets[0]
          return {
            slug,
            title: deriveMatchTitle(domeMarkets),
            description: first.description ?? null,
            sport,
            status: deriveMatchStatus(
              first.game_start_time ?? null,
              first.status === 'open',
              first.status === 'closed',
              outcomes.map((outcome) => outcome.price),
              sport,
              null,
              undefined,
              slug,
            ),
            gameStartTime: first.game_start_time ?? null,
            startDate: first.game_start_time ?? null,
            endDate: domeEndTimeToIso(first.end_time),
            image: first.image ?? null,
            active: first.status === 'open',
            negRisk: true,
            volume24h: domeMarkets.reduce((sum, m) => sum + (m.volume_1_week ?? 0), 0),
            liquidity: null,
            teams: [],
            outcomes,
          }
        },
        async () => {
          const res = await gammaFetch(`events?slug=${encodeURIComponent(slug)}`)
          if (!res.ok) throw new Error(`Gamma API ${res.status} for slug ${slug}`)

          const events = await res.json() as Record<string, unknown>[]
          if (!Array.isArray(events) || events.length === 0) throw new Error('not found')

          const e = events[0]
          const eventSlug = String(e.slug ?? '')
          const eventSeries = Array.isArray(e.series) ? e.series : []
          const belongsToSeries = eventSeries.some((row) => {
            if (!row || typeof row !== 'object') return false
            const id = (row as Record<string, unknown>).id
            return String(id) === seriesId
          })

          const slugPrefix = sport === 'ipl' ? 'cricipl-' : `${sport}-`
          if (!eventSlug.startsWith(slugPrefix) && !belongsToSeries) throw new Error('not found')

          const markets = (e.markets ?? []) as Record<string, unknown>[]

          // IPL: single market with outcomes embedded as string array — extract from main market
          // EPL/UCL: each market = one outcome, label from groupItemTitle
          let outcomes: ReturnType<typeof mapOutcome>[]
          if (sport === 'ipl') {
            const mainMarket = markets.find((m) => m.slug === slug) ?? markets[0]
            if (!mainMarket) throw new Error('not found')
            const outcomeLabels = typeof mainMarket.outcomes === 'string'
              ? JSON.parse(mainMarket.outcomes as string) as string[]
              : Array.isArray(mainMarket.outcomes) ? mainMarket.outcomes as string[] : []
            const outcomePrices = parseStringArray(mainMarket.outcomePrices)
            const clobTokenIds = parseStringArray(mainMarket.clobTokenIds)
            outcomes = outcomeLabels.map((label, idx) => ({
              label,
              question: mainMarket.question ?? null,
              price: parseNullableNumber(outcomePrices[idx]),
              conditionId: parseNullableString(mainMarket.conditionId ?? mainMarket.condition_id),
              clobTokenIds: clobTokenIds[idx] ? [clobTokenIds[idx]] : [],
              liquidity: mainMarket.liquidityNum ?? null,
              volume24h: mainMarket.volume24hr ?? null,
              bestBid: mainMarket.bestBid ?? null,
              bestAsk: mainMarket.bestAsk ?? null,
              acceptingOrders: mainMarket.acceptingOrders ?? null,
            }))
          } else {
            outcomes = markets.map(mapOutcome)
          }

          const featured = mapGammaEventToFeaturedMarket(e, {
            category: 'sports',
            sport,
            mainMoneylineOnly: true,
          })
          return {
            slug: e.slug,
            title: e.title,
            description: e.description ?? null,
            sport,
            status: featured?.status ?? 'upcoming',
            gameStartTime: featured?.gameStartTime ?? null,
            startDate: e.startDate ?? null,
            endDate: e.endDate ?? null,
            image: e.image ?? null,
            active: e.active ?? null,
            negRisk: e.negRisk ?? false,
            volume24h: e.volume24hr ?? null,
            liquidity: e.liquidity ?? null,
            teams: featured?.teams ?? [],
            outcomes,
          }
        },
      )

      // Override stale prices with live CLOB midpoints
      const detailObj = detail as Record<string, unknown>
      const detailOutcomes = detailObj.outcomes as { price: number | null; clobTokenIds: string[] }[] | undefined
      if (detailOutcomes) {
        for (const outcome of detailOutcomes) {
          const yesToken = outcome.clobTokenIds?.[0]
          if (yesToken) {
            registerTokenIds([yesToken])
            const live = getLivePrice(yesToken)
            if (live !== null) outcome.price = live
          }
        }
      }

      return c.json(detail)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('not found')) return c.json({ error: 'Not found' }, 404)
      console.error(`[api] Unexpected error in GET /polymarket/sports/${sport}/${slug}:`, err)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })


  return routes
}

async function gammaSportsDetail(input: {
  sport: string
  slug: string
  seriesId: string
  seriesSlug: string
}) {
  const events = await gammaFetchCached<Record<string, unknown>[]>(`events?slug=${encodeURIComponent(input.slug)}`)
  const event = Array.isArray(events) ? events[0] : null
  if (!event) throw new Error('not found')

  const eventSeries = Array.isArray(event.series) ? event.series : []
  const belongsToSeries = event.seriesSlug === input.seriesSlug || eventSeries.some((row) => {
    if (!row || typeof row !== 'object') return false
    return String((row as Record<string, unknown>).id ?? '') === input.seriesId
  })
  if (!belongsToSeries || getMainSportsMarkets(event).length === 0) throw new Error('not found')

  const featured = mapGammaEventToFeaturedMarket(event, {
    category: 'sports',
    sport: input.sport,
    mainMoneylineOnly: true,
  })
  if (!featured?.outcomes) throw new Error('not found')

  const outcomes = featured.outcomes.map((outcome) => {
    const tokenId = outcome.clobTokenIds[0]
    if (tokenId) registerTokenIds([tokenId])
    const livePrice = tokenId ? getLivePrice(tokenId) : null
    return {
      ...outcome,
      price: livePrice ?? outcome.price,
      question: null,
      liquidity: null,
      volume24h: null,
      bestBid: null,
      bestAsk: null,
      acceptingOrders: event.active !== false,
    }
  })

  return {
    slug: featured.slug,
    title: featured.title,
    description: event.description ?? null,
    sport: input.sport,
    status: featured.status,
    gameStartTime: featured.gameStartTime ?? null,
    startDate: event.startDate ?? null,
    endDate: featured.endDate,
    image: featured.image,
    active: featured.active,
    negRisk: event.negRisk ?? false,
    volume24h: featured.volume,
    liquidity: event.liquidity ?? null,
    teams: featured.teams ?? [],
    outcomes,
  }
}
