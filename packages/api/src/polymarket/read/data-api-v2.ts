/**
 * Polymarket read reader over the Data API v2 held positions (#745).
 *
 * The phone gets the same rows through the SDK's `client.listPositions`
 * (cursor-paginated GET /v2/positions); the server cannot use the signed
 * client, so this reader hits the public by-address endpoint with plain
 * fetch and zod-parses the answer (wire shape checked live on Nov 27, 2026:
 * envelope `{ data, pagination: { has_more, next_cursor } }`, snake_case
 * rows). `@polymarket/client` stays a devDependency and is deliberately not
 * imported here.
 *
 * The walk covers both held statuses (Open and Redeemable) with the shared
 * `walkAllPages` ceiling (#445), merges them exactly like the phone's
 * fetchPortfolio (redeemable held rows repeat across both pages), and
 * returns the same totals the shared helpers produce. `walkAllPages`'s
 * partial flag is intentionally not surfaced: the wallet-summary
 * PolymarketSummary type has no field for it, and the phone renders such
 * lower-bound totals unchanged too.
 */
import { z } from 'zod'
import {
  HELD_POSITIONS_PAGE_CEILING,
  mapSdkPosition,
  mergeHeldPositions,
  summarizeHeldPositions,
  sumReadyToCollect,
  walkAllPages,
  type SdkPosition,
} from '@myboon/shared/wallet-summary'

export const DATA_API_V2_HOST = 'https://data-api.polymarket.com'

// The phone's SDK paginates /v2/positions by cursor with 500-row pages
// (live check: limit=500 accepted); the shared walkAllPages caps the walk
// at 20 pages per status, so the request volume stays bounded either way.
const PAGE_SIZE = 500

/**
 * The wire row for the fields the shared helpers consume. Numeric USD
 * fields stay `unknown` on purpose — mapSdkPosition runs them through
 * toNumber, which accepts decimal strings and numbers alike (the same
 * tolerance the phone's SDK-parsed positions have). Missing optional
 * display fields map to the shared defaults (empty string / null / 0).
 */
const dataApiV2PositionSchema = z.object({
  proxy_wallet: z.string(),
  token_id: z.string(),
  condition_id: z.string(),
  current_size: z.unknown(),
  avg_price: z.unknown(),
  current_value: z.unknown(),
  unrealized_pnl: z.unknown(),
  percent_pnl: z.unknown(),
  current_price: z.unknown(),
  title: z.string().nullish(),
  slug: z.string().nullish(),
  event_slug: z.string().nullish(),
  outcome: z.string().nullish(),
  outcome_index: z.unknown().optional(),
  icon: z.string().nullish(),
  end_date: z.string().nullish(),
  negative_risk: z.boolean(),
})

const dataApiV2PositionsPageSchema = z.object({
  data: z.array(dataApiV2PositionSchema),
  pagination: z.object({
    has_more: z.boolean(),
    next_cursor: z.string().nullable(),
  }),
})

/** Map one wire row onto the shared SdkPosition shape (one definition). */
function toSdkPosition(row: z.infer<typeof dataApiV2PositionSchema>): SdkPosition {
  return {
    wallet: row.proxy_wallet,
    assetId: row.token_id,
    conditionId: row.condition_id,
    currentSize: row.current_size,
    avgPrice: row.avg_price,
    currentValue: row.current_value,
    unrealizedPnl: row.unrealized_pnl,
    percentPnl: row.percent_pnl,
    currentPrice: row.current_price,
    title: row.title ?? null,
    slug: row.slug ?? null,
    eventSlug: row.event_slug ?? null,
    outcome: row.outcome ?? null,
    outcomeIndex: row.outcome_index,
    icon: row.icon ?? null,
    endDate: row.end_date ?? null,
    negativeRisk: row.negative_risk,
  }
}

export interface DataApiV2Deps {
  /** Injected fetch for tests; production uses global fetch. */
  fetch?: typeof fetch
  host?: string
  pageSize?: number
  signal?: AbortSignal
}

/**
 * One status's cursor walk over /v2/positions. Each yield is one HTTP page;
 * the last consumed page's `has_more` (SDK parity: `has_more` plus a
 * non-null `next_cursor`) decides whether the walk continues — walkAllPages
 * never requests the page beyond its ceiling.
 */
async function* dataApiV2Pages(
  user: string,
  status: 'open' | 'redeemable',
  deps: DataApiV2Deps,
): AsyncIterable<{ items: SdkPosition[]; hasMore: boolean }> {
  const host = deps.host ?? DATA_API_V2_HOST
  const pageSize = deps.pageSize ?? PAGE_SIZE
  const doFetch = deps.fetch ?? globalThis.fetch
  let cursor: string | null = null
  while (true) {
    const url = new URL('/v2/positions', host)
    url.searchParams.set('user', user)
    url.searchParams.set('status', status)
    url.searchParams.set('limit', String(pageSize))
    if (cursor !== null) url.searchParams.set('cursor', cursor)
    const response = await doFetch(url, { signal: deps.signal })
    if (!response.ok) throw new Error(`data-api HTTP ${response.status}`)
    const page = dataApiV2PositionsPageSchema.parse(await response.json())
    const hasMore = page.pagination.has_more && page.pagination.next_cursor !== null
    yield { items: page.data.map(toSdkPosition), hasMore }
    if (!hasMore) return
    cursor = page.pagination.next_cursor
  }
}

/** The held-position totals one account serves from Data API v2. */
export interface DataApiV2Sums {
  /** Sum of current_value over the merged (deduped) held positions. */
  openPositionsValueUsd: number
  /** Sum of collectible redeemable value, rows under $0.01 excluded. */
  readyToCollectUsd: number
  /** Sum of unrealized P&L over the merged held positions. */
  totalPnlUsd: number
  /** Held position count after the open/redeemable dedupe. */
  openPositionCount: number
}

/**
 * List and summarise one account's held positions (#745): Open and
 * Redeemable walks under the shared 20-page ceiling per status, merged and
 * deduped by assetId, mapped and summarised by the shared helpers the phone
 * uses — one definition of the screen's positions value, P&L, count and
 * ready-to-collect. Throws when a page fetch or a page parse fails (the
 * venue maps that to this app's `unavailable`); rows under $0.01 never
 * count toward readyToCollectUsd (threshold lives in sumReadyToCollect).
 */
export async function dataApiV2List(
  user: string,
  deps: DataApiV2Deps = {},
): Promise<DataApiV2Sums> {
  const [openWalk, redeemableWalk] = await Promise.all([
    walkAllPages(dataApiV2Pages(user, 'open', deps), HELD_POSITIONS_PAGE_CEILING),
    walkAllPages(dataApiV2Pages(user, 'redeemable', deps), HELD_POSITIONS_PAGE_CEILING),
  ])
  const merged = mergeHeldPositions(openWalk.items, redeemableWalk.items).map(mapSdkPosition)
  const summary = summarizeHeldPositions(merged, openWalk.partial || redeemableWalk.partial)
  return {
    openPositionsValueUsd: summary.cashOutNow,
    readyToCollectUsd: sumReadyToCollect(redeemableWalk.items.map(mapSdkPosition)),
    totalPnlUsd: summary.totalPnl,
    openPositionCount: summary.openPositions,
  }
}
