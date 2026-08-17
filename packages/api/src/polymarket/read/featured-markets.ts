import {
  parseNullableNumber,
  parseNullableString,
  parseStringArray,
} from './market-read.js'

export const SPORT_SERIES: Record<string, string> = {
  epl: '10188',
  ucl: '10204',
  ipl: '11213',
  fifwc: '11433',
}

// Temporary: featured markets are pinned to a single cricket match during the revamp.
// TODO: replace this pin with the configurable featured-market selection system.
export const FEATURED_MARKET_SLUG = 'crint-zwe2-bgd2-2026-07-15'
/**
 * Featured market — either a binary market (yes/no) or a sport match (multiple outcomes).
 *
 * Binary (type="binary"):
 *   question, yesPrice, noPrice, clobTokenIds[0]=YES / [1]=NO, conditionId
 *
 * Match (type="match"):
 *   title, sport ("epl"|"ucl"|"ipl"|"fifwc"), outcomes[].label/price/clobTokenIds, status, gameStartTime
 *   - EPL/UCL/FIFA World Cup: 3 outcomes (Team A / Team B / Draw)
 *   - IPL: 2 outcomes (Team A / Team B, no draw in cricket)
 */
export interface FeaturedMarket {
  type: 'binary' | 'match'
  slug: string                              // Polymarket market/event slug — unique identifier
  question?: string                         // Binary only: market question text
  title?: string                            // Match only: "Team A vs Team B"
  category: string                          // crypto | politics | sports | tech | macro | entertainment | other
  tags: string[]                            // Category-related tags
  sport?: string                            // Match only: "epl" | "ucl" | "ipl" | "fifwc"
  status?: 'live' | 'upcoming' | 'ended'    // Match only: derived from gameStartTime vs now
  gameStartTime?: string | null             // Match only: actual kickoff time (ISO/UTC)
  yesPrice?: number | null                  // Binary only: YES outcome price (0-1)
  noPrice?: number | null                   // Binary only: NO outcome price (0-1)
  volume: number | null                     // 24h trading volume in USD
  endDate: string | null                    // Market resolution/expiry date
  startDate?: string | null                 // Market creation date (not game start)
  active: boolean | null                    // Market accepting trades
  image: string | null                      // Market/event thumbnail URL
  teams?: FeaturedMarketTeam[]              // Match only: Polymarket team metadata, including crest URLs
  clobTokenIds?: string[]                   // Binary only: [yesTokenId, noTokenId] for CLOB trades
  conditionId?: string | null               // Binary only: Polymarket condition ID for CLOB
  outcomes?: {                              // Match only: one entry per possible outcome
    label: string                           //   Team name or "Draw"
    price: number | null                    //   Outcome price (0-1)
    conditionId?: string | null             //   Condition ID for this outcome's market
    clobTokenIds: string[]                  //   Token IDs for placing trades
  }[]
}

export interface FeaturedMarketTeam {
  name: string
  logo: string | null
  abbreviation: string | null
  alias: string | null
  color: string | null
  ordering: string | null
}

/** Derive match status from multiple signals (Gamma's active/closed flags are buggy for sports).
 *  Priority order:
 *  1. closed flag (if Gamma eventually flips it)
 *  2. UMA oracle status — "proposed" or "resolved" means outcome is decided on-chain
 *  3. Price signal — any outcome ≥0.995 means market is effectively resolved
 *  4. Time elapsed — use format-aware maximum durations (see maxLiveHours)
 *  5. gameStartTime vs now — upcoming / live fallback */
export function deriveMatchStatus(
  gameStartTime: string | null | undefined,
  active: boolean,
  closed: boolean,
  outcomePrices: (number | null)[] = [],
  sport?: string,
  umaResolutionStatus?: string | null,
  nowMs: number = Date.now(),
  slug?: string | null,
): 'live' | 'upcoming' | 'ended' {
  if (closed) return 'ended'
  // UMA oracle: proposed = outcome asserted (2h dispute window), resolved = finalized
  if (umaResolutionStatus === 'proposed' || umaResolutionStatus === 'resolved') return 'ended'
  // Price-based: ≥0.995 means decided (not 0.95 — comebacks happen up to ~0.96)
  if (outcomePrices.some((p) => p !== null && p >= 0.995)) return 'ended'
  if (!gameStartTime) return active ? 'upcoming' : 'ended'
  const start = new Date(gameStartTime).getTime()
  const now = nowMs
  if (now < start) return 'upcoming'
  // Time-based: match can't still be live after max duration
  const hoursElapsed = (now - start) / (1000 * 60 * 60)
  if (hoursElapsed > maxLiveHours(sport, slug)) return 'ended'
  if (active) return 'live'
  return 'ended'
}

