import {
  fetchMidpointsForTokenIds,
  gammaFetchCached,
  registerTokenIds,
} from './market-read.js'
import {
  type UpDownAsset,
  type UpDownCurrentPrice,
  type UpDownDuration,
  type UpDownPriceHistory,
  type UpDownReferencePrice,
  type UpDownRoundIdentity,
  UpDownPriceService,
} from './updown-prices.js'

/**
 * Polymarket's durable series identifiers. Event titles and publication dates
 * are not round clocks; each selected market's eventStartTime/endDate is.
 */
export const UP_DOWN_SERIES: Record<UpDownAsset, Record<UpDownDuration, string>> = {
  btc: { hourly: '10114', daily: '41' },
  eth: { hourly: '10117', daily: '40' },
}

export interface UpDownRound extends UpDownRoundIdentity {
  question: string
  active: boolean | null
  closed: boolean
  volume24h: number | null
  /** Higher chance from the Higher/Up token midpoint. */
  upPrice: number | null
  /** Lower chance from the Lower/Down token midpoint. */
  downPrice: number | null
  /** Ordered [Higher, Lower] regardless of Gamma's source array order. */
  clobTokenIds: string[]
  conditionId: string | null
  resolutionSource: string | null
  rules: string | null
  priceToBeat: number | null
  priceToBeatSource: UpDownReferencePrice | null
  currentPrice: number | null
  currentPriceSource: UpDownCurrentPrice | null
}

export interface UpDownRoundsResponse {
  btc: { hourly: UpDownRound | null; daily: UpDownRound | null }
  eth: { hourly: UpDownRound | null; daily: UpDownRound | null }
}

export interface UpDownHistoryResponse extends UpDownPriceHistory {
  asset: UpDownAsset
  duration: UpDownDuration
  slug: string
  startDate: string
  endDate: string
  priceToBeat: number | null
  currentPrice: number | null
}

export interface UpDownReadService {
  getRounds(): Promise<UpDownRoundsResponse>
  getHistory(asset: UpDownAsset, duration: UpDownDuration): Promise<UpDownHistoryResponse | null>
}

interface GammaEvent {
  slug?: unknown
  title?: unknown
  startDate?: unknown
  endDate?: unknown
  active?: unknown
  closed?: unknown
  volume24hr?: unknown
  markets?: GammaMarket[]
}

interface GammaMarket {
  question?: unknown
  description?: unknown
  startDate?: unknown
  eventStartTime?: unknown
  endDate?: unknown
  active?: unknown
  closed?: unknown
  acceptingOrders?: unknown
  volume24hr?: unknown
  outcomes?: unknown
  outcomePrices?: unknown
  clobTokenIds?: unknown
  conditionId?: unknown
  resolutionSource?: unknown
}

interface UpDownServiceOptions {
  fetchSeries?: (seriesId: string) => Promise<unknown[] | null>
  fetchMidpoints?: (tokenIds: string[]) => Promise<Map<string, number>>
  priceService?: Pick<UpDownPriceService, 'getReferencePrice' | 'getCurrentPrice' | 'getHistory'>
  now?: () => number
  cacheTtlMs?: number
}

const DEFAULT_CACHE_TTL_MS = 10_000

export class PolymarketUpDownService implements UpDownReadService {
  private readonly fetchSeries: NonNullable<UpDownServiceOptions['fetchSeries']>
  private readonly fetchMidpoints: NonNullable<UpDownServiceOptions['fetchMidpoints']>
  private readonly priceService: NonNullable<UpDownServiceOptions['priceService']>
  private readonly now: NonNullable<UpDownServiceOptions['now']>
  private readonly cacheTtlMs: number
  private cached: { value: UpDownRoundsResponse; expiresAt: number } | null = null

