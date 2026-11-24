import { Hono } from 'hono'
import { CURATED_GEOPOLITICS_SLUGS } from '../curated.js'
import {
  clobFetch,
  fetchBuyPricesForTokenIds,
  fetchMidpointsForTokenIds,
  gammaFetch,
  gammaFetchCached,
  getLivePrice,
  normalizeTokenIds,
  parseNullableNumber,
  parseNullableString,
  parseStringArray,
  registerTokenIds,
} from '../read/market-read.js'
import {
  type FeaturedMarket,
  FEATURED_MARKET_SLUG,
  mapSingleMatchGammaEventToFeaturedMarket,
} from '../read/featured-markets.js'

export function createPolymarketMarketRoutes(): Hono {
  const routes = new Hono()

  // --- Polymarket read routes ---

  // GET /polymarket/markets
  routes.get('/markets', async (c) => {
    const results = await Promise.allSettled(
      CURATED_GEOPOLITICS_SLUGS.map(async (slug) => {
        const res = await gammaFetch(`markets?slug=${encodeURIComponent(slug)}`)
        if (!res.ok) throw new Error(`Gamma API ${res.status} for slug ${slug}`)

        const data = await res.json() as unknown[]
        if (!Array.isArray(data) || data.length === 0) throw new Error(`No market found for slug ${slug}`)

        const market = data[0] as Record<string, unknown>
        const clobTokenIds = parseStringArray(market.clobTokenIds ?? market.clob_token_ids)

        let yesPrice: number | null = null
        let noPrice: number | null = null

        if (clobTokenIds.length >= 2) {
          const [yesPriceRes, noPriceRes] = await Promise.allSettled([
            clobFetch(`price?token_id=${encodeURIComponent(clobTokenIds[0])}&side=buy`),
            clobFetch(`price?token_id=${encodeURIComponent(clobTokenIds[1])}&side=buy`),
          ])
          if (yesPriceRes.status === 'fulfilled' && yesPriceRes.value.ok) {
            const body = await yesPriceRes.value.json() as Record<string, unknown>
            yesPrice = parseNullableNumber(body.price)
          }
          if (noPriceRes.status === 'fulfilled' && noPriceRes.value.ok) {
            const body = await noPriceRes.value.json() as Record<string, unknown>
            noPrice = parseNullableNumber(body.price)
          }
        }

        return {
          slug,
          question: market.question ?? market.title ?? null,
          category: 'geopolitics',
          conditionId: market.conditionId ?? market.condition_id ?? null,
          clobTokenIds,
          yesPrice,
          noPrice,
          volume24h: market.volume24hr ?? market.volume_24h ?? market.volume ?? null,
          endDate: market.endDate ?? market.end_date ?? null,
          active: market.active ?? null,
          image: market.image ?? market.imageUrl ?? null,
        }
      })
    )

    const markets: unknown[] = []
    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (result.status === 'fulfilled') {
        markets.push(result.value)
      } else {
        console.error(`[api] GET /polymarket/markets — skipping ${CURATED_GEOPOLITICS_SLUGS[i]}:`, result.reason)
      }
    }

    return c.json(markets)
  })

  // GET /polymarket/markets/:slug
  // No curated gate — feed blocks need any valid Polymarket slug, not just curated ones.
  // The curated list applies only to GET /polymarket/markets (list endpoint).
  routes.get('/markets/:slug', async (c) => {
    const slug = c.req.param('slug')

    try {
      const res = await gammaFetch(`markets?slug=${encodeURIComponent(slug)}`)
      if (!res.ok) throw new Error(`Gamma API ${res.status}`)
      const arr = await res.json() as unknown[]
      if (!Array.isArray(arr) || arr.length === 0) throw new Error('not found')
      const data = arr[0]

      // Override outcomePrices with live CLOB midpoints when available
      const mkt = data as Record<string, unknown>
      const mktTokenIds = parseStringArray(mkt.clobTokenIds ?? mkt.clob_token_ids)
      if (mktTokenIds.length >= 1) {
        registerTokenIds(mktTokenIds)
        const liveYes = getLivePrice(mktTokenIds[0])
        const liveNo = mktTokenIds[1] ? getLivePrice(mktTokenIds[1]) : null
        if (liveYes !== null || liveNo !== null) {
          const currentPrices = parseStringArray(mkt.outcomePrices)
          mkt.outcomePrices = JSON.stringify([
            String(liveYes ?? currentPrices[0] ?? '0'),
            String(liveNo ?? currentPrices[1] ?? '0'),
          ])
          if (liveYes !== null) mkt.bestBid = liveYes
          if (liveNo !== null) mkt.bestAsk = liveNo
        }
      }

      // Event context (Predict redesign PRD §5, additive): when this market
      // belongs to a parent event with sibling sub-markets, return the event
      // question plus one entry per sub-market so the client can render the
      // multi-outcome ladder. Absent (undefined) for plain binary markets —
      // clients must treat a missing block as "not an event".
      try {
        // Resolve via Gamma: find the parent event for this market slug.
        const evRes = await gammaFetch(`events?slug=${encodeURIComponent(slug)}`)
        if (evRes.ok) {
          const events = await evRes.json() as unknown[]
          const ev = Array.isArray(events) ? events.find((e) => e && typeof e === 'object') as Record<string, unknown> | undefined : undefined
          if (ev) {
            const subMarketsRaw = Array.isArray(ev.markets) ? ev.markets.filter((m) => m && typeof m === 'object') as Record<string, unknown>[] : []
            if (subMarketsRaw.length > 2 || ev.slug !== slug) {
              const outcomes = subMarketsRaw.map((sm) => {
                const labels = parseStringArray(sm.outcomes)
                const prices = parseStringArray(sm.outcomePrices)
                const tokens = parseStringArray(sm.clobTokenIds)
                const yesIdx = Math.max(0, labels.findIndex((l) => l.toLowerCase() === 'yes'))
                const label = parseNullableString(sm.groupItemTitle) ?? labels[yesIdx] ?? sm.slug as string
                return {
                  id: parseNullableString(sm.conditionId ?? sm.condition_id) ?? String(sm.slug ?? ''),
                  slug: parseNullableString(sm.slug) ?? '',
                  label,
                  price: parseNullableNumber(prices[yesIdx]),
                  conditionId: parseNullableString(sm.conditionId ?? sm.condition_id),
                  clobTokenIds: tokens,
                  active: typeof sm.active === 'boolean' ? sm.active : null,
                  closed: sm.closed === true,
                  volume24h: parseNullableNumber(sm.volume24hr),
                }
              })
              // Only expose it as an event when there are real sibling markets.
              if (outcomes.length > 1) {
                mkt.event = {
                  slug: parseNullableString(ev.slug) ?? slug,
                  title: parseNullableString(ev.title) ?? slug,
                  description: parseNullableString(ev.description),
                  endDate: parseNullableString(ev.endDate),
                  active: typeof ev.active === 'boolean' ? ev.active : null,
                  negRisk: ev.negRisk === true,
                  volume24h: parseNullableNumber(ev.volume24hr),
                  outcomes,
                }
              }
            }
          }
        }
      } catch (eventErr) {
        // Event context is best-effort decoration — a failure here must never
        // fail the detail read itself.
        console.warn(`[api] event context lookup failed for ${slug}:`, eventErr instanceof Error ? eventErr.message : eventErr)
      }

      return c.json(data)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('not found') || msg.includes('no market')) {
        return c.json({ error: 'Not found' }, 404)
      }
      console.error(`[api] Unexpected error in GET /polymarket/markets/${slug}:`, err)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })

  // Authenticated order operations are owned by the mobile unified SDK.

  // GET /polymarket/history/:tokenId
  // tokenId = Yes token ID from clobTokenIds[0] (pass the Yes token for Yes price history)
  // ?interval=1h (default) | 1d
  // Response shape: { history: [{ t: number, p: number }] }
  routes.get('/history/:tokenId', async (c) => {
    const tokenId = c.req.param('tokenId')

    if (!tokenId || tokenId.trim() === '') {
      return c.json({ error: 'Bad request' }, 400)
    }

    const interval = c.req.query('interval') ?? '1h'
    const fidelityMap: Record<string, number> = { '1m': 1, '5m': 5, '1h': 60, '1d': 1440 }
    const fidelity = fidelityMap[interval]

    if (!fidelity) {
      return c.json({ error: 'Bad request', detail: 'interval must be one of: 1m, 5m, 1h, 1d' }, 400)
    }

    const endTs = Math.floor(Date.now() / 1000)
    const startTs = endTs - 7 * 24 * 60 * 60 // last 7 days

    try {
      const res = await clobFetch(
        `prices-history?market=${encodeURIComponent(tokenId)}&startTs=${startTs}&endTs=${endTs}&fidelity=${fidelity}`
      )

      if (!res.ok) {
        console.error(`[api] CLOB prices-history error ${res.status} for ${tokenId}`)
        return c.json({ error: 'Internal server error' }, 500)
      }

      // Normalise to { history: [{ t, p }] } — CLOB already returns this shape,
      // but wrap defensively so the contract holds if the upstream shape changes.
      const raw = await res.json() as Record<string, unknown>
      const history = Array.isArray(raw.history) ? raw.history : []
      return c.json({ history })
    } catch (err) {
      console.error(`[api] Unexpected error in GET /polymarket/history/${tokenId}:`, err)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })

  // GET /polymarket/price/:tokenId
  routes.get('/price/:tokenId', async (c) => {
    const tokenId = c.req.param('tokenId')

    if (!tokenId || tokenId.trim() === '') {
      return c.json({ error: 'Bad request' }, 400)
    }

    try {
      const [buyRes, sellRes] = await Promise.allSettled([
        clobFetch(`price?token_id=${encodeURIComponent(tokenId)}&side=buy`),
        clobFetch(`price?token_id=${encodeURIComponent(tokenId)}&side=sell`),
      ])

      let buy: number | null = null
      let sell: number | null = null

      if (buyRes.status === 'fulfilled' && buyRes.value.ok) {
        const body = await buyRes.value.json() as Record<string, unknown>
        buy = parseNullableNumber(body.price)
      } else {
        console.error(`[api] CLOB price buy failed for token ${tokenId}`)
      }

      if (sellRes.status === 'fulfilled' && sellRes.value.ok) {
        const body = await sellRes.value.json() as Record<string, unknown>
        sell = parseNullableNumber(body.price)
      } else {
        console.error(`[api] CLOB price sell failed for token ${tokenId}`)
      }

      return c.json({ tokenId, buy, sell })
    } catch (err) {
      console.error(`[api] Unexpected error in GET /polymarket/price/${tokenId}:`, err)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })

  // GET /polymarket/live-prices?tokenIds=tokenA,tokenB
  // Low-risk batch price read for polling clients. Uses the live midpoint cache first,
  // then fills missing tokens from CLOB /midpoints and finally CLOB /price.
  routes.get('/live-prices', async (c) => {
    const tokenIds = normalizeTokenIds(c.req.query('tokenIds'))
    if (tokenIds.length === 0) return c.json({ prices: [], fetchedAt: new Date().toISOString() })

    try {
      registerTokenIds(tokenIds)

      const priceMap = new Map<string, { price: number | null; source: 'cache' | 'midpoint' | 'price' | 'missing' }>()
      for (const tokenId of tokenIds) {
        const cached = getLivePrice(tokenId)
        if (cached !== null) priceMap.set(tokenId, { price: cached, source: 'cache' })
      }

      const missingAfterCache = tokenIds.filter((tokenId) => !priceMap.has(tokenId))
      const midpointPrices = await fetchMidpointsForTokenIds(missingAfterCache)
      for (const [tokenId, price] of midpointPrices) {
        priceMap.set(tokenId, { price, source: 'midpoint' })
      }

      const missingAfterMidpoints = tokenIds.filter((tokenId) => !priceMap.has(tokenId))
      const buyPrices = await fetchBuyPricesForTokenIds(missingAfterMidpoints)
      for (const [tokenId, price] of buyPrices) {
        priceMap.set(tokenId, { price, source: 'price' })
      }

      const prices = tokenIds.map((tokenId) => ({
        tokenId,
        price: priceMap.get(tokenId)?.price ?? null,
        source: priceMap.get(tokenId)?.source ?? 'missing',
      }))

      return c.json({ prices, fetchedAt: new Date().toISOString() })
    } catch (err) {
      console.error('[api] Unexpected error in GET /polymarket/live-prices:', err)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })

  // GET /polymarket/book/:tokenId
  // Returns the full orderbook (bids + asks) for a token from CLOB.
  // Used by the trade screen to show depth chart and best bid/ask.
  routes.get('/book/:tokenId', async (c) => {
    const tokenId = c.req.param('tokenId')

    if (!tokenId || tokenId.trim() === '') {
      return c.json({ error: 'Bad request' }, 400)
    }

    try {
      const res = await clobFetch(`book?token_id=${encodeURIComponent(tokenId)}`)
      if (!res.ok) {
        console.error(`[api] CLOB /book error ${res.status} for ${tokenId}`)
        return c.json({ error: 'Failed to fetch orderbook' }, 502)
      }

      const data = await res.json() as Record<string, unknown>
      return c.json(data)
    } catch (err) {
      console.error(`[api] Unexpected error in GET /polymarket/book/${tokenId}:`, err)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })

  // GET /polymarket/trending
  // Returns top active binary markets sorted by weekly volume.
  // ?limit=10 (default 10, max 20) &tag=politics (default politics)
  routes.get('/trending', async (c) => {
    const rawLimit = parseInt(c.req.query('limit') ?? '10', 10)
    const limit = isNaN(rawLimit) || rawLimit < 1 ? 10 : Math.min(rawLimit, 20)
    const tag = (c.req.query('tag') ?? 'geopolitics').trim().toLowerCase()

    try {
      // The old ranked source is gone and Gamma has no equivalent ranking, so
      // this stays empty, as it already was in production.
      const markets: unknown[] = []

      return c.json(markets)
    } catch (err) {
      console.error(`[api] Unexpected error in GET /polymarket/trending:`, err)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })

  // GET /polymarket/markets/:slug/price
  // Lightweight live price poll — use for 30s refresh on detail screens.
  // Response: { slug, yesPrice, noPrice, fetchedAt }
  routes.get('/markets/:slug/price', async (c) => {
    const slug = c.req.param('slug')

    try {
      // Fallback: fetch market from Gamma to get token IDs, then CLOB for prices
      const res = await gammaFetch(`markets?slug=${encodeURIComponent(slug)}`)
      if (!res.ok) throw new Error(`Gamma ${res.status}`)
      const arr = await res.json() as unknown[]
      if (!Array.isArray(arr) || arr.length === 0) throw new Error('not found')

      const market = arr[0] as Record<string, unknown>
      const clobTokenIds = parseStringArray(market.clobTokenIds ?? market.clob_token_ids)

      let yesPrice: number | null = null
      let noPrice: number | null = null

      if (clobTokenIds.length >= 2) {
        const [yRes, nRes] = await Promise.allSettled([
          clobFetch(`price?token_id=${encodeURIComponent(clobTokenIds[0])}&side=buy`),
          clobFetch(`price?token_id=${encodeURIComponent(clobTokenIds[1])}&side=buy`),
        ])
        if (yRes.status === 'fulfilled' && yRes.value.ok) {
          const body = await yRes.value.json() as Record<string, unknown>
          yesPrice = parseNullableNumber(body.price)
        }
        if (nRes.status === 'fulfilled' && nRes.value.ok) {
          const body = await nRes.value.json() as Record<string, unknown>
          noPrice = parseNullableNumber(body.price)
        }
      }
      const prices = { yesPrice, noPrice }

      return c.json({ slug, ...prices, fetchedAt: new Date().toISOString() })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('not found')) return c.json({ error: 'Not found' }, 404)
      console.error(`[api] Unexpected error in GET /polymarket/markets/${slug}/price:`, err)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })

  routes.get('/featured-markets', async (c) => {
    try {
      const events = await gammaFetchCached<Record<string, unknown>[]>(`events?slug=${encodeURIComponent(FEATURED_MARKET_SLUG)}`)
      const e = Array.isArray(events) ? events[0] : null
      const item = e ? mapSingleMatchGammaEventToFeaturedMarket(e) : null

      const items: FeaturedMarket[] = item ? [item] : []

      // Override stale Gamma prices with live CLOB midpoints
      for (const featuredMarket of items) {
        if (featuredMarket.type === 'match' && featuredMarket.outcomes) {
          for (const outcome of featuredMarket.outcomes) {
            const yesTokenId = outcome.clobTokenIds?.[0]
            if (yesTokenId) {
              registerTokenIds([yesTokenId])
              const live = getLivePrice(yesTokenId)
              if (live !== null) outcome.price = live
            }
          }
        }
      }

      const categories = [...new Set(items.map((it) => it.category))]

      return c.json({ items, categories })
    } catch (err) {
      console.error('[api] Unexpected error in GET /polymarket/featured-markets:', err)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })

  return routes
}