// Multi-day formats (Tests, first-class) genuinely run for days; limited-overs
// cricket does not. Since every cricket competition shares the 'cricket' display
// sport, the long window has to be earned by the specific competition rather
// than applied to all of them — otherwise a 3-hour T20 reads as live for six
// days. An explicit set rather than a prefix test: the cric* prefix covers both
// franchise T20 (cricbbl) and first-class (cricwncl, Australia's multi-day
// women's competition), so prefix shape does not predict format.
const MULTI_DAY_CRICKET_CODES = new Set([
  // National boards — Test and first-class fixtures.
  'crint', 'craus', 'creng', 'crind', 'crpak', 'crsou', 'crnew', 'crban', 'cruae',
  // First-class competitions that carry the cric* prefix.
  'cricwncl', 'crwncl',
])
const LIMITED_OVERS_HOURS = 9
const MULTI_DAY_HOURS = 144

function maxLiveHours(sport: string | undefined, slug: string | null | undefined): number {
  if (sport === 'ipl') return 5
  if (sport === 'epl') return 3
  if (sport !== 'cricket') return 4
  const code = (slug ?? '').toLowerCase().split('-')[0]
  return MULTI_DAY_CRICKET_CODES.has(code) ? MULTI_DAY_HOURS : LIMITED_OVERS_HOURS
}

export function mapSingleMatchGammaEventToFeaturedMarket(e: Record<string, unknown>): FeaturedMarket | null {
  return mapGammaEventToFeaturedMarket(e)
}

export function mapGammaEventToFeaturedMarket(
  e: Record<string, unknown>,
  options: {
    category?: string | null
    sport?: string | null
    status?: 'live' | 'upcoming' | 'ended'
    mainMoneylineOnly?: boolean
    now?: number
  } = {},
): FeaturedMarket | null {
  const markets = Array.isArray(e.markets)
    ? e.markets.filter((market): market is Record<string, unknown> => Boolean(market && typeof market === 'object'))
    : []
  const moneylineMarkets = mainSportsMarkets(e, markets)
  const candidates = options.mainMoneylineOnly ? moneylineMarkets : markets
  const mainMarket = candidates.find((m) => m.slug === e.slug) ?? candidates[0]
  if (!mainMarket) return null

  const outcomes = mapSportsOutcomes(mainMarket, moneylineMarkets)
  if (outcomes.length === 0) return null

  const gameStart = String(mainMarket.gameStartTime ?? e.startTime ?? '')
  const isActive = (e.active as boolean) ?? false
  const isClosed = (e.closed as boolean) ?? false
  const umaStatus = (mainMarket.umaResolutionStatus as string) ?? null
  const sport = options.sport ?? 'cricket'
  const category = options.category ?? 'sports'
  const teams = mapSportsTeams(e.teams)

  return {
    type: 'match' as const,
    slug: e.slug as string,
    title: e.title as string,
    category,
    sport,
    tags: [...new Set([category, sport].filter(Boolean))],
    status: options.status ?? deriveMatchStatus(
      gameStart || null,
      isActive,
      isClosed,
      outcomes.map((o) => o.price),
      sport,
      umaStatus,
      options.now,
      e.slug as string,
    ),
    gameStartTime: gameStart || null,
    startDate: (e.startDate as string) ?? null,
    endDate: (e.endDate as string) ?? null,
    image: (e.image as string) ?? null,
    ...(teams.length > 0 ? { teams } : {}),
    active: isActive,
    volume: (e.volume24hr ?? e.volume ?? null) as number | null,
    outcomes,
  }
}

function mapSportsTeams(value: unknown): FeaturedMarketTeam[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((team) => {
    if (!team || typeof team !== 'object') return []
    const row = team as Record<string, unknown>
    const name = parseNullableString(row.name)
    if (!name) return []

    return [{
      name,
      logo: parseNullableString(row.logo),
      abbreviation: parseNullableString(row.abbreviation),
      alias: parseNullableString(row.alias),
      color: parseNullableString(row.color),
      ordering: parseNullableString(row.ordering),
    }]
  })
}

export function getMainSportsMarkets(event: Record<string, unknown>): Record<string, unknown>[] {
  const markets = Array.isArray(event.markets)
    ? event.markets.filter((market): market is Record<string, unknown> => Boolean(market && typeof market === 'object'))
    : []
  return mainSportsMarkets(event, markets)
}

