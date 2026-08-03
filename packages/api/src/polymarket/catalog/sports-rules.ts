import type { FeaturedMarket } from '../read/featured-markets.js'
import { getMainSportsMarkets, mapGammaEventToFeaturedMarket } from '../read/featured-markets.js'
import { gammaFetch, gammaFetchCached } from '../read/market-read.js'
import type { PolymarketCatalogItem } from './contracts.js'
import { PolymarketCatalogValidationError } from './contracts.js'

const LIVE_LOOKBACK_DAYS = 7
const DISCOVERY_PAGE_SIZE = 100
const MAX_DISCOVERY_PAGES = 3
// Tag discovery spans every league under a tag, so it sweeps deeper than a
// single series. Gamma does apply start_time_min/max to tag queries, which keeps
// this bounded — cricket's full window fits in two pages today.
const MAX_TAG_DISCOVERY_PAGES = 6

interface SportsMetadata {
  sport: string
  series: string
}

export interface SportsRuleOption {
  sportCode: string
  currentSeriesId: string
  label: string
  image: string | null
}

interface SeriesMetadata {
  id: string
  title: string
  slug: string
}

export interface ResolvedSportsRule {
  sportCode: string
  seriesId: string
  seriesSlug: string
  title: string
  displaySport: string
}

export async function resolveSportsRuleForSave(sportCode: string): Promise<ResolvedSportsRule> {
  const sports = await fetchGammaJson<unknown>('sports')
  const metadata = findSportsMetadata(sports, sportCode)
  if (!metadata) {
    throw new PolymarketCatalogValidationError(
      `Polymarket does not recognize the automatic sports code “${sportCode}”.`,
    )
  }

  const series = await fetchGammaJson<unknown>(`series/${encodeURIComponent(metadata.series)}`)
  const resolvedSeries = parseSeriesMetadata(series)
  if (!resolvedSeries) {
    throw new PolymarketCatalogValidationError(
      `Polymarket could not resolve the current series for “${sportCode}”.`,
    )
  }

  return {
    sportCode,
    seriesId: resolvedSeries.id,
    seriesSlug: resolvedSeries.slug,
    title: resolvedSeries.title,
    displaySport: displaySportForCode(sportCode),
  }
}

export async function listSportsRuleOptions(): Promise<SportsRuleOption[]> {
  const rows = await gammaFetchCached<unknown>('sports')
  if (!Array.isArray(rows)) throw new Error('Polymarket sports metadata is unavailable')

  const options = rows.flatMap((row) => {
    if (!isRecord(row)) return []
    const sportCode = stringValue(row.sport)?.toLowerCase()
    const currentSeriesId = stringValue(row.series)
    if (!sportCode || !currentSeriesId) return []
    const resolutionHost = hostLabel(stringValue(row.resolution))
    return [{
      sportCode,
      currentSeriesId,
      label: resolutionHost ? `${sportCode.toUpperCase()} · ${resolutionHost}` : sportCode.toUpperCase(),
      image: stringValue(row.image),
    }]
  })

  return [...new Map(options.map((option) => [option.sportCode, option])).values()]
    .sort((left, right) => left.sportCode.localeCompare(right.sportCode))
}

/** Tags an operator may expand into every league beneath them. */
export const SPORTS_TAG_OPTIONS: SportsTagOption[] = [
  { tagId: '517', slug: 'cricket', label: 'Cricket — all leagues' },
]

export interface SportsTagOption {
  tagId: string
  slug: string
  label: string
}

export function findSportsTagOption(value: string): SportsTagOption | null {
  const needle = value.trim().toLowerCase()
  return SPORTS_TAG_OPTIONS.find(
    (option) => option.slug === needle || option.tagId === needle,
  ) ?? null
}

export function resolveSportsTagForSave(slug: string): SportsTagOption {
  const option = findSportsTagOption(slug)
  if (!option) {
    throw new PolymarketCatalogValidationError(
      `“${slug}” is not a supported automatic sports tag.`,
    )
  }
  return option
}

