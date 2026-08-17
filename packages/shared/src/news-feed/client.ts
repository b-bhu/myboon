/**
 * tokens.xyz news feed — the one place we call `GET /v1/news/feed`.
 *
 * The upstream blends two genuinely different things into a single array and
 * tells them apart only by a `feed_source` string:
 *
 *   feed_source 'coingecko' -> a published press article. Has an outlet
 *                              (`source_name`), sometimes an author, and a URL
 *                              that points at that outlet.
 *   feed_source 'x'         -> a post from the @tokens account. `source_name`
 *                              is the handle, the "title" is the whole post
 *                              body, and the URL is the status permalink.
 *
 * We normalize them into separate types at this boundary because they are not
 * interchangeable: an article is third-party reporting, a post is one
 * company's timeline. `fetchFeed()` keeps both in upstream ranking order;
 * `fetchArticles()` and `fetchPosts()` remain available when a caller needs
 * only one half.
 *
 * WHAT THIS SERVICE DOES NOT DO
 * It does not cache, store, dedupe against history, or decide what is
 * interesting. It fetches, normalizes, and returns. Dedupe and research live
 * in the collectors.
 *
 * NO HISTORY — POLLING CADENCE IS CORRECTNESS, NOT TUNING
 * The upstream serves a live window only. Measured 2026-08-13: `limit=50`
 * with `source=news` spanned about 40 minutes of wall-clock news. There is no
 * cursor, no page, no `since`. Unknown query params are accepted and silently
 * ignored (`page`, `offset`, `before`, `from`, `days` and `cursor` all return
 * byte-identical first items), so a caller cannot tell a working param from a
 * dropped one — do not add paging params and assume they took effect.
 * Anything published while nobody was polling is unrecoverable from this API.
 * A caller polling slower than its window loses items in between, silently.
 * See NEWS_FEED_MAX_LIMIT and the cadence note on each fetch function.
 */

import type {
  NewsFeedArticle,
  NewsFeedItem,
  NewsFeedResult,
  NewsFeedPost,
  NewsFeedFetchOptions,
} from './types.js'

export type {
  NewsFeedArticle,
  NewsFeedItem,
  NewsFeedMeta,
  NewsFeedResult,
  NewsFeedFetchOptions,
  NewsFeedPost,
} from './types.js'

function newsFeedUrl(): string {
  const base = (process.env.NEWS_FEED_API_BASE || process.env.TOKENS_API_BASE || 'https://api.tokens.xyz').replace(/\/+$/, '')
  return base.endsWith('/v1') ? `${base}/news/feed` : `${base}/v1/news/feed`
}

/**
 * Upstream clamps `limit` to 1..50 rather than erroring, so asking for more is
 * silently answered with 50. We clamp on our side too, so a caller that asks
 * for 200 gets a truthful 50 back instead of believing it received 200.
 */
export const NEWS_FEED_MAX_LIMIT = 50

/** Upstream default when `limit` is omitted. Ours is explicit; see fetchers. */
const NEWS_FEED_DEFAULT_LIMIT = 10

/** Network attempts per call: one try plus this many retries. */
const MAX_RETRIES = 2

/** Backoff base. Doubles per attempt: 300ms, 600ms. */
const RETRY_BASE_DELAY_MS = 300

/** A slow upstream must not wedge a collector process forever. */
const REQUEST_TIMEOUT_MS = 10_000

/** The raw item shape as it comes off the wire. Never leaves this module. */
interface UpstreamFeedItem {
  title?: unknown
  url?: unknown
  image?: unknown
  author?: unknown
  posted_at?: unknown
  type?: unknown
  source_name?: unknown
  related_coin_ids?: unknown
  feed_source?: unknown
}

interface UpstreamFeedResponse {
  items?: unknown
  meta?: {
    mode?: unknown
    source?: unknown
    coin_id?: unknown
    terms?: unknown
    limit?: unknown
    tweet_reserve?: unknown
    counts?: {
      items?: unknown
      coingecko_candidates?: unknown
      x_candidates?: unknown
    }
  }
}

/**
 * Thrown for anything that made the call unusable: missing key, non-2xx,
 * malformed body, timeout. Carries `status` when the upstream answered, so a
 * caller can tell "they rejected us" (401/403 — bad key or scope) from "they
 * are having a bad day" (5xx) without parsing message strings.
 */
export class NewsFeedError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'NewsFeedError'
    this.status = status
  }
}

