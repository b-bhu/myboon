import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  PipelineCandidateRow,
  PipelineCandidateThreadUpdate,
  PipelineStore,
  PipelineStoreCandidateStatus,
} from '../pipeline-store/store'
import pinnedSlugs from './pinned.json'
import defaultConfig from './markets-data-engineer-config.json'

const GAMMA_API = 'https://gamma-api.polymarket.com'
const SOURCE = 'polymarket'
const AREA = 'markets'
// Fallback family-key scan limit for findCandidateThreadsByFamilyKey, and the
// backlog family-scan limits below: these preserve the exact scan sizes the
// original direct Supabase queries used (1500 / 1200 / 1200), not the store's
// smaller defaults.
const THREAD_FAMILY_FALLBACK_SCAN_LIMIT = 1500
const BACKLOG_CANDIDATE_FAMILY_SCAN_LIMIT = 1200
const BACKLOG_RESEARCH_FAMILY_SCAN_LIMIT = 1200
const BACKLOG_EDITOR_PENDING_LIMIT = 500
const BACKLOG_PUBLISHED_LIMIT = 500
// Stand-in for "no limit" on slug-scoped backlog lookups whose original
// Supabase queries had no limit at all - see the interface-gap comment at
// each call site in fetchDownstreamBacklog.
const BACKLOG_UNBOUNDED_LOOKUP_LIMIT = 10_000

export type PolymarketMarketCandidateType =
  | 'odds_moved'
  | 'volume_moved'
  | 'activity_spiked'
  | 'closing_soon'

export interface PolymarketMarketsDataEngineerOptions {
  now?: string
  tagSlugs?: string[]
  topMarketsPerTag?: number
  fetchLimitPerTag?: number
  includeManualPins?: boolean
  oddsMoveThreshold?: number
  volumeMoveThresholdPct?: number
  activitySpikeThresholdPct?: number
  closingSoonHours?: number
  candidateCooldownHours?: number
  manualPinMaxSelected?: number
  manualPinMaxRepresentativesPerInput?: number
  manualPinScoreBoost?: number
  candidateRetryFailedHours?: number
  candidateRecentPublishedCooldownHours?: number
  candidateMaterialMoveMultiplier?: number
}

interface GammaTag {
  id: string
  label: string
  slug: string
}

interface GammaEvent {
  id: string
  title?: string
  slug?: string
  active?: boolean
  closed?: boolean
  archived?: boolean
  endDate?: string
  volume?: unknown
  volume24hr?: unknown
  liquidity?: unknown
  liquidityClob?: unknown
  competitive?: unknown
  commentCount?: unknown
  updatedAt?: string
  markets?: GammaMarket[]
}

interface GammaMarket {
  id?: string
  conditionId?: string
  question?: string
  slug?: string
  active?: boolean
  closed?: boolean
  archived?: boolean
  acceptingOrders?: boolean
  endDate?: string
  endDateIso?: string
  volume?: unknown
  volumeNum?: unknown
  volume24hr?: unknown
  liquidity?: unknown
  liquidityNum?: unknown
  liquidityClob?: unknown
  outcomePrices?: unknown
  bestBid?: unknown
  bestAsk?: unknown
  lastTradePrice?: unknown
  oneHourPriceChange?: unknown
  oneDayPriceChange?: unknown
  oneWeekPriceChange?: unknown
  oneMonthPriceChange?: unknown
  updatedAt?: string
}

interface NormalizedMarket {
  marketId: string
  slug: string
  title: string
  tagSlug: string
  tagLabel: string
  eventSlug: string | null
  eventTitle: string | null
  endDate: string | null
  yesPrice: number | null
  noPrice: number | null
  volume: number | null
  volume24h: number | null
  liquidity: number | null
  competitive: number | null
  commentCount: number | null
  lastTradePrice: number | null
  oneHourPriceChange: number | null
  oneDayPriceChange: number | null
  oneWeekPriceChange: number | null
  updatedAt: string | null
  sourceUrl: string
  rawPayload: unknown
  isManualPin: boolean
  watchScore: number
  scoreBreakdown: Record<string, number | string | boolean>
  selectionReason: string
}

interface PreviousMarketState {
  observed_at: string | null
  yes_price: number | string | null
  volume: number | string | null
  volume_24h: number | string | null
}

interface CandidateDraft {
  candidateType: PolymarketMarketCandidateType
  whatChanged: string
  whyFlagged: string
  score: number
  scoreBreakdown: Record<string, number | string | boolean>
  metrics: Record<string, number | string | boolean | null>
  evidenceRefs: Array<Record<string, string | null>>
}

export interface PolymarketMarketsDataEngineerResult {
  observedAt: string
  tags: string[]
  fetchedMarkets: number
  selectedWatchlist: number
  watchlistUpdated: number
  candidatesWritten: number
  candidateThreadsUpdated: number
  candidateThreadsReopened: number
  candidatesSkippedAsDuplicates: number
  candidatesSkippedForBacklog: number
  topWatchlist: Array<{
    slug: string
    tag: string
    title: string
    watchScore: number
    selectionReason: string
  }>
  candidates: Array<{
    slug: string
    candidateType: PolymarketMarketCandidateType
    whatChanged: string
    score: number
  }>
}

export interface PolymarketMarketsDataEngineerPreviewResult {
  observedAt: string
  previewOnly: true
  tags: string[]
  fetchedMarkets: number
  selectedWatchlist: number
  topWatchlist: PolymarketMarketsDataEngineerResult['topWatchlist']
}

function envNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseCsv(value?: string): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value))
}

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function compactMoney(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `$${round(value / 1_000_000, 1)}M`
  if (abs >= 1_000) return `$${round(value / 1_000, 1)}K`
  return `$${round(value, 0)}`
}