/**
 * Expand a tag into every eligible main-moneyline fixture beneath it, across all
 * of that tag's leagues. Unlike a sports_rule this needs no series resolution —
 * new competitions appear as soon as Polymarket tags them.
 */
export async function discoverSportsTagMarkets(
  item: PolymarketCatalogItem,
  nowMs: number,
): Promise<FeaturedMarket[]> {
  const tagId = item.ruleConfig?.tagId ?? item.sourceId
  if (!item.ruleConfig || !tagId) return []

  const from = new Date(nowMs - LIVE_LOOKBACK_DAYS * 86_400_000).toISOString()
  const until = new Date(nowMs + item.ruleConfig.windowDays * 86_400_000).toISOString()
  const events: Record<string, unknown>[] = []

  for (let page = 0; page < MAX_TAG_DISCOVERY_PAGES; page += 1) {
    const params = new URLSearchParams({
      tag_id: tagId,
      active: 'true',
      closed: 'false',
      start_time_min: from,
      start_time_max: until,
      limit: String(DISCOVERY_PAGE_SIZE),
      offset: String(page * DISCOVERY_PAGE_SIZE),
      order: 'startTime',
      ascending: 'true',
    })
    const rows = await gammaFetchCached<unknown>(`events?${params.toString()}`)
    if (!Array.isArray(rows)) break
    const pageEvents = rows.filter(isRecord)
    events.push(...pageEvents)
    if (pageEvents.length < DISCOVERY_PAGE_SIZE) break
  }

  return events
    // A tag spans many leagues, so there is no single series slug to match on.
    .filter((event) => isEligibleMainGame(event, null, nowMs, item.ruleConfig!.windowDays))
    .map((event) => mapGammaEventToFeaturedMarket(event, {
      category: item.category,
      sport: item.sport,
      mainMoneylineOnly: true,
      now: nowMs,
    }))
    .filter((market): market is FeaturedMarket => market !== null)
    .filter((market) => market.status === 'live' || market.status === 'upcoming')
    .sort(compareDiscoveredMarkets)
}

export async function discoverSportsRuleMarkets(
  item: PolymarketCatalogItem,
  nowMs: number,
): Promise<FeaturedMarket[]> {
  if (!item.ruleConfig) return []

  const current = await resolveSportsRuleForRead(item)
  const seriesId = current?.seriesId ?? item.sourceId
  const seriesSlug = current?.seriesSlug ?? stringValue(item.displayOverrides.resolvedSeriesSlug)
  if (!seriesId) {
    throw new Error(`No current series metadata for automatic sports source ${item.sourceSlug}`)
  }

  const from = new Date(nowMs - LIVE_LOOKBACK_DAYS * 86_400_000).toISOString()
  const until = new Date(nowMs + item.ruleConfig.windowDays * 86_400_000).toISOString()
  const events: Record<string, unknown>[] = []

  for (let page = 0; page < MAX_DISCOVERY_PAGES; page += 1) {
    const params = new URLSearchParams({
      series_id: seriesId,
      active: 'true',
      closed: 'false',
      start_time_min: from,
      start_time_max: until,
      limit: String(DISCOVERY_PAGE_SIZE),
      offset: String(page * DISCOVERY_PAGE_SIZE),
      order: 'startTime',
      ascending: 'true',
    })
    const rows = await gammaFetchCached<unknown>(`events?${params.toString()}`)
    if (!Array.isArray(rows)) break
    const pageEvents = rows.filter(isRecord)
    events.push(...pageEvents)
    if (pageEvents.length < DISCOVERY_PAGE_SIZE) break
  }

  return events
    .filter((event) => isEligibleMainGame(event, seriesSlug, nowMs, item.ruleConfig!.windowDays))
    .map((event) => mapGammaEventToFeaturedMarket(event, {
        category: item.category,
        sport: item.sport,
        mainMoneylineOnly: true,
        now: nowMs,
      }))
    .filter((market): market is FeaturedMarket => market !== null)
    .filter((market) => market.status === 'live' || market.status === 'upcoming')
    .sort(compareDiscoveredMarkets)
}

