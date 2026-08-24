import {
  gammaFetchCached,
  parseNullableNumber,
  parseNullableString,
  parseStringArray,
} from './market-read.js'

export interface PredictSearchEvent {
  id: string
  slug: string
  /** A concrete market slug that the binary detail endpoint can open. */
  detailSlug: string
  title: string
  image: string | null
  active: boolean | null
  endDate: string | null
  volume24h: number | null
  marketCount: number
  kind: 'sports' | 'prediction'
  outcomes: Array<{ label: string; price: number | null }>
}

export interface PredictSearchTag {
  id: string
  slug: string
  label: string
}

export interface PredictSearchTeam {
  id: string
  name: string
  league: string | null
  logo: string | null
  abbreviation: string | null
  alias: string | null
}

export interface PredictSearchResponse {
  query: string
  page: number
  hasMore: boolean
  events: PredictSearchEvent[]
  tags: PredictSearchTag[]
  teams: PredictSearchTeam[]
}

interface SearchServiceOptions {
  fetchSearch?: (path: string) => Promise<unknown>
  fetchTeams?: (names: string[]) => Promise<unknown>
}

const MAX_RESULTS_PER_TYPE = 20

export class PolymarketSearchService {
  private readonly fetchSearch: NonNullable<SearchServiceOptions['fetchSearch']>
  private readonly fetchTeams: NonNullable<SearchServiceOptions['fetchTeams']>

  constructor(options: SearchServiceOptions = {}) {
    this.fetchSearch = options.fetchSearch ?? ((path) => gammaFetchCached<unknown>(path))
    this.fetchTeams = options.fetchTeams ?? defaultFetchTeams
  }

  async search(query: string, page = 1, limit = 10): Promise<PredictSearchResponse> {
    const normalizedQuery = query.trim().replace(/\s+/g, ' ')
    const safePage = Math.max(1, Math.min(Math.trunc(page) || 1, 100))
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit) || 10, MAX_RESULTS_PER_TYPE))
    const params = new URLSearchParams({
      q: normalizedQuery,
      events_status: 'active',
      limit_per_type: String(safeLimit),
      page: String(safePage),
      keep_closed_markets: '0',
      search_tags: 'true',
      search_profiles: 'false',
      optimized: 'true',
    })

    const searchResult = await this.fetchSearch(`public-search?${params.toString()}`)
    const body = isRecord(searchResult) ? searchResult : {}
    const rawEvents = Array.isArray(body.events) ? body.events : []
    const rawTags = Array.isArray(body.tags) ? body.tags : []
    const teamCandidates = extractMatchingTeamCandidates(rawEvents, normalizedQuery, safeLimit)
    const [teamsResult] = await Promise.allSettled([this.fetchTeams(teamCandidates.names)])
    const rawTeams = teamsResult.status === 'fulfilled' && Array.isArray(teamsResult.value)
      ? teamsResult.value
      : []

    return {
      query: normalizedQuery,
      page: safePage,
      hasMore: body.hasMore === true,
      events: rawEvents
        .flatMap(mapSearchEvent)
        .filter((event) => event.active !== false)
        .slice(0, safeLimit),
      tags: rawTags.flatMap(mapSearchTag).slice(0, safeLimit),
      teams: matchTeams(rawTeams, normalizedQuery, safeLimit, teamCandidates.leaguesByName),
    }
  }
}

function mapSearchEvent(value: unknown): PredictSearchEvent[] {
  if (!isRecord(value) || value.closed === true) return []
  const id = identifier(value.id)
  const slug = parseNullableString(value.slug)
  const title = parseNullableString(value.title)
  if (!id || !slug || !title) return []

  const markets = Array.isArray(value.markets)
    ? value.markets.filter(isRecord)
    : []
  const mainMarket = markets.find((market) => market.slug === slug) ?? markets[0]
  const labels = parseStringArray(mainMarket?.outcomes)
  const prices = parseStringArray(mainMarket?.outcomePrices)
  const sports = markets.some((market) => parseNullableString(market.sportsMarketType) !== null)
    || /^(?:epl|ucl|cric|crint|ipl|nba|nfl|nhl|mlb|wnba|f1)-/.test(slug)
  const marketVolume = markets.reduce((sum, market) => (
    sum + (parseNullableNumber(market.volume24hr ?? market.volume24h) ?? 0)
  ), 0)

  return [{
    id,
    slug,
    detailSlug: parseNullableString(mainMarket?.slug) ?? slug,
    title,
    image: parseNullableString(value.image ?? value.icon),
    active: typeof value.active === 'boolean' ? value.active : null,
    endDate: parseNullableString(value.endDate ?? mainMarket?.endDate),
    volume24h: parseNullableNumber(value.volume24hr ?? value.volume24h) ?? (marketVolume > 0 ? marketVolume : null),
    marketCount: markets.length,
    kind: sports ? 'sports' : 'prediction',
    outcomes: labels.slice(0, 4).map((label, index) => ({
      label,
      price: parseNullableNumber(prices[index]),
    })),
  }]
}