  constructor(options: UpDownServiceOptions = {}) {
    this.fetchSeries = options.fetchSeries ?? defaultFetchSeries
    this.fetchMidpoints = options.fetchMidpoints ?? fetchMidpointsForTokenIds
    this.priceService = options.priceService ?? new UpDownPriceService()
    this.now = options.now ?? Date.now
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  }

  async getRounds(): Promise<UpDownRoundsResponse> {
    const now = this.now()
    if (this.cached && this.cached.expiresAt > now) return this.cached.value

    const result = emptyRounds()
    const series = Object.entries(UP_DOWN_SERIES).flatMap(([asset, durations]) => (
      Object.entries(durations).map(([duration, seriesId]) => ({
        asset: asset as UpDownAsset,
        duration: duration as UpDownDuration,
        seriesId,
      }))
    ))

    await Promise.all(series.map(async ({ asset, duration, seriesId }) => {
      try {
        const events = await this.fetchSeries(seriesId)
        if (!Array.isArray(events)) return
        const rounds = events.flatMap((event) => {
          const mapped = mapRoundEvent(event, asset, duration)
          return mapped ? [mapped] : []
        })
        result[asset][duration] = selectCurrentRound(rounds, now)
      } catch (error) {
        console.warn(`[api] Gamma Up/Down series ${seriesId} unavailable:`, error instanceof Error ? error.message : error)
      }
    }))

    const activeRounds = flattenRounds(result)
    await this.applyLiveOutcomePrices(activeRounds)
    await this.applyUnderlyingPrices(activeRounds)
    this.cached = { value: result, expiresAt: now + this.cacheTtlMs }
    return result
  }

  async getHistory(asset: UpDownAsset, duration: UpDownDuration): Promise<UpDownHistoryResponse | null> {
    const rounds = await this.getRounds()
    const round = rounds[asset][duration]
    if (!round) return null
    const history = await this.priceService.getHistory(round, this.now())
    return {
      ...history,
      asset,
      duration,
      slug: round.slug,
      startDate: round.startDate,
      endDate: round.endDate,
      priceToBeat: round.priceToBeat,
      currentPrice: round.currentPrice,
    }
  }

  private async applyLiveOutcomePrices(rounds: UpDownRound[]): Promise<void> {
    const tokenIds = [...new Set(rounds.flatMap((round) => round.clobTokenIds))]
    if (tokenIds.length === 0) return
    for (const tokenId of tokenIds) registerTokenIds([tokenId])
    try {
      const prices = await this.fetchMidpoints(tokenIds)
      for (const round of rounds) {
        const up = round.clobTokenIds[0] ? prices.get(round.clobTokenIds[0]) : undefined
        const down = round.clobTokenIds[1] ? prices.get(round.clobTokenIds[1]) : undefined
        if (up !== undefined) round.upPrice = up
        if (down !== undefined) round.downPrice = down
      }
    } catch (error) {
      console.warn('[api] CLOB Up/Down midpoint refresh unavailable:', error instanceof Error ? error.message : error)
    }
  }

  private async applyUnderlyingPrices(rounds: UpDownRound[]): Promise<void> {
    const currentEntries = await Promise.all((['btc', 'eth'] as const).map(async (asset) => (
      [asset, await this.priceService.getCurrentPrice(asset)] as const
    )))
    const currentPrices = new Map(currentEntries)

    await Promise.all(rounds.map(async (round) => {
      const [reference] = await Promise.all([
        this.priceService.getReferencePrice(round),
      ])
      const current = currentPrices.get(round.asset) ?? null
      round.priceToBeat = reference?.value ?? null
      round.priceToBeatSource = reference
      round.currentPrice = current?.value ?? null
      round.currentPriceSource = current
    }))
  }
}

export function classifyUpDownSlug(slug: string): { asset: UpDownAsset; duration: UpDownDuration } | null {
  const value = slug.toLowerCase()
  const asset = value.startsWith('bitcoin') || value.startsWith('btc-updown')
    ? 'btc'
    : value.startsWith('ethereum') || value.startsWith('eth-updown')
      ? 'eth'
      : null
  if (!asset) return null
  const duration = /-\d{1,2}(?::\d{2})?(am|pm)(?:-|$)/.test(value) || /-1h-/.test(value)
    ? 'hourly'
    : 'daily'
  return { asset, duration }
}