export async function resolveSportsRuleForReadCode(sportCode: string): Promise<ResolvedSportsRule | null> {
  const sports = await gammaFetchCached<unknown>('sports')
  const metadata = findSportsMetadata(sports, sportCode)
  if (!metadata) return null
  const series = await gammaFetchCached<unknown>(`series/${encodeURIComponent(metadata.series)}`)
  const resolvedSeries = parseSeriesMetadata(series)
  if (!resolvedSeries) return null
  return {
    sportCode,
    seriesId: resolvedSeries.id,
    seriesSlug: resolvedSeries.slug,
    title: resolvedSeries.title,
    displaySport: displaySportForCode(sportCode),
  }
}

async function resolveSportsRuleForRead(item: PolymarketCatalogItem): Promise<ResolvedSportsRule | null> {
  const resolved = await resolveSportsRuleForReadCode(item.sourceSlug)
  return resolved ? { ...resolved, displaySport: item.sport ?? resolved.displaySport } : null
}

async function fetchGammaJson<T>(path: string): Promise<T> {
  const response = await gammaFetch(path)
  if (!response.ok) {
    throw new PolymarketCatalogValidationError('Polymarket sports metadata is temporarily unavailable.')
  }
  return response.json() as Promise<T>
}

function findSportsMetadata(value: unknown, sportCode: string): SportsMetadata | null {
  if (!Array.isArray(value)) return null
  const normalizedCode = sportCode.toLowerCase()
  for (const row of value) {
    if (!isRecord(row)) continue
    const sport = stringValue(row.sport)
    const series = stringValue(row.series)
    if (sport?.toLowerCase() === normalizedCode && series) return { sport, series }
  }
  return null
}

function parseSeriesMetadata(value: unknown): SeriesMetadata | null {
  const row = Array.isArray(value) ? value[0] : value
  if (!isRecord(row)) return null
  const id = stringValue(row.id)
  const title = stringValue(row.title)
  const slug = stringValue(row.slug)
  return id && title && slug ? { id, title, slug } : null
}

function isEligibleMainGame(
  event: Record<string, unknown>,
  seriesSlug: string | null,
  nowMs: number,
  windowDays: number,
): boolean {
  if ((seriesSlug && event.seriesSlug !== seriesSlug)
    || event.closed === true
    || event.archived === true
    || event.ended === true) {
    return false
  }
  const start = eventStartTime(event)
  if (start === null) return false
  if (start < nowMs - LIVE_LOOKBACK_DAYS * 86_400_000) return false
  if (start > nowMs + windowDays * 86_400_000) return false

  return getMainSportsMarkets(event).some((market) => (
    market.active !== false
    && market.closed !== true
    && market.acceptingOrders !== false
  ))
}

function eventStartTime(event: Record<string, unknown>): number | null {
  const direct = stringValue(event.startTime)
  const markets = Array.isArray(event.markets) ? event.markets.filter(isRecord) : []
  const fromMarket = markets.map((market) => stringValue(market.gameStartTime)).find(Boolean) ?? null
  const parsed = Date.parse(direct ?? fromMarket ?? '')
  return Number.isFinite(parsed) ? parsed : null
}

function compareDiscoveredMarkets(left: FeaturedMarket, right: FeaturedMarket): number {
  const leftLive = left.status === 'live' ? 0 : 1
  const rightLive = right.status === 'live' ? 0 : 1
  if (leftLive !== rightLive) return leftLive - rightLive
  const startDifference = Date.parse(left.gameStartTime ?? '') - Date.parse(right.gameStartTime ?? '')
  if (Number.isFinite(startDifference) && startDifference !== 0) return startDifference
  return left.slug.localeCompare(right.slug)
}

function displaySportForCode(sportCode: string): string {
  return sportCode.toLowerCase().startsWith('cr') ? 'cricket' : sportCode.toLowerCase()
}

function hostLabel(value: string | null): string | null {
  if (!value) return null
  try {
    return new URL(value).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