function parseOutcomePrices(raw: unknown): number | null {
  let value = raw
  if (typeof raw === 'string' && raw.trim().length > 0) {
    try {
      value = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!Array.isArray(value) || value.length === 0) return null
  const yes = numberOrNull(value[0])
  return yes != null && yes >= 0 && yes <= 1 ? yes : null
}

function marketEndDate(market: GammaMarket, event: GammaEvent): string | null {
  return market.endDate ?? market.endDateIso ?? event.endDate ?? null
}

function isOpenMarket(market: GammaMarket, event: GammaEvent, nowMs: number): boolean {
  if (event.archived || event.closed || market.archived || market.closed) return false
  if (market.active === false || event.active === false) return false
  const endDate = marketEndDate(market, event)
  if (endDate && new Date(endDate).getTime() < nowMs) return false
  return true
}

function isSportsLike(text: string, sportsSlugs: Set<string>): boolean {
  const normalized = text.toLowerCase()
  if ([...sportsSlugs].some((slug) => normalized.includes(slug.replace(/-/g, ' ')))) return true
  return /\b(nfl|nba|nhl|mlb|epl|ucl|ipl|cricket|soccer|football|tennis|f1|formula 1|champions league|premier league)\b/i.test(text)
}

function isNoisyUpDownMarket(text: string): boolean {
  return [
    /updown/i,
    /up or down/i,
    /up\/down/i,
    /\b(up|down)\b.*\b(5m|15m|30m|1h|hour|minute)\b/i,
    /\b(5|15|30)[ -]?minute\b/i,
  ].some((pattern) => pattern.test(text))
}

function marketText(market: NormalizedMarket): string {
  return [market.slug, market.title, market.eventSlug, market.eventTitle, market.tagSlug, market.tagLabel]
    .filter((item): item is string => Boolean(item))
    .join(' ')
}

function activityScore(volume24h: number | null, commentCount: number | null): number {
  const volumePart = Math.min(Math.log10(Math.max(volume24h ?? 0, 0) + 1) / 7, 1) * 18
  const commentPart = Math.min(Math.log10(Math.max(commentCount ?? 0, 0) + 1) / 4, 1) * 7
  return round(volumePart + commentPart, 2)
}

function volatilityScore(market: Pick<NormalizedMarket, 'oneHourPriceChange' | 'oneDayPriceChange' | 'oneWeekPriceChange'>): number {
  const strongest = Math.max(
    Math.abs(market.oneHourPriceChange ?? 0),
    Math.abs(market.oneDayPriceChange ?? 0),
    Math.abs(market.oneWeekPriceChange ?? 0) * 0.5
  )
  return round(Math.min(strongest / 0.1, 1) * 25, 2)
}

function freshnessScore(updatedAt: string | null, nowMs: number): number {
  if (!updatedAt) return 0
  const ageHours = Math.max(0, (nowMs - new Date(updatedAt).getTime()) / 3_600_000)
  return round(clamp(1 - ageHours / 48, 0, 1) * 10, 2)
}

function scoreMarket(
  market: Omit<NormalizedMarket, 'watchScore' | 'scoreBreakdown' | 'selectionReason'>,
  nowMs: number,
  manualPinScoreBoost = defaultConfig.manualPinScoreBoost
): {
  watchScore: number
  scoreBreakdown: Record<string, number | string | boolean>
  selectionReason: string
} {
  const volumeLiquidityScore = round(
    Math.min(Math.log10(Math.max(market.volume24h ?? 0, market.volume ?? 0, 0) + (market.liquidity ?? 0) * 0.5 + 1) / 8, 1) * 35,
    2
  )
  const recentActivityScore = activityScore(market.volume24h, market.commentCount)
  const volScore = volatilityScore(market)
  const freshScore = freshnessScore(market.updatedAt, nowMs)
  const manualPinBonus = market.isManualPin ? manualPinScoreBoost : 0
  const watchScore = round(clamp(volumeLiquidityScore + recentActivityScore + volScore + freshScore + manualPinBonus), 2)

  const reasons = [
    `volume/liquidity ${round(volumeLiquidityScore, 1)}`,
    `activity ${round(recentActivityScore, 1)}`,
    `volatility ${round(volScore, 1)}`,
    market.isManualPin ? 'manual pin' : '',
  ].filter(Boolean)

  return {
    watchScore,
    scoreBreakdown: {
      volumeLiquidityScore,
      recentActivityScore,
      volatilityScore: volScore,
      freshnessScore: freshScore,
      manualPinBonus,
    },
    selectionReason: reasons.join(', '),
  }
}

function normalizeMarket(
  event: GammaEvent,
  market: GammaMarket,
  tag: GammaTag,
  sourceUrl: string,
  nowMs: number,
  isManualPin: boolean,
  manualPinScoreBoost = defaultConfig.manualPinScoreBoost
): NormalizedMarket | null {
  const marketId = market.conditionId ?? market.id
  const slug = market.slug ?? event.slug
  const title = market.question ?? event.title
  if (!marketId || !slug || !title) return null

  const yesPrice = parseOutcomePrices(market.outcomePrices)
    ?? numberOrNull(market.bestAsk)
    ?? numberOrNull(market.lastTradePrice)
  const noPrice = yesPrice != null ? round(1 - yesPrice) : null

  const base = {
    marketId,
    slug,
    title,
    tagSlug: tag.slug,
    tagLabel: tag.label,
    eventSlug: event.slug ?? null,
    eventTitle: event.title ?? null,
    endDate: marketEndDate(market, event),
    yesPrice,
    noPrice,
    volume: numberOrNull(market.volumeNum ?? market.volume ?? event.volume),
    volume24h: numberOrNull(market.volume24hr ?? event.volume24hr),
    liquidity: numberOrNull(market.liquidityNum ?? market.liquidityClob ?? market.liquidity ?? event.liquidityClob ?? event.liquidity),
    competitive: numberOrNull(event.competitive),
    commentCount: numberOrNull(event.commentCount),
    lastTradePrice: numberOrNull(market.lastTradePrice),
    oneHourPriceChange: numberOrNull(market.oneHourPriceChange),
    oneDayPriceChange: numberOrNull(market.oneDayPriceChange),
    oneWeekPriceChange: numberOrNull(market.oneWeekPriceChange),
    updatedAt: market.updatedAt ?? event.updatedAt ?? null,
    sourceUrl,
    rawPayload: { event, market },
    isManualPin,
  }
  const scored = scoreMarket(base, nowMs, manualPinScoreBoost)
  return { ...base, ...scored }
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Polymarket Gamma fetch failed ${res.status}: ${url}`)
  return res.json() as Promise<T>
}

async function tagBySlug(slug: string): Promise<GammaTag> {
  return fetchJson<GammaTag>(`${GAMMA_API}/tags/slug/${encodeURIComponent(slug)}`)
}

async function fetchMarketsForTag(tagSlug: string, options: Required<Pick<PolymarketMarketsDataEngineerOptions, 'fetchLimitPerTag'>>, nowMs: number): Promise<NormalizedMarket[]> {
  const tag = await tagBySlug(tagSlug)
  const url = `${GAMMA_API}/events?tag_slug=${encodeURIComponent(tagSlug)}&active=true&closed=false&limit=${options.fetchLimitPerTag}&order=volume_24hr&ascending=false`
  const events = await fetchJson<GammaEvent[]>(url)
  const markets: NormalizedMarket[] = []
  for (const event of events) {
    for (const market of event.markets ?? []) {
      if (!isOpenMarket(market, event, nowMs)) continue
      const normalized = normalizeMarket(event, market, tag, url, nowMs, false)
      if (normalized) markets.push(normalized)
    }
  }
  return markets
}

function manualRepresentativeScore(market: NormalizedMarket, nowMs: number): {
  score: number
  breakdown: Record<string, number | string | boolean>
} {
  const volumeScore = round(Math.min(Math.log10(Math.max(market.volume24h ?? 0, market.volume ?? 0, 0) + 1) / 8, 1) * 28, 2)
  const liquidityScore = round(Math.min(Math.log10(Math.max(market.liquidity ?? 0, 0) + 1) / 7, 1) * 18, 2)
  const watchScoreComponent = round(market.watchScore * 0.28, 2)
  const movementScore = round(volatilityScore(market) * 0.7, 2)
  let closingRelevanceScore = 0
  if (market.endDate) {
    const hoursToClose = (new Date(market.endDate).getTime() - nowMs) / 3_600_000
    if (hoursToClose > 0 && hoursToClose <= 24 * 14) {
      closingRelevanceScore = round((1 - hoursToClose / (24 * 14)) * 12, 2)
    }
  }

  return {
    score: round(clamp(volumeScore + liquidityScore + watchScoreComponent + movementScore + closingRelevanceScore), 2),
    breakdown: {
      manualRepresentativeVolumeScore: volumeScore,
      manualRepresentativeLiquidityScore: liquidityScore,
      manualRepresentativeWatchScoreComponent: watchScoreComponent,
      manualRepresentativeMovementScore: movementScore,
      manualRepresentativeClosingRelevanceScore: closingRelevanceScore,
    },
  }
}

function selectManualPinRepresentatives(
  pinSlug: string,
  markets: NormalizedMarket[],
  nowMs: number,
  maxRepresentatives: number
): NormalizedMarket[] {
  if (markets.length <= 1) {
    return markets.map((market) => ({
      ...market,
      scoreBreakdown: {
        ...market.scoreBreakdown,
        manualPinInput: pinSlug,
        manualResolvedMarkets: markets.length,
        manualRepresentativeRank: 1,
      },
      selectionReason: `${market.selectionReason}, manual pin single market`,
    }))
  }

  return markets
    .map((market) => {
      const representative = manualRepresentativeScore(market, nowMs)
      return { market, representative }
    })
    .sort((a, b) => b.representative.score - a.representative.score || b.market.watchScore - a.market.watchScore || a.market.slug.localeCompare(b.market.slug))
    .slice(0, Math.max(1, maxRepresentatives))
    .map(({ market, representative }, index) => ({
      ...market,
      scoreBreakdown: {
        ...market.scoreBreakdown,
        ...representative.breakdown,
        manualPinInput: pinSlug,
        manualResolvedMarkets: markets.length,
        manualRepresentativeRank: index + 1,
        manualRepresentativeScore: representative.score,
      },
      selectionReason: `${market.selectionReason}, manual pin representative ${index + 1}/${Math.min(markets.length, Math.max(1, maxRepresentatives))} of ${markets.length}`,
    }))
}

async function fetchManualPin(
  slug: string,
  nowMs: number,
  options: Required<Pick<PolymarketMarketsDataEngineerOptions, 'manualPinMaxRepresentativesPerInput' | 'manualPinScoreBoost'>>
): Promise<NormalizedMarket[]> {
  const tag: GammaTag = { id: 'manual', label: 'Manual Pins', slug: 'manual' }
  const marketUrl = `${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}`
  const marketRows = await fetchJson<GammaMarket[]>(marketUrl).catch(() => [])
  if (marketRows.length > 0) {
    const fakeEvent: GammaEvent = {
      id: marketRows[0].id ?? slug,
      title: marketRows[0].question ?? slug,
      slug,
      active: true,
      closed: false,
      markets: marketRows,
    }
    const markets = marketRows
      .filter((market) => isOpenMarket(market, fakeEvent, nowMs))
      .map((market) => normalizeMarket(fakeEvent, market, tag, marketUrl, nowMs, true, options.manualPinScoreBoost))
      .filter((market): market is NormalizedMarket => market != null)
    return selectManualPinRepresentatives(slug, markets, nowMs, options.manualPinMaxRepresentativesPerInput)
  }

  const eventUrl = `${GAMMA_API}/events?slug=${encodeURIComponent(slug)}&active=true&closed=false&limit=1`
  const eventRows = await fetchJson<GammaEvent[]>(eventUrl).catch(() => [])
  const markets = eventRows.flatMap((event) => (event.markets ?? [])
    .filter((market) => isOpenMarket(market, event, nowMs))
    .map((market) => normalizeMarket(event, market, tag, eventUrl, nowMs, true, options.manualPinScoreBoost))
    .filter((market): market is NormalizedMarket => market != null)
  )
  return selectManualPinRepresentatives(slug, markets, nowMs, options.manualPinMaxRepresentativesPerInput)
}

function selectedOptions(partial: PolymarketMarketsDataEngineerOptions): Required<PolymarketMarketsDataEngineerOptions> {
  const envTags = parseCsv(process.env.POLYMARKET_MARKETS_TAGS)
  return {
    now: partial.now ?? new Date().toISOString(),
    tagSlugs: partial.tagSlugs ?? (envTags.length > 0 ? envTags : defaultConfig.tagSlugs),
    topMarketsPerTag: partial.topMarketsPerTag ?? envNumber('POLYMARKET_MARKETS_TOP_PER_TAG', defaultConfig.topMarketsPerTag),
    fetchLimitPerTag: partial.fetchLimitPerTag ?? envNumber('POLYMARKET_MARKETS_FETCH_LIMIT_PER_TAG', defaultConfig.fetchLimitPerTag),
    includeManualPins: partial.includeManualPins ?? process.env.POLYMARKET_MARKETS_INCLUDE_MANUAL_PINS !== '0',
    oddsMoveThreshold: partial.oddsMoveThreshold ?? envNumber('POLYMARKET_MARKETS_ODDS_MOVE_THRESHOLD', 0.05),
    volumeMoveThresholdPct: partial.volumeMoveThresholdPct ?? envNumber('POLYMARKET_MARKETS_VOLUME_MOVE_THRESHOLD_PCT', 0.2),
    activitySpikeThresholdPct: partial.activitySpikeThresholdPct ?? envNumber('POLYMARKET_MARKETS_ACTIVITY_SPIKE_THRESHOLD_PCT', 0.25),
    closingSoonHours: partial.closingSoonHours ?? envNumber('POLYMARKET_MARKETS_CLOSING_SOON_HOURS', 72),
    candidateCooldownHours: partial.candidateCooldownHours ?? envNumber('POLYMARKET_MARKETS_CANDIDATE_COOLDOWN_HOURS', 6),
    manualPinMaxSelected: partial.manualPinMaxSelected ?? envNumber('POLYMARKET_MARKETS_MANUAL_PIN_MAX_SELECTED', defaultConfig.manualPinMaxSelected),
    manualPinMaxRepresentativesPerInput: partial.manualPinMaxRepresentativesPerInput ?? envNumber('POLYMARKET_MARKETS_MANUAL_PIN_MAX_REPRESENTATIVES_PER_INPUT', defaultConfig.manualPinMaxRepresentativesPerInput),
    manualPinScoreBoost: partial.manualPinScoreBoost ?? envNumber('POLYMARKET_MARKETS_MANUAL_PIN_SCORE_BOOST', defaultConfig.manualPinScoreBoost),
    candidateRetryFailedHours: partial.candidateRetryFailedHours ?? envNumber('POLYMARKET_MARKETS_CANDIDATE_RETRY_FAILED_HOURS', defaultConfig.candidateRetryFailedHours),
    candidateRecentPublishedCooldownHours: partial.candidateRecentPublishedCooldownHours ?? envNumber('POLYMARKET_MARKETS_CANDIDATE_RECENT_PUBLISHED_COOLDOWN_HOURS', defaultConfig.candidateRecentPublishedCooldownHours),
    candidateMaterialMoveMultiplier: partial.candidateMaterialMoveMultiplier ?? envNumber('POLYMARKET_MARKETS_CANDIDATE_MATERIAL_MOVE_MULTIPLIER', defaultConfig.candidateMaterialMoveMultiplier),
  }
}

function filterMarket(market: NormalizedMarket, sportsSlugs: Set<string>): boolean {
  const text = marketText(market)
  if (isSportsLike(text, sportsSlugs)) return false
  if (isNoisyUpDownMarket(text)) return false
  return true
}

function marketKey(market: NormalizedMarket): string {
  return market.slug
}

function titleFamilyKey(text: string): string {
  const stopWords = new Set(['will', 'the', 'and', 'for', 'with', 'before', 'after', 'this', 'that', 'what', 'when', 'who', 'how', 'many'])
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopWords.has(word))
    .slice(0, 8)
    .join('-')
}

function marketFamilyKeys(market: Pick<NormalizedMarket, 'eventSlug' | 'eventTitle' | 'title' | 'slug'>): string[] {
  const keys = new Set<string>()
  if (market.eventSlug) keys.add(`event:${market.eventSlug}`)
  const titleKey = titleFamilyKey(market.eventTitle ?? market.title ?? market.slug)
  if (titleKey) keys.add(`title:${titleKey}`)
  keys.add(`slug:${market.slug}`)
  return [...keys]
}

function primaryMarketFamilyKey(market: Pick<NormalizedMarket, 'title' | 'slug'>): string {
  const titleKey = titleFamilyKey(market.title ?? market.slug)
  return titleKey ? `title:${titleKey}` : `slug:${market.slug}`
}

function marketClusterKey(market: Pick<NormalizedMarket, 'title' | 'slug'>): string {
  return `${SOURCE}:${AREA}:${primaryMarketFamilyKey(market)}`
}

function rowFamilyKeys(row: { slug: string; title: string | null }): string[] {
  const keys = new Set<string>([`slug:${row.slug}`])
  const titleKey = titleFamilyKey(row.title ?? row.slug)
  if (titleKey) keys.add(`title:${titleKey}`)
  return [...keys]
}

function chooseWatchlist(markets: NormalizedMarket[], options: Required<PolymarketMarketsDataEngineerOptions>): NormalizedMarket[] {
  const sportsSlugs = new Set(defaultConfig.sportsTagSlugs)
  const byTag = new Map<string, NormalizedMarket[]>()
  const manual: NormalizedMarket[] = []

  for (const market of markets) {
    if (!filterMarket(market, sportsSlugs)) continue
    if (market.isManualPin) {
      manual.push(market)
      continue
    }
    const group = byTag.get(market.tagSlug) ?? []
    group.push(market)
    byTag.set(market.tagSlug, group)
  }

  const selected: NormalizedMarket[] = manual
    .sort((a, b) => b.watchScore - a.watchScore || a.slug.localeCompare(b.slug))
    .slice(0, Math.max(0, options.manualPinMaxSelected))
    .map((market, index) => ({
      ...market,
      scoreBreakdown: {
        ...market.scoreBreakdown,
        manualPinQuotaRank: index + 1,
        manualPinQuota: options.manualPinMaxSelected,
      },
      selectionReason: `${market.selectionReason}, manual pin quota rank ${index + 1}/${options.manualPinMaxSelected}`,
    }))
  for (const [tag, group] of byTag.entries()) {
    selected.push(...group
      .sort((a, b) => b.watchScore - a.watchScore || a.slug.localeCompare(b.slug))
      .slice(0, options.topMarketsPerTag)
      .map((market, index) => ({
        ...market,
        scoreBreakdown: { ...market.scoreBreakdown, rankInTag: index + 1, selectedTag: tag },
      })))
  }

  const seen = new Map<string, NormalizedMarket>()
  for (const market of selected) {
    const key = marketKey(market)
    const existing = seen.get(key)
    const shouldReplace = !existing
      || market.watchScore > existing.watchScore
      || (market.watchScore === existing.watchScore && market.isManualPin && !existing.isManualPin)
    if (shouldReplace) {
      seen.set(key, {
        ...market,
        scoreBreakdown: {
          ...market.scoreBreakdown,
          ...(existing ? { alsoSeenInTag: existing.tagSlug, alsoSeenAsManualPin: existing.isManualPin } : {}),
        },
      })
    }
  }
  return [...seen.values()].sort((a, b) => b.watchScore - a.watchScore)
}

interface CandidateInsert {
  market: NormalizedMarket
  draft: CandidateDraft
  dedupeKey: string
  familyKey: string
  clusterKey: string
}

interface ExistingCandidateThread {
  id: string
  slug: string
  title: string | null
  status: string
  observed_at: string | null
  score: number | string | null
  metrics: unknown
  research_family_key: string | null
  research_cluster_key: string | null
}

interface CandidateThreadUpdate {
  existing: ExistingCandidateThread
  candidate: CandidateInsert
  payload: Record<string, unknown>
}

async function fetchPreviousWatchlist(store: PipelineStore, slugs: string[]): Promise<Map<string, PreviousMarketState>> {
  const previousBySlug = new Map<string, PreviousMarketState>()
  if (slugs.length === 0) return previousBySlug

  const rows = await store.getWatchlistSnapshots(AREA, slugs)
  for (const row of rows) {
    previousBySlug.set(row.slug, {
      observed_at: row.latestObservedAt,
      yes_price: row.latestYesPrice,
      volume: row.latestVolume,
      volume_24h: row.latestVolume24h,
    })
  }

  return previousBySlug
}

async function upsertWatchlist(store: PipelineStore, watchlist: NormalizedMarket[], observedAt: string): Promise<void> {
  const rankBySlug = new Map(watchlist.map((market, index) => [market.slug, index + 1]))

  await store.upsertWatchlist(watchlist.map((market) => ({
    source: SOURCE,
    area: AREA,
    tagSlug: market.tagSlug,
    tagLabel: market.tagLabel,
    marketId: market.marketId,
    slug: market.slug,
    title: market.title,
    eventSlug: market.eventSlug,
    eventTitle: market.eventTitle,
    endDate: market.endDate,
    isManualPin: market.isManualPin,
    rankInArea: rankBySlug.get(market.slug) ?? null,
    watchScore: market.watchScore,
    scoreBreakdown: market.scoreBreakdown,
    selectionReason: market.selectionReason,
    latestObservedAt: observedAt,
    latestYesPrice: market.yesPrice,
    latestVolume: market.volume,
    latestVolume24h: market.volume24h,
    latestLiquidity: market.liquidity,
    status: 'active',
  })))
}

async function deactivateStaleWatchlist(store: PipelineStore, observedAt: string): Promise<void> {
  // NOTE: the original direct-Supabase implementation deactivated rows where
  // latest_observed_at != observedAt (not-equal). The store's
  // deactivateStaleWatchlist deactivates rows where latest_observed_at is
  // NULL or < observedAt. These are equivalent here because upsertWatchlist
  // always runs first in the same call and stamps every currently-seen
  // market's latest_observed_at with this exact observedAt, so no row can
  // have a latest_observed_at newer than observedAt at this point in the run.
  await store.deactivateStaleWatchlist(AREA, observedAt)
}

function candidateDedupeKey(market: NormalizedMarket, observedAt: string, cooldownHours: number): string {
  const bucket = Math.floor(new Date(observedAt).getTime() / (cooldownHours * 3_600_000))
  const familyKey = primaryMarketFamilyKey(market)
  return `${SOURCE}:${AREA}:${familyKey}:${bucket}`
}

function buildCandidates(
  market: NormalizedMarket,
  previous: PreviousMarketState | null,
  observedAt: string,
  options: Required<PolymarketMarketsDataEngineerOptions>
): CandidateDraft[] {
  const candidates: CandidateDraft[] = []
  const previousYes = numberOrNull(previous?.yes_price)
  const previousVolume = numberOrNull(previous?.volume)
  const previousVolume24h = numberOrNull(previous?.volume_24h)

  if (previousYes != null && market.yesPrice != null) {
    const delta = round(market.yesPrice - previousYes)
    if (Math.abs(delta) >= options.oddsMoveThreshold) {
      candidates.push({
        candidateType: 'odds_moved',
        whatChanged: `${market.title} odds moved from ${round(previousYes * 100, 1)}% to ${round(market.yesPrice * 100, 1)}%.`,
        whyFlagged: `Odds moved ${round(Math.abs(delta) * 100, 1)} points, above the ${round(options.oddsMoveThreshold * 100, 1)} point threshold.`,
        score: round(clamp(market.watchScore * 0.55 + Math.min(Math.abs(delta) / 0.15, 1) * 45), 2),
        scoreBreakdown: { watchScore: market.watchScore, oddsDelta: delta, threshold: options.oddsMoveThreshold },
        metrics: { previousObservedAt: previous?.observed_at ?? null, currentObservedAt: observedAt, previousYes, currentYes: market.yesPrice, oddsDelta: delta },
        evidenceRefs: [{ kind: 'polymarket_market', source_url: market.sourceUrl, observed_at: observedAt }],
      })
    }
  }

  if (previousVolume != null && market.volume != null && previousVolume > 0) {
    const deltaPct = (market.volume - previousVolume) / previousVolume
    if (deltaPct >= options.volumeMoveThresholdPct) {
      candidates.push({
        candidateType: 'volume_moved',
        whatChanged: `${market.title} volume increased from ${compactMoney(previousVolume)} to ${compactMoney(market.volume)}.`,
        whyFlagged: `Volume rose ${round(deltaPct * 100, 1)}%, above the ${round(options.volumeMoveThresholdPct * 100, 1)}% threshold.`,
        score: round(clamp(market.watchScore * 0.55 + Math.min(deltaPct / 0.75, 1) * 45), 2),
        scoreBreakdown: { watchScore: market.watchScore, volumeDeltaPct: round(deltaPct), threshold: options.volumeMoveThresholdPct },
        metrics: { previousObservedAt: previous?.observed_at ?? null, currentObservedAt: observedAt, previousVolume, currentVolume: market.volume, volumeDeltaPct: round(deltaPct) },
        evidenceRefs: [{ kind: 'polymarket_market', source_url: market.sourceUrl, observed_at: observedAt }],
      })
    }
  }

  if (previousVolume24h != null && market.volume24h != null && previousVolume24h > 0) {
    const deltaPct = (market.volume24h - previousVolume24h) / previousVolume24h
    if (deltaPct >= options.activitySpikeThresholdPct) {
      candidates.push({
        candidateType: 'activity_spiked',
        whatChanged: `${market.title} 24h activity increased from ${compactMoney(previousVolume24h)} to ${compactMoney(market.volume24h)}.`,
        whyFlagged: `24h volume rose ${round(deltaPct * 100, 1)}%, above the ${round(options.activitySpikeThresholdPct * 100, 1)}% threshold.`,
        score: round(clamp(market.watchScore * 0.55 + Math.min(deltaPct / 0.75, 1) * 45), 2),
        scoreBreakdown: { watchScore: market.watchScore, activityDeltaPct: round(deltaPct), threshold: options.activitySpikeThresholdPct },
        metrics: { previousObservedAt: previous?.observed_at ?? null, currentObservedAt: observedAt, previousVolume24h, currentVolume24h: market.volume24h, activityDeltaPct: round(deltaPct) },
        evidenceRefs: [{ kind: 'polymarket_market', source_url: market.sourceUrl, observed_at: observedAt }],
      })
    }
  }

  if (market.endDate) {
    const hoursToClose = (new Date(market.endDate).getTime() - new Date(observedAt).getTime()) / 3_600_000
    if (hoursToClose > 0 && hoursToClose <= options.closingSoonHours && (market.volume ?? 0) > 1_000) {
      candidates.push({
        candidateType: 'closing_soon',
        whatChanged: `${market.title} closes in ${round(hoursToClose, 1)} hours.`,
        whyFlagged: `Market is inside the ${options.closingSoonHours}h closing window and has ${compactMoney(market.volume ?? 0)} volume.`,
        score: round(clamp(market.watchScore * 0.65 + (1 - hoursToClose / options.closingSoonHours) * 35), 2),
        scoreBreakdown: { watchScore: market.watchScore, hoursToClose: round(hoursToClose, 2), closingSoonHours: options.closingSoonHours },
        metrics: { currentObservedAt: observedAt, hoursToClose: round(hoursToClose, 2), volume: market.volume, yesPrice: market.yesPrice },
        evidenceRefs: [{ kind: 'polymarket_market', source_url: market.sourceUrl, observed_at: observedAt }],
      })
    }
  }

  return candidates
}

async function fetchExistingCandidateKeys(store: PipelineStore, dedupeKeys: string[]): Promise<Set<string>> {
  if (dedupeKeys.length === 0) return new Set()

  // NOTE (tenancy filter): this lookup is by dedupe_key only, with no
  // source/area filter, even though every sibling query in this file filters
  // on both. That is the PRE-EXISTING behavior (dedupe_key already encodes
  // source+area, see candidateDedupeKey) and is preserved as-is during this
  // migration rather than silently made consistent with the other queries.
  return store.findExistingDedupeKeys(dedupeKeys)
}

type BacklogBlockKind =
  | 'candidate_unresolved'
  | 'research_unresolved'
  | 'editor_pending_publisher'
  | 'recently_published'
  | 'research_failed_recent'
  | 'research_failed_stale'

interface BacklogBlock {
  kind: BacklogBlockKind
  slug: string
  title: string | null
  status: string
  at: string | null
  score?: number | null
}

interface DownstreamBacklog {
  bySlug: Map<string, BacklogBlock[]>
  byFamilyKey: Map<string, BacklogBlock[]>
}

function addBacklogBlock(backlog: DownstreamBacklog, block: BacklogBlock): void {
  const slugBlocks = backlog.bySlug.get(block.slug) ?? []
  slugBlocks.push(block)
  backlog.bySlug.set(block.slug, slugBlocks)

  for (const familyKey of rowFamilyKeys({ slug: block.slug, title: block.title })) {
    const familyBlocks = backlog.byFamilyKey.get(familyKey) ?? []
    familyBlocks.push(block)
    backlog.byFamilyKey.set(familyKey, familyBlocks)
  }
}

function uniqueBacklogBlocks(blocks: BacklogBlock[]): BacklogBlock[] {
  const seen = new Set<string>()
  const out: BacklogBlock[] = []
  for (const block of blocks) {
    const key = `${block.kind}:${block.slug}:${block.status}:${block.at ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(block)
  }
  return out
}

function jsonStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item)).filter(Boolean)
}