/** Compatibility export for existing callers. */
const defaultUpDownService = new PolymarketUpDownService()

export async function fetchUpDownRounds(): Promise<UpDownRoundsResponse> {
  return defaultUpDownService.getRounds()
}

function mapRoundEvent(
  value: unknown,
  asset: UpDownAsset,
  duration: UpDownDuration,
): UpDownRound | null {
  if (!value || typeof value !== 'object') return null
  const event = value as GammaEvent
  const slug = stringValue(event.slug)
  if (!slug || event.closed === true) return null
  const market = Array.isArray(event.markets)
    ? event.markets.find((candidate) => candidate && typeof candidate === 'object')
    : null
  if (!market || market.closed === true || market.acceptingOrders === false) return null

  const startDate = stringValue(market.eventStartTime)
  const endDate = stringValue(market.endDate) ?? stringValue(event.endDate)
  if (!startDate || !endDate || !Number.isFinite(Date.parse(startDate)) || !Number.isFinite(Date.parse(endDate))) {
    return null
  }

  const labels = parseStringArrayField(market.outcomes)
  const prices = parseStringArrayField(market.outcomePrices)
  const tokens = parseStringArrayField(market.clobTokenIds)
  const upIndex = findOutcomeIndex(labels, /^(up|higher|yes)$/i, 0)
  const downIndex = findOutcomeIndex(labels, /^(down|lower|no)$/i, 1)

  return {
    slug,
    asset,
    duration,
    question: stringValue(event.title) ?? stringValue(market.question) ?? slug,
    startDate,
    endDate,
    active: typeof market.active === 'boolean'
      ? market.active
      : typeof event.active === 'boolean'
        ? event.active
        : null,
    closed: market.closed === true || event.closed === true,
    volume24h: numberValue(event.volume24hr) ?? numberValue(market.volume24hr),
    upPrice: numberValue(prices[upIndex]),
    downPrice: numberValue(prices[downIndex]),
    clobTokenIds: [tokens[upIndex], tokens[downIndex]].filter((token): token is string => Boolean(token)),
    conditionId: stringValue(market.conditionId),
    resolutionSource: stringValue(market.resolutionSource),
    rules: stringValue(market.description),
    priceToBeat: null,
    priceToBeatSource: null,
    currentPrice: null,
    currentPriceSource: null,
  }
}

function selectCurrentRound(rounds: UpDownRound[], now: number): UpDownRound | null {
  return rounds
    .filter((round) => Date.parse(round.startDate) <= now && now < Date.parse(round.endDate))
    .sort((a, b) => Date.parse(b.startDate) - Date.parse(a.startDate))[0] ?? null
}

async function defaultFetchSeries(seriesId: string): Promise<unknown[] | null> {
  return gammaFetchCached<unknown[]>(
    `events?series_id=${seriesId}&active=true&closed=false&limit=50&order=endDate&ascending=true`,
  )
}

function emptyRounds(): UpDownRoundsResponse {
  return {
    btc: { hourly: null, daily: null },
    eth: { hourly: null, daily: null },
  }
}

function flattenRounds(rounds: UpDownRoundsResponse): UpDownRound[] {
  return [
    rounds.btc.hourly,
    rounds.btc.daily,
    rounds.eth.hourly,
    rounds.eth.daily,
  ].filter((round): round is UpDownRound => round !== null)
}

function findOutcomeIndex(labels: string[], pattern: RegExp, fallback: number): number {
  const index = labels.findIndex((label) => pattern.test(label))
  return index >= 0 ? index : fallback
}

function parseStringArrayField(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(parsed) ? parsed : null
}