function mainSportsMarkets(
  event: Record<string, unknown>,
  markets: Record<string, unknown>[],
): Record<string, unknown>[] {
  const explicit = markets.filter((market) => market.sportsMarketType === 'moneyline')
  if (explicit.length > 0) return explicit

  const slug = parseNullableString(event.slug) ?? ''
  const title = parseNullableString(event.title) ?? ''
  const groupedBinary = markets.filter((market) => {
    const outcomes = parseStringArray(market.outcomes)
    return Boolean(parseNullableString(market.groupItemTitle))
      && outcomes.length === 2
      && outcomes[0]?.toLowerCase() === 'yes'
      && outcomes[1]?.toLowerCase() === 'no'
  })
  const looksLikeLegacyMatch = /^(?:epl|ucl)-.+-\d{4}-\d{2}-\d{2}$/.test(slug)
    && /\bvs?\.?\b/i.test(title)
    && groupedBinary.length >= 2
    && groupedBinary.length <= 3
    && groupedBinary.length === markets.length
  return looksLikeLegacyMatch ? groupedBinary : []
}

function mapSportsOutcomes(
  mainMarket: Record<string, unknown>,
  moneylineMarkets: Record<string, unknown>[],
): NonNullable<FeaturedMarket['outcomes']> {
  const mainOutcomes = parseStringArray(mainMarket.outcomes)
  const isBinaryMain = mainOutcomes.length === 2
    && mainOutcomes[0]?.toLowerCase() === 'yes'
    && mainOutcomes[1]?.toLowerCase() === 'no'

  if (isBinaryMain && moneylineMarkets.length > 1) {
    return moneylineMarkets.flatMap((market) => {
      const label = parseNullableString(market.groupItemTitle)
      const outcomes = parseStringArray(market.outcomes)
      const yesIndex = outcomes.findIndex((outcome) => outcome.toLowerCase() === 'yes')
      if (!label || yesIndex < 0) return []
      const prices = parseStringArray(market.outcomePrices)
      const tokenIds = parseStringArray(market.clobTokenIds)
      return [{
        label: label.startsWith('Draw') ? 'Draw' : label,
        price: parseNullableNumber(prices[yesIndex]),
        conditionId: parseNullableString(market.conditionId ?? market.condition_id),
        clobTokenIds: tokenIds[yesIndex] ? [tokenIds[yesIndex]] : [],
      }]
    })
  }

  const outcomePrices = parseStringArray(mainMarket.outcomePrices)
  const clobTokenIds = parseStringArray(mainMarket.clobTokenIds)
  return mainOutcomes.map((label, index) => ({
    label,
    price: parseNullableNumber(outcomePrices[index]),
    conditionId: parseNullableString(mainMarket.conditionId ?? mainMarket.condition_id),
    clobTokenIds: clobTokenIds[index] ? [clobTokenIds[index]] : [],
  }))
}

export function mapGammaMarketToFeaturedMarket(
  market: Record<string, unknown>,
  options: { category?: string | null; sport?: string | null } = {},
): FeaturedMarket | null {
  const slug = parseNullableString(market.slug)
  const question = parseNullableString(market.question ?? market.title)
  if (!slug || !question) return null

  const outcomes = parseStringArray(market.outcomes)
  const prices = parseStringArray(market.outcomePrices)
  const tokenIds = parseStringArray(market.clobTokenIds ?? market.clob_token_ids)
  const yesIndex = Math.max(0, outcomes.findIndex((outcome) => outcome.toLowerCase() === 'yes'))
  const noMatch = outcomes.findIndex((outcome) => outcome.toLowerCase() === 'no')
  const noIndex = noMatch >= 0 ? noMatch : 1
  const category = options.category ?? 'other'

  return {
    type: 'binary',
    slug,
    question,
    category,
    sport: options.sport ?? undefined,
    tags: [...new Set([category, options.sport].filter((value): value is string => Boolean(value)))],
    yesPrice: parseNullableNumber(prices[yesIndex]),
    noPrice: parseNullableNumber(prices[noIndex]),
    volume: parseNullableNumber(market.volume24hr ?? market.volume_24h ?? market.volume),
    endDate: parseNullableString(market.endDate ?? market.end_date),
    startDate: parseNullableString(market.startDate ?? market.start_date),
    active: typeof market.active === 'boolean' ? market.active : null,
    image: parseNullableString(market.image ?? market.imageUrl),
    clobTokenIds: tokenIds,
    conditionId: parseNullableString(market.conditionId ?? market.condition_id),
  }
}