function candidateBacklogBlocks(backlog: DownstreamBacklog, market: NormalizedMarket): BacklogBlock[] {
  const blocks = [...(backlog.bySlug.get(market.slug) ?? [])]
  for (const key of marketFamilyKeys(market)) {
    blocks.push(...(backlog.byFamilyKey.get(key) ?? []))
  }
  return uniqueBacklogBlocks(blocks)
}

function candidateMoveRatio(
  draft: CandidateDraft,
  options: Required<PolymarketMarketsDataEngineerOptions>
): number {
  if (draft.candidateType === 'odds_moved') {
    return options.oddsMoveThreshold > 0
      ? Math.abs(numberOrNull(draft.metrics.oddsDelta) ?? 0) / options.oddsMoveThreshold
      : 0
  }
  if (draft.candidateType === 'volume_moved') {
    return options.volumeMoveThresholdPct > 0
      ? (numberOrNull(draft.metrics.volumeDeltaPct) ?? 0) / options.volumeMoveThresholdPct
      : 0
  }
  if (draft.candidateType === 'activity_spiked') {
    return options.activitySpikeThresholdPct > 0
      ? (numberOrNull(draft.metrics.activityDeltaPct) ?? 0) / options.activitySpikeThresholdPct
      : 0
  }
  return 0
}