function mapSearchTag(value: unknown): PredictSearchTag[] {
  if (!isRecord(value)) return []
  const id = identifier(value.id)
  const slug = parseNullableString(value.slug)
  const label = parseNullableString(value.label)
  return id && slug && label ? [{ id, slug, label }] : []
}

function matchTeams(
  values: unknown[],
  query: string,
  limit: number,
  leaguesByName: Map<string, Set<string>>,
): PredictSearchTeam[] {
  const needle = query.toLowerCase()
  const seen = new Set<string>()
  const matches = values.flatMap((value): PredictSearchTeam[] => {
    if (!isRecord(value)) return []
    const id = identifier(value.id)
    const name = parseNullableString(value.name)
    if (!id || !name) return []
    const league = parseNullableString(value.league)
    const abbreviation = parseNullableString(value.abbreviation)
    const alias = parseNullableString(value.alias)
    const leagueHints = leaguesByName.get(name.toLowerCase())
    if (leagueHints?.size && (!league || !leagueHints.has(league.toLowerCase()))) return []
    const haystack = [name, league, abbreviation, alias].filter(Boolean).join(' ').toLowerCase()
    if (!haystack.includes(needle)) return []
    if (seen.has(id)) return []
    seen.add(id)
    return [{
      id,
      name,
      league,
      logo: parseNullableString(value.logo),
      abbreviation,
      alias,
    }]
  })

  return matches
    .sort((a, b) => teamMatchRank(a, needle) - teamMatchRank(b, needle) || a.name.localeCompare(b.name))
    .slice(0, limit)
}

function teamMatchRank(team: PredictSearchTeam, needle: string): number {
  const name = team.name.toLowerCase()
  const alias = team.alias?.toLowerCase()
  const abbreviation = team.abbreviation?.toLowerCase()
  if (name === needle || alias === needle || abbreviation === needle) return 0
  if (name.startsWith(needle) || alias?.startsWith(needle)) return 1
  return 2
}

function extractMatchingTeamCandidates(
  events: unknown[],
  query: string,
  limit: number,
): { names: string[]; leaguesByName: Map<string, Set<string>> } {
  const needle = query.toLowerCase()
  const names = new Set<string>()
  const leaguesByName = new Map<string, Set<string>>()
  for (const event of events) {
    if (!isRecord(event) || !Array.isArray(event.markets)) continue
    const slug = parseNullableString(event.slug) ?? ''
    const leagueHint = sportsLeagueHint(slug)
    for (const market of event.markets) {
      if (!isRecord(market)) continue
      const name = parseNullableString(market.groupItemTitle)
      if (!name || /^draw\b/i.test(name) || !name.toLowerCase().includes(needle)) continue
      names.add(name)
      if (leagueHint) {
        const key = name.toLowerCase()
        const hints = leaguesByName.get(key) ?? new Set<string>()
        hints.add(leagueHint)
        leaguesByName.set(key, hints)
      }
      if (names.size >= limit) return { names: [...names], leaguesByName }
    }
  }
  return { names: [...names], leaguesByName }
}

async function defaultFetchTeams(names: string[]): Promise<unknown[]> {
  if (names.length === 0) return []
  const results = await Promise.allSettled(names.map((name) => (
    gammaFetchCached<unknown[]>(`teams?name=${encodeURIComponent(name)}&limit=100`)
  )))
  return results.flatMap((result) => (
    result.status === 'fulfilled' && Array.isArray(result.value) ? result.value : []
  ))
}

function sportsLeagueHint(slug: string): string | null {
  const prefix = slug.toLowerCase().split('-')[0] ?? ''
  return /^(?:epl|ucl|uel|efl|lal|bun|sea|lig|mls|nba|wnba|nfl|nhl|mlb|ipl|cr[a-z]+)$/.test(prefix)
    ? prefix
    : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function identifier(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  return null
}
