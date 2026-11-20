/**
 * #702 the fixed Backpack -> entity series list for past US macro releases
 * (atlas.event_releases). Pure: no I/O — #703 imports this too.
 *
 * Backpack titles carry the month (`Inflation Rate YoY (Oct)`) and no series
 * key, so this list decides which titles belong to which atlas.entities row.
 * One headline title per entity keeps each entity's history clean. The other
 * titles Backpack sends are variants of the same release time
 * (Inflation Rate MoM, Core Inflation Rate YoY, FOMC Statement/Minutes,
 * Retail Sales Ex Autos MoM, ...): linking them would put duplicate rows in
 * the table, so they deliberately never match.
 */

export interface SeriesMatch {
  entitySlug: string
  period: string | null
}

export interface ReleaseSeries {
  /** Backpack's title with any trailing ` (Xxx)` period removed. */
  title: string
  entitySlug: string
}

export const RELEASE_SERIES: readonly ReleaseSeries[] = [
  { title: 'Inflation Rate YoY', entitySlug: 'us-cpi' },
  { title: 'Producer Price Index MoM', entitySlug: 'us-ppi' },
  { title: 'Non Farm Payrolls', entitySlug: 'us-jobs-report-nfp' },
  { title: 'Fed Interest Rate Decision', entitySlug: 'fomc-rate-decision' },
  { title: 'GDP Growth Rate QoQ', entitySlug: 'us-gdp' },
  { title: 'Retail Sales MoM', entitySlug: 'us-retail-sales' },
]

/** The six slugs, in list order; the run looks these up once by `slug = any($1)`. */
export const RELEASE_ENTITY_SLUGS: readonly string[] = RELEASE_SERIES.map((series) => series.entitySlug)

const PERIOD_CANONICAL = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  'Q1', 'Q2', 'Q3', 'Q4',
]
const PERIOD_BY_LOWER = new Map(PERIOD_CANONICAL.map((period) => [period.toLowerCase(), period]))
// One trailing ` (Xxx)` only; `Xxx` is a month abbreviation or a quarter. Case-
// insensitive so odd upstream casing still strips, but `period` keeps the
// canonical casing the atlas check (`period ~ '^(Jan|...|Dec|Q[1-4])$'`) needs.
const TITLE_WITH_PERIOD = new RegExp(`^(.*) \\((${PERIOD_CANONICAL.join('|')})\\)$`, 'i')

/** Trim, collapse inner whitespace, then strip one trailing ` (Xxx)`. */
export function parseReleaseTitle(title: string): { normalized: string; period: string | null } {
  const cleaned = title.trim().replace(/\s+/g, ' ')
  const match = TITLE_WITH_PERIOD.exec(cleaned)
  if (!match || match[1] === '') return { normalized: cleaned, period: null }
  return { normalized: match[1]!, period: PERIOD_BY_LOWER.get(match[2]!.toLowerCase()) ?? null }
}

const SERIES_BY_TITLE = new Map(
  RELEASE_SERIES.map((series) => [series.title.toLowerCase(), series.entitySlug]),
)

/**
 * Exact, case-insensitive match of a normalised Backpack title against the
 * fixed list; the country must be exactly `US`. No fuzzy or substring
 * matching: `Core Inflation Rate YoY (Oct)` must not match `us-cpi`.
 * Returns null for every other title (the job ignores those events).
 */
export function matchSeries(title: string, country: string | null | undefined): SeriesMatch | null {
  if (country !== 'US') return null
  const { normalized, period } = parseReleaseTitle(title)
  const entitySlug = SERIES_BY_TITLE.get(normalized.toLowerCase())
  return entitySlug ? { entitySlug, period } : null
}