function isMaterialCandidate(
  draft: CandidateDraft,
  options: Required<PolymarketMarketsDataEngineerOptions>
): boolean {
  return candidateMoveRatio(draft, options) >= options.candidateMaterialMoveMultiplier || draft.score >= 90
}

function blocksCandidate(
  candidate: CandidateInsert,
  blocks: BacklogBlock[],
  observedAt: string,
  options: Required<PolymarketMarketsDataEngineerOptions>
): boolean {
  if (blocks.length === 0) return false
  if (isMaterialCandidate(candidate.draft, options)) return false

  const nowMs = new Date(observedAt).getTime()
  return blocks.some((block) => {
    if (block.kind !== 'research_failed_stale') return true
    if (!block.at) return true
    const ageHours = (nowMs - new Date(block.at).getTime()) / 3_600_000
    return ageHours < options.candidateRetryFailedHours
  })
}

function annotateBacklogOverride(candidate: CandidateInsert, blocks: BacklogBlock[]): CandidateInsert {
  return {
    ...candidate,
    draft: {
      ...candidate.draft,
      scoreBreakdown: {
        ...candidate.draft.scoreBreakdown,
        backlogOverride: true,
        backlogBlockers: blocks.map((block) => `${block.kind}:${block.slug}:${block.status}`).slice(0, 6).join(', '),
      },
    },
  }
}