/**
 * Fail loudly rather than returning an empty feed. An empty array is a
 * legitimate answer from this API (a token-mode query can genuinely match
 * nothing), so a missing key must not be able to masquerade as one — a
 * collector would record "no news today" and move on.
 */
function requireApiKey(explicit?: string): string {
  const key = (explicit ?? process.env.NEWS_FEED_API_KEY ?? process.env.TOKENS_API_KEY ?? '').trim()
  if (!key) {
    throw new NewsFeedError(
      'NEWS_FEED_API_KEY is not set — refusing to call the configured news feed ' +
        'without it (an unauthenticated call would look like an empty feed)',
    )
  }
  return key
}

function clampLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return NEWS_FEED_DEFAULT_LIMIT
  const whole = Math.floor(limit)
  if (whole < 1) return 1
  if (whole > NEWS_FEED_MAX_LIMIT) return NEWS_FEED_MAX_LIMIT
  return whole
}

/**
 * Build the query string.
 *
 * Only params the upstream actually implements are sent. Everything the
 * upstream treats as a token filter — `coin_id`, `symbol`, `name`, `asset_id`,
 * `terms`, `term` — is merged server-side into one deduped term list, and
 * passing ANY of them flips the response from `mode: 'global'` to
 * `mode: 'token'`. `coin_id` is the only one that filters the CoinGecko half
 * upstream; the rest filter the X half locally on their end.
 */
