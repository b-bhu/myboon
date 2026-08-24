import { gammaFetch } from './market-read.js'

/**
 * One Tap Up/Down round supply (Predict redesign PRD §2).
 *
 * Maps Polymarket's existing hourly/daily BTC/ETH up-or-down event series on
 * Gamma. Slugs are deterministic:
 *   daily:  bitcoin-up-or-down-on-august-24  / ethereum-up-or-down-…
 *   hourly: bitcoin-up-or-down-august-24-3pm-et
 * Each event carries one Yes/No market whose outcome prices are the Up/Down
 * chances; Binance BTC/USDT is the named resolution source (per PRD Q1 spike,
 * commit a199c82). This service composes round-shaped responses from those
 * events — it invents nothing: fields the API doesn't return stay null.
 */

const GAMMA_SERIES_TITLES = [
  'bitcoin-up-or-down',
  'ethereum-up-or-down',
]

export interface UpDownRound {
  /** Round slug (the Gamma event slug). */
  slug: string
  asset: 'btc' | 'eth'
  /** 'hourly' = 1h round, 'daily' = 1d round (the only durations with upstream supply). */
  duration: 'hourly' | 'daily'
  question: string
  startDate: string | null
  endDate: string | null
  active: boolean | null
  closed: boolean
  volume24h: number | null
  /** Up chance 0–1 from the YES token price; null when unknown. */
  upPrice: number | null
  downPrice: number | null
  clobTokenIds: string[]
  conditionId: string | null
}

export interface UpDownRoundsResponse {
  btc: { hourly: UpDownRound | null; daily: UpDownRound | null }
  eth: { hourly: UpDownRound | null; daily: UpDownRound | null }
}

interface GammaEvent {
  slug?: unknown
  title?: unknown
  description?: unknown
  startDate?: unknown
  endDate?: unknown
  active?: unknown
  closed?: unknown
  volume24hr?: unknown
  markets?: GammaMarket[]
}

interface GammaMarket {
  slug?: unknown
  question?: unknown
  outcomes?: unknown
  outcomePrices?: unknown
  clobTokenIds?: unknown
  conditionId?: unknown
}

function isGammaEvent(value: unknown): value is GammaEvent {
  return !!value && typeof value === 'object'
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function parseStringArrayField(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string')
    } catch { /* not JSON */ }
  }
  return []
}

/** Classify an up-or-down event slug into asset + duration. */
export function classifyUpDownSlug(slug: string): { asset: 'btc' | 'eth'; duration: 'hourly' | 'daily' } | null {
  const s = slug.toLowerCase()
  // Hourly slugs carry a time component ("...-3pm-et"); daily ones end at the date.
  const isHourly = /-\d{1,2}(am|pm)(-et)?$/.test(s)
  const asset = s.startsWith('bitcoin') ? 'btc' : s.startsWith('ethereum') ? 'eth' : null
  if (!asset) return null
  return { asset, duration: isHourly ? 'hourly' : 'daily' }
}

function mapRoundEvent(event: GammaEvent): UpDownRound | null {
  const slug = str(event.slug)
  if (!slug) return null
  const classification = classifyUpDownSlug(slug)
  if (!classification) return null

  const markets = Array.isArray(event.markets) ? event.markets : []
  // The up/down event has exactly one market: outcomes [Up, Down] (or [Yes, No]).
  const market: GammaMarket = markets[0] ?? {}
  const labels = parseStringArrayField(market.outcomes)
  const prices = parseStringArrayField(market.outcomePrices)
  const tokens = parseStringArrayField(market.clobTokenIds)

  const upIdx = Math.max(0, labels.findIndex((l) => /^(up|yes)$/i.test(l)))
  const downMatch = labels.findIndex((l) => /^(down|no)$/i.test(l))
  const downIdx = downMatch >= 0 ? downMatch : 1

  return {
    slug,
    asset: classification.asset,
    duration: classification.duration,
    question: str(event.title) ?? str(market.question) ?? slug,
    startDate: str(event.startDate),
    endDate: str(event.endDate),
    active: typeof event.active === 'boolean' ? event.active : null,
    closed: event.closed === true,
    volume24h: num(event.volume24hr),
    upPrice: num(prices[upIdx]),
    downPrice: num(prices[downIdx]),
    clobTokenIds: tokens,
    conditionId: str((market as Record<string, unknown>).conditionId),
  }
}

/**
 * Fetch current up/down rounds for all four series (BTC/ETH × 1h/1d).
 *
 * Uses Gamma's title search per series prefix rather than constructing exact
 * dated slugs client-side — the server's clock shouldn't guess ET dates. We
 * pull recent events per series and keep the open one per bucket.
 */
export async function fetchUpDownRounds(): Promise<UpDownRoundsResponse> {
  const result: UpDownRoundsResponse = {
    btc: { hourly: null, daily: null },
    eth: { hourly: null, daily: null },
  }

  await Promise.all(GAMMA_SERIES_TITLES.map(async (series) => {
    try {
      const res = await gammaFetch(
        `events?title=${encodeURIComponent(series)}&closed=false&limit=20&order=endDate&ascending=true`,
      )
      if (!res.ok) return
      const events = await res.json() as unknown[]
      if (!Array.isArray(events)) return
      for (const raw of events) {
        if (!isGammaEvent(raw)) continue
        const round = mapRoundEvent(raw)
        if (!round || round.closed) continue
        const bucket = result[round.asset]
        // Keep the earliest still-open round per duration (= the current one).
        if (round.duration === 'hourly' && !bucket.hourly) bucket.hourly = round
        if (round.duration === 'daily' && !bucket.daily) bucket.daily = round
      }
    } catch {
      // One series failing leaves its buckets null — the client renders
      // "unavailable" honestly instead of guessing.
    }
  }))

  return result
}