function dedupeCandidateInserts(candidates: CandidateInsert[]): CandidateInsert[] {
  const byKey = new Map<string, CandidateInsert>()
  for (const candidate of candidates) {
    const existing = byKey.get(candidate.dedupeKey)
    if (!existing || candidate.draft.score > existing.draft.score) {
      byKey.set(candidate.dedupeKey, candidate)
    }
  }
  return [...byKey.values()]
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function observationHistoryEntry(candidate: CandidateInsert, observedAt: string): Record<string, unknown> {
  return {
    observedAt,
    candidateType: candidate.draft.candidateType,
    whatChanged: candidate.draft.whatChanged,
    score: candidate.draft.score,
    metrics: candidate.draft.metrics,
  }
}

function mergedThreadMetrics(
  existing: ExistingCandidateThread,
  candidate: CandidateInsert,
  observedAt: string
): Record<string, unknown> {
  const existingMetrics = objectRecord(existing.metrics)
  const existingThread = objectRecord(existingMetrics.thread)
  const existingHistory = Array.isArray(existingThread.observationHistory)
    ? existingThread.observationHistory.filter((item) => item && typeof item === 'object')
    : []
  const nextHistory = [
    ...existingHistory,
    observationHistoryEntry(candidate, observedAt),
  ].slice(-20)
  const firstObservedAt = typeof existingThread.firstObservedAt === 'string'
    ? existingThread.firstObservedAt
    : existing.observed_at ?? observedAt
  const previousObservationCount = numberOrNull(existingThread.observationCount) ?? existingHistory.length

  return {
    ...candidate.draft.metrics,
    thread: {
      firstObservedAt,
      latestObservedAt: observedAt,
      observationCount: previousObservationCount + 1,
      latestCandidateType: candidate.draft.candidateType,
      latestScore: candidate.draft.score,
      latestWhatChanged: candidate.draft.whatChanged,
      latestWhyFlagged: candidate.draft.whyFlagged,
      previousCandidateId: existing.id,
      previousStatus: existing.status,
      previousScore: numberOrNull(existing.score),
      observationHistory: nextHistory,
    },
  }
}

function statusForThreadUpdate(
  existing: ExistingCandidateThread,
  candidate: CandidateInsert,
  options: Required<PolymarketMarketsDataEngineerOptions>
): string {
  if (existing.status === 'pending_research' || existing.status === 'researching') return existing.status
  return isMaterialCandidate(candidate.draft, options) ? 'pending_research' : existing.status
}

function buildThreadUpdatePayload(
  existing: ExistingCandidateThread,
  candidate: CandidateInsert,
  observedAt: string,
  options: Required<PolymarketMarketsDataEngineerOptions>
): Record<string, unknown> {
  const status = statusForThreadUpdate(existing, candidate, options)
  return {
    candidate_type: candidate.draft.candidateType,
    market_id: candidate.market.marketId,
    slug: candidate.market.slug,
    title: candidate.market.title,
    tag_slug: candidate.market.tagSlug,
    tag_label: candidate.market.tagLabel,
    observed_at: observedAt,
    what_changed: candidate.draft.whatChanged,
    why_flagged: candidate.draft.whyFlagged,
    score: Math.max(candidate.draft.score, numberOrNull(existing.score) ?? 0),
    score_breakdown: {
      ...candidate.draft.scoreBreakdown,
      threadUpdate: true,
      previousStatus: existing.status,
      reopenedForResearch: status === 'pending_research' && existing.status !== 'pending_research',
    },
    metrics: mergedThreadMetrics(existing, candidate, observedAt),
    evidence_refs: candidate.draft.evidenceRefs,
    status,
    updated_at: observedAt,
    research_family_key: candidate.familyKey,
    research_cluster_key: candidate.clusterKey,
    ...(status === 'pending_research'
      ? {
          research_error: null,
          research_next_retry_at: null,
          research_last_error_kind: null,
        }
      : {}),
  }
}

async function fetchResearchRowsByIds(
  store: PipelineStore,
  ids: string[]
): Promise<Array<{ id: string; slug: string; title: string | null; status: string; researched_at: string | null }>> {
  const uniqueIds = [...new Set(ids)]
  const rows = await store.getResearchByIds(uniqueIds)
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: row.status,
    researched_at: row.researchedAt,
  }))
}