function buildQuery(
  source: 'all' | 'news' | 'tweets',
  options: NewsFeedFetchOptions,
): URLSearchParams {
  const params = new URLSearchParams({
    source,
    limit: String(clampLimit(options.limit)),
  })

  if (options.coinId?.trim()) params.set('coin_id', options.coinId.trim())
  if (options.symbol?.trim()) params.set('symbol', options.symbol.trim())
  if (options.name?.trim()) params.set('name', options.name.trim())
  if (options.assetId?.trim()) params.set('asset_id', options.assetId.trim())

  const terms = (options.terms ?? [])
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
  if (terms.length > 0) params.set('terms', terms.join(','))

  return params
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readOptionalString(value: unknown): string | null {
  const text = readString(value)
  return text.length > 0 ? text : null
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Keep only items we can actually act on. An item with no title or no URL is
 * not a usable signal — there is nothing to fingerprint and nothing to open —
 * so it is dropped here rather than pushed downstream as a half-record.
 */
function hasUsableCore(item: UpstreamFeedItem): boolean {
  return readString(item.title).length > 0 && readString(item.url).length > 0
}

/**
 * `posted_at` arrives in two shapes depending on which half produced the item
 * ('2026-08-13T00:44:00Z' from CoinGecko, '2026-08-12T22:55:16.000Z' from X).
 * Both parse; we normalize to a single ISO form so downstream comparisons and
 * fingerprints do not have to care which half an item came from. An
 * unparseable value becomes null rather than a fabricated timestamp.
 */
function normalizePostedAt(value: unknown): string | null {
  const raw = readString(value)
  if (!raw) return null
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString()
}

function normalizeArticle(item: UpstreamFeedItem): NewsFeedArticle {
  return {
    kind: 'article',
    title: readString(item.title),
    url: readString(item.url),
    publishedAt: normalizePostedAt(item.posted_at),
    outlet: readOptionalString(item.source_name),
    author: readOptionalString(item.author),
    imageUrl: readOptionalString(item.image),
    relatedCoinIds: readStringArray(item.related_coin_ids),
  }
}

function normalizePost(item: UpstreamFeedItem): NewsFeedPost {
  const handle = readOptionalString(item.source_name)
  return {
    kind: 'post',
    text: readString(item.title),
    url: readString(item.url),
    postedAt: normalizePostedAt(item.posted_at),
    // `author` is the bare username ('tokens'); `source_name` is the display
    // handle ('@tokens'). Prefer the handle, fall back to the username.
    handle: handle ?? readOptionalString(item.author),
    imageUrl: readOptionalString(item.image),
    relatedCoinIds: readStringArray(item.related_coin_ids),
  }
}

function parseMeta(body: UpstreamFeedResponse): NewsFeedResult<never>['meta'] {
  const meta = isRecord(body.meta) ? body.meta : {}
  const counts = isRecord(meta.counts) ? meta.counts : {}
  return {
    mode: readString(meta.mode) === 'token' ? 'token' : 'global',
    terms: readStringArray(meta.terms),
    limit: readNumber(meta.limit),
    coingeckoCandidates: readNumber(counts.coingecko_candidates),
    xCandidates: readNumber(counts.x_candidates),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A 4xx is our fault (bad key, bad scope, bad params) and will fail the same
 * way every time — retrying just burns the collector's budget. A 5xx or a
 * network error might be transient, so those get another attempt.
 */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429
}

async function requestFeed(
  source: 'all' | 'news' | 'tweets',
  options: NewsFeedFetchOptions,
): Promise<UpstreamFeedResponse> {
  const apiKey = requireApiKey(options.apiKey)
  const url = `${newsFeedUrl()}?${buildQuery(source, options).toString()}`
  const fetchImpl = options.fetchImpl ?? fetch

  let lastError: unknown = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1))

    try {
      const response = await fetchImpl(url, {
        headers: {
          Accept: 'application/json',
          'x-api-key': apiKey,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })

      if (!response.ok) {
        const error = new NewsFeedError(
          `tokens.xyz news feed responded ${response.status}`,
          response.status,
        )
        if (!isRetryableStatus(response.status)) throw error
        lastError = error
        continue
      }

      const body = (await response.json()) as unknown
      if (!isRecord(body)) {
        throw new NewsFeedError('news feed returned a non-object body')
      }
      return body as UpstreamFeedResponse
    } catch (error) {
      // A non-retryable status was already decided above; rethrow it as-is
      // rather than spending the remaining attempts on a call that cannot work.
      if (error instanceof NewsFeedError && error.status != null && !isRetryableStatus(error.status)) {
        throw error
      }
      lastError = error
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError)
  const status = lastError instanceof NewsFeedError ? lastError.status : null
  throw new NewsFeedError(
    `tokens.xyz news feed failed after ${MAX_RETRIES + 1} attempts: ${detail}`,
    status,
  )
}

function readItems(body: UpstreamFeedResponse): UpstreamFeedItem[] {
  if (!Array.isArray(body.items)) return []
  return body.items.filter(isRecord) as UpstreamFeedItem[]
}

/**
 * Published press articles (`feed_source: 'coingecko'`).
 *
 * CADENCE: the upstream window is short — 50 articles covered ~40 minutes when
 * measured. A caller wanting continuous coverage should poll well inside that,
 * and cannot backfill a gap afterwards. See the module header.
 *
 * The `source=news` request already excludes posts upstream; the feed_source
 * filter below is belt-and-braces so a change on their side cannot quietly
 * start feeding tweets into an article collector.
 */
export async function fetchArticles(
  options: NewsFeedFetchOptions = {},
): Promise<NewsFeedResult<NewsFeedArticle>> {
  const body = await requestFeed('news', options)
  const items = readItems(body)
    .filter((item) => readString(item.feed_source) === 'coingecko')
    .filter(hasUsableCore)
    .map(normalizeArticle)

  return { items, meta: parseMeta(body) }
}

/**
 * Posts from the @tokens account (`feed_source: 'x'`).
 *
 * This is ONE account's timeline, not a search across X — the upstream
 * hardcodes the handle. Expect promotional content about their own listings
 * alongside genuine market news, and weight it accordingly downstream.
 *
 * Note `tweet_reserve` is deliberately not exposed here: it only governs how
 * many tweet slots survive in `source=all`. `fetchFeed()` uses the upstream's
 * default blend, while this posts-only call has no use for that knob.
 */
export async function fetchPosts(
  options: NewsFeedFetchOptions = {},
): Promise<NewsFeedResult<NewsFeedPost>> {
  const body = await requestFeed('tweets', options)
  const items = readItems(body)
    .filter((item) => readString(item.feed_source) === 'x')
    .filter(hasUsableCore)
    .map(normalizePost)

  return { items, meta: parseMeta(body) }
}

/**
 * The blended tokens.xyz feed (`source=all`).
 *
 * Items stay in the order ranked by the upstream. Each item is normalized to
 * either an article or a post, so downstream code can branch on `kind`
 * without inspecting tokens.xyz field names. Unknown feed sources are dropped
 * rather than guessed into the wrong shape.
 */
export async function fetchFeed(
  options: NewsFeedFetchOptions = {},
): Promise<NewsFeedResult<NewsFeedItem>> {
  const body = await requestFeed('all', options)
  const items = readItems(body)
    .filter(hasUsableCore)
    .flatMap((item): NewsFeedItem[] => {
      const source = readString(item.feed_source)
      if (source === 'coingecko') return [normalizeArticle(item)]
      if (source === 'x') return [normalizePost(item)]
      return []
    })

  return { items, meta: parseMeta(body) }
}