function toExistingCandidateThread(row: PipelineCandidateRow): ExistingCandidateThread {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: row.status,
    observed_at: row.observedAt,
    score: row.score,
    metrics: row.metrics,
    research_family_key: row.researchFamilyKey,
    research_cluster_key: row.researchClusterKey,
  }
}

async function fetchExistingCandidateThreads(
  store: PipelineStore,
  familyKeys: string[]
): Promise<Map<string, ExistingCandidateThread>> {
  const byFamily = new Map<string, ExistingCandidateThread>()
  const uniqueFamilyKeys = [...new Set(familyKeys)]
  if (uniqueFamilyKeys.length === 0) return byFamily

  // KNOWN BEHAVIOR GAP (reported, not silently patched): the original code
  // ran a direct match by research_family_key, then ALWAYS ran a fallback
  // scan for whichever specific keys were still unresolved after that direct
  // match, even when other keys in the same call DID match directly.
  // findCandidateThreadsByFamilyKey only runs its fallback scan when the
  // direct match set is empty FOR THE WHOLE CALL (see store.ts doc comment /
  // sqlite-store.ts implementation) - if even one requested key matches
  // directly, no fallback scan runs at all, so any other still-unresolved key
  // in the same call is silently left unresolved instead of being recovered
  // via the recent-scan fallback. This can only change behavior when a
  // multi-key call mixes resolved and unresolved family keys, which in
  // practice differs from the direct-Supabase behavior only in that edge
  // case. Preserve the original 1500-row fallback scan size explicitly,
  // since the store's default (200) is smaller.
  const rows = await store.findCandidateThreadsByFamilyKey(SOURCE, AREA, uniqueFamilyKeys, THREAD_FAMILY_FALLBACK_SCAN_LIMIT)

  const uniqueFamilyKeySet = new Set(uniqueFamilyKeys)
  for (const row of rows) {
    const thread = toExistingCandidateThread(row)
    if (thread.research_family_key && uniqueFamilyKeySet.has(thread.research_family_key) && !byFamily.has(thread.research_family_key)) {
      byFamily.set(thread.research_family_key, thread)
      continue
    }
    // Rows returned only via the fallback scan may not carry one of the
    // requested family keys as their own research_family_key (e.g. a title
    // family key computed from the row's title/slug rather than what's
    // stored). Match on any of the row's derived family keys, same as the
    // original fallback-scan matching logic.
    for (const key of rowFamilyKeys(thread)) {
      if (!uniqueFamilyKeySet.has(key) || byFamily.has(key)) continue
      byFamily.set(key, thread)
    }
  }

  return byFamily
}

async function fetchDownstreamBacklog(
  store: PipelineStore,
  db: SupabaseClient,
  markets: NormalizedMarket[],
  observedAt: string,
  options: Required<PolymarketMarketsDataEngineerOptions>
): Promise<DownstreamBacklog> {
  const backlog: DownstreamBacklog = { bySlug: new Map(), byFamilyKey: new Map() }
  if (markets.length === 0) return backlog

  const slugs = [...new Set(markets.map((market) => market.slug))]
  const watchedFamilyKeys = new Set(markets.flatMap((market) => marketFamilyKeys(market)))
  const failedRetryCutoffMs = new Date(observedAt).getTime() - options.candidateRetryFailedHours * 3_600_000
  const recentPublishedCutoffMs = new Date(observedAt).getTime() - options.candidateRecentPublishedCooldownHours * 3_600_000
  const recentPublishedCutoff = new Date(recentPublishedCutoffMs).toISOString()
  const candidateStatuses: PipelineStoreCandidateStatus[] = [
    'pending_research',
    'researching',
    'researched',
    'skipped_recently_researched',
    'research_failed',
    'published',
  ]

  function addCandidateBacklogBlock(candidate: { slug: string; title: string | null; status: string; observed_at: string | null; score: number | string | null }): void {
    const observedMs = candidate.observed_at ? new Date(candidate.observed_at).getTime() : 0
    if (candidate.status === 'published' && observedMs < recentPublishedCutoffMs) return
    const kind: BacklogBlockKind = candidate.status === 'research_failed' || candidate.status === 'skipped_recently_researched'
      ? (observedMs >= failedRetryCutoffMs ? 'research_failed_recent' : 'research_failed_stale')
      : candidate.status === 'published'
        ? 'recently_published'
        : 'candidate_unresolved'
    addBacklogBlock(backlog, {
      kind,
      slug: candidate.slug,
      title: candidate.title,
      status: candidate.status,
      at: candidate.observed_at,
      score: numberOrNull(candidate.score),
    })
  }

  // Local candidate/research/editor-decision reads move to the store. Only
  // published_narratives (durable, customer-facing output) stays on Supabase.
  //
  // KNOWN INTERFACE GAP (reported, not silently patched): the original
  // Supabase query here had NO limit - it returned every candidate row
  // matching these slugs and statuses. findCandidatesForBacklog requires a
  // mandatory `limit` with no "unbounded" option, so a large fixed cap is
  // used as a stand-in. pipeline_candidates is unique on dedupe_key, not
  // slug, so a single slug can accumulate more than one row across cooldown
  // buckets; if a slug's row count under these statuses ever exceeds this
  // cap, backlog blocks for that slug would be silently dropped where the
  // original unbounded query would have caught them.
  const candidateSlugRows = await store.findCandidatesForBacklog({
    source: SOURCE,
    area: AREA,
    statuses: candidateStatuses,
    slugs,
    limit: BACKLOG_UNBOUNDED_LOOKUP_LIMIT,
  })
  for (const row of candidateSlugRows) {
    addCandidateBacklogBlock({
      slug: row.slug,
      title: row.title,
      status: row.status,
      observed_at: row.observedAt,
      score: row.score,
    })
  }

  const candidateFamilyRows = await store.findCandidatesForBacklog({
    source: SOURCE,
    area: AREA,
    statuses: candidateStatuses,
    limit: BACKLOG_CANDIDATE_FAMILY_SCAN_LIMIT,
  })
  for (const row of candidateFamilyRows) {
    if (!rowFamilyKeys({ slug: row.slug, title: row.title }).some((key) => watchedFamilyKeys.has(key))) continue
    addCandidateBacklogBlock({
      slug: row.slug,
      title: row.title,
      status: row.status,
      observed_at: row.observedAt,
      score: row.score,
    })
  }

  const researchStatuses: Array<'pending_editor' | 'editing' | 'edited' | 'needs_more_research'> = [
    'pending_editor',
    'editing',
    'edited',
    'needs_more_research',
  ]

  // Same unbounded-limit gap as findCandidatesForBacklog above: the original
  // slug-scoped research query had no limit; pipeline_research is unique on
  // candidate_id, so this is safer per-slug in practice, but the cap below is
  // still a stand-in, not a real "no limit" - see the comment above.
  const researchSlugRows = await store.findResearchForBacklog({
    source: SOURCE,
    area: AREA,
    statuses: researchStatuses,
    slugs,
    limit: BACKLOG_UNBOUNDED_LOOKUP_LIMIT,
  })
  for (const row of researchSlugRows) {
    addBacklogBlock(backlog, {
      kind: 'research_unresolved',
      slug: row.slug,
      title: row.title,
      status: row.status,
      at: row.researchedAt,
    })
  }

  const researchFamilyRows = await store.findResearchForBacklog({
    source: SOURCE,
    area: AREA,
    statuses: researchStatuses,
    limit: BACKLOG_RESEARCH_FAMILY_SCAN_LIMIT,
  })
  for (const row of researchFamilyRows) {
    if (!rowFamilyKeys({ slug: row.slug, title: row.title }).some((key) => watchedFamilyKeys.has(key))) continue
    addBacklogBlock(backlog, {
      kind: 'research_unresolved',
      slug: row.slug,
      title: row.title,
      status: row.status,
      at: row.researchedAt,
    })
  }

  const editorRows = await store.findEditorDecisions({
    source: SOURCE,
    area: AREA,
    status: 'pending_publisher',
    orderBy: 'desc',
    limit: BACKLOG_EDITOR_PENDING_LIMIT,
  })
  const editorResearchIds = editorRows.flatMap((row) => row.researchIds)
  const editorResearchRows = await fetchResearchRowsByIds(store, editorResearchIds)
  for (const research of editorResearchRows) {
    if (research.slug && (slugs.includes(research.slug) || rowFamilyKeys(research).some((key) => watchedFamilyKeys.has(key)))) {
      addBacklogBlock(backlog, {
        kind: 'editor_pending_publisher',
        slug: research.slug,
        title: research.title,
        status: 'pending_publisher',
        at: research.researched_at,
      })
    }
  }

  // published_narratives is durable, customer-facing product data and stays
  // on Supabase; this is the one read in this function that must NOT move to
  // the local store.
  const { data: publishedRows, error: publishedError } = await db
    .from('published_narratives')
    .select('research_ids, created_at')
    .eq('source', SOURCE)
    .eq('area', AREA)
    .gte('created_at', recentPublishedCutoff)
    .order('created_at', { ascending: false })
    .limit(BACKLOG_PUBLISHED_LIMIT)

  if (publishedError) throw new Error(`recent published fetch failed: ${publishedError.message}`)
  const publishedResearchIds = (publishedRows ?? []).flatMap((row) => jsonStringArray((row as { research_ids: unknown }).research_ids))
  const publishedResearchRows = await fetchResearchRowsByIds(store, publishedResearchIds)
  for (const research of publishedResearchRows) {
    if (research.slug && (slugs.includes(research.slug) || rowFamilyKeys(research).some((key) => watchedFamilyKeys.has(key)))) {
      addBacklogBlock(backlog, {
        kind: 'recently_published',
        slug: research.slug,
        title: research.title,
        status: 'published',
        at: research.researched_at,
      })
    }
  }

  return backlog
}

async function insertCandidates(
  store: PipelineStore,
  candidates: CandidateInsert[],
  observedAt: string
): Promise<void> {
  if (candidates.length === 0) return

  // KNOWN INTERFACE GAP (reported, not silently patched): the original insert
  // wrote research_family_key/research_cluster_key at insert time in the same
  // write. PipelineCandidateInsertInput has no fields for either, so they
  // cannot be set as part of insertCandidates. This wrapper backfills them
  // immediately afterward with a second store call (updateCandidateThreads),
  // so the end state after insertCandidates() returns still has both fields
  // populated - but there is a brief window (between the two store calls)
  // during which a freshly-inserted row would read back with NULL family/
  // cluster keys, which could not happen with the original single insert.
  const inserted = await store.insertCandidates(candidates.map(({ market, draft, dedupeKey }) => ({
    source: SOURCE,
    area: AREA,
    candidateType: draft.candidateType,
    marketId: market.marketId,
    slug: market.slug,
    title: market.title,
    tagSlug: market.tagSlug,
    tagLabel: market.tagLabel,
    observedAt,
    whatChanged: draft.whatChanged,
    whyFlagged: draft.whyFlagged,
    score: draft.score,
    scoreBreakdown: draft.scoreBreakdown,
    metrics: draft.metrics,
    evidenceRefs: draft.evidenceRefs,
    dedupeKey,
    status: 'pending_research',
  })))

  const byDedupeKey = new Map(candidates.map((candidate) => [candidate.dedupeKey, candidate]))
  const backfillUpdates: PipelineCandidateThreadUpdate[] = []
  for (const row of inserted) {
    const candidate = byDedupeKey.get(row.dedupeKey)
    if (!candidate) continue
    backfillUpdates.push({
      id: row.id,
      payload: {
        researchFamilyKey: candidate.familyKey,
        researchClusterKey: candidate.clusterKey,
      },
    })
  }
  await store.updateCandidateThreads(backfillUpdates)
}

async function updateCandidateThreads(
  store: PipelineStore,
  updates: CandidateThreadUpdate[]
): Promise<void> {
  if (updates.length === 0) return

  // KNOWN INTERFACE GAP (reported, not silently patched): the original update
  // also wrote candidate_type, market_id, slug, title, tag_slug, tag_label,
  // and (when reopening for research) reset research_error,
  // research_next_retry_at, and research_last_error_kind to null.
  // PipelineCandidateThreadUpdate's payload Pick does not include any of
  // those fields, so none of them can be written through this interface.
  // Dropping the identity fields (slug/title/market_id/tag_slug/tag_label/
  // candidate_type) only matters if a market's slug/title changes between
  // observations of the same research family, which is rare. Dropping the
  // research_error/research_next_retry_at/research_last_error_kind reset is
  // more significant: a thread reopened for research from a failed/stale
  // state will keep its previous error message and retry-scheduling fields
  // instead of having them cleared, which could affect
  // fetchRetryableCandidates' retry-due filtering for that row later.
  await store.updateCandidateThreads(updates.map((update) => ({
    id: update.existing.id,
    payload: threadUpdatePayloadForStore(update.payload),
  })))
}

function threadUpdatePayloadForStore(payload: Record<string, unknown>): PipelineCandidateThreadUpdate['payload'] {
  const out: PipelineCandidateThreadUpdate['payload'] = {}
  if (payload.status !== undefined) out.status = payload.status as PipelineStoreCandidateStatus
  if (payload.observed_at !== undefined) out.observedAt = payload.observed_at as string
  if (payload.what_changed !== undefined) out.whatChanged = payload.what_changed as string
  if (payload.why_flagged !== undefined) out.whyFlagged = payload.why_flagged as string
  if (payload.score !== undefined) out.score = payload.score as number
  if (payload.score_breakdown !== undefined) out.scoreBreakdown = payload.score_breakdown
  if (payload.metrics !== undefined) out.metrics = payload.metrics
  if (payload.evidence_refs !== undefined) out.evidenceRefs = payload.evidence_refs
  if (payload.research_family_key !== undefined) out.researchFamilyKey = payload.research_family_key as string
  if (payload.research_cluster_key !== undefined) out.researchClusterKey = payload.research_cluster_key as string
  if (payload.research_depth !== undefined) out.researchDepth = payload.research_depth as PipelineCandidateThreadUpdate['payload']['researchDepth']
  return out
}

export async function runPolymarketMarketsDataEngineer(
  store: PipelineStore,
  db: SupabaseClient,
  partialOptions: PolymarketMarketsDataEngineerOptions = {}
): Promise<PolymarketMarketsDataEngineerResult> {
  const options = selectedOptions(partialOptions)
  const observedAt = options.now
  const nowMs = new Date(observedAt).getTime()

  const byTag = await Promise.all(options.tagSlugs.map((tag) => fetchMarketsForTag(tag, options, nowMs)))
  const manualPins = options.includeManualPins
    ? (await Promise.all([...new Set(pinnedSlugs as string[])].map((slug) => fetchManualPin(slug, nowMs, options)))).flat()
    : []

  const fetchedMarkets = byTag.flat().length + manualPins.length
  const watchlist = chooseWatchlist([...byTag.flat(), ...manualPins], options)

  const previousBySlug = await fetchPreviousWatchlist(store, watchlist.map((market) => market.slug))
  await upsertWatchlist(store, watchlist, observedAt)
  await deactivateStaleWatchlist(store, observedAt)

  const candidateInserts: CandidateInsert[] = []
  for (const market of watchlist) {
    const previous = previousBySlug.get(market.slug) ?? null
    const candidates = buildCandidates(market, previous, observedAt, options)
    for (const candidate of candidates) {
      const dedupeKey = candidateDedupeKey(market, observedAt, options.candidateCooldownHours)
      const familyKey = primaryMarketFamilyKey(market)
      candidateInserts.push({
        market,
        draft: candidate,
        dedupeKey,
        familyKey,
        clusterKey: `${SOURCE}:${AREA}:${familyKey}`,
      })
    }
  }

  const familyDedupedCandidateInserts = dedupeCandidateInserts(candidateInserts)
  const existingCandidateKeys = await fetchExistingCandidateKeys(store, familyDedupedCandidateInserts.map((candidate) => candidate.dedupeKey))
  const existingThreads = await fetchExistingCandidateThreads(store, familyDedupedCandidateInserts.map((candidate) => candidate.familyKey))
  const threadUpdates: CandidateThreadUpdate[] = []
  const insertableCandidateInserts: CandidateInsert[] = []
  for (const candidate of familyDedupedCandidateInserts) {
    const existing = existingThreads.get(candidate.familyKey)
    if (!existing) {
      if (existingCandidateKeys.has(candidate.dedupeKey)) continue
      insertableCandidateInserts.push(candidate)
      continue
    }
    threadUpdates.push({
      existing,
      candidate,
      payload: buildThreadUpdatePayload(existing, candidate, observedAt, options),
    })
  }

  const backlog = await fetchDownstreamBacklog(store, db, insertableCandidateInserts.map((candidate) => candidate.market), observedAt, options)
  const newCandidateInserts: CandidateInsert[] = []
  let candidatesSkippedForBacklog = 0
  for (const candidate of insertableCandidateInserts) {
    const blocks = candidateBacklogBlocks(backlog, candidate.market)
    if (blocksCandidate(candidate, blocks, observedAt, options)) {
      candidatesSkippedForBacklog += 1
      continue
    }
    newCandidateInserts.push(blocks.length > 0 ? annotateBacklogOverride(candidate, blocks) : candidate)
  }
  await updateCandidateThreads(store, threadUpdates)
  await insertCandidates(store, newCandidateInserts, observedAt)

  return {
    observedAt,
    tags: options.tagSlugs,
    fetchedMarkets,
    selectedWatchlist: watchlist.length,
    watchlistUpdated: watchlist.length,
    candidatesWritten: newCandidateInserts.length,
    candidateThreadsUpdated: threadUpdates.length,
    candidateThreadsReopened: threadUpdates.filter((update) => (
      update.payload.status === 'pending_research'
      && update.existing.status !== 'pending_research'
      && update.existing.status !== 'researching'
    )).length,
    candidatesSkippedAsDuplicates: candidateInserts.length - familyDedupedCandidateInserts.length + familyDedupedCandidateInserts.filter((candidate) => existingCandidateKeys.has(candidate.dedupeKey) && !existingThreads.has(candidate.familyKey)).length,
    candidatesSkippedForBacklog,
    topWatchlist: watchlist.slice(0, 12).map((market) => ({
      slug: market.slug,
      tag: market.tagSlug,
      title: market.title,
      watchScore: market.watchScore,
      selectionReason: market.selectionReason,
    })),
    candidates: newCandidateInserts.map(({ market, draft }) => ({
      slug: market.slug,
      candidateType: draft.candidateType,
      whatChanged: draft.whatChanged,
      score: draft.score,
    })),
  }
}

export async function previewPolymarketMarketsDataEngineer(
  partialOptions: PolymarketMarketsDataEngineerOptions = {}
): Promise<PolymarketMarketsDataEngineerPreviewResult> {
  const options = selectedOptions(partialOptions)
  const observedAt = options.now
  const nowMs = new Date(observedAt).getTime()
  const byTag = await Promise.all(options.tagSlugs.map((tag) => fetchMarketsForTag(tag, options, nowMs)))
  const manualPins = options.includeManualPins
    ? (await Promise.all([...new Set(pinnedSlugs as string[])].map((slug) => fetchManualPin(slug, nowMs, options)))).flat()
    : []
  const fetchedMarkets = byTag.flat().length + manualPins.length
  const watchlist = chooseWatchlist([...byTag.flat(), ...manualPins], options)

  return {
    observedAt,
    previewOnly: true,
    tags: options.tagSlugs,
    fetchedMarkets,
    selectedWatchlist: watchlist.length,
    topWatchlist: watchlist.slice(0, 20).map((market) => ({
      slug: market.slug,
      tag: market.tagSlug,
      title: market.title,
      watchScore: market.watchScore,
      selectionReason: market.selectionReason,
    })),
  }
}

export const __testing = {
  blocksCandidate,
  buildThreadUpdatePayload,
  candidateBacklogBlocks,
  candidateDedupeKey,
  chooseWatchlist,
  dedupeCandidateInserts,
  fetchDownstreamBacklog,
  mergedThreadMetrics,
  marketFamilyKeys,
  primaryMarketFamilyKey,
  selectManualPinRepresentatives,
  titleFamilyKey,
}
