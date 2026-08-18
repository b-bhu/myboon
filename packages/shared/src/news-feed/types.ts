/** A published press article from the configured structured news feed. */
export interface NewsFeedArticle {
  kind: 'article'
  title: string
  url: string
  /** ISO 8601, normalized. null when the upstream value was missing/unparseable. */
  publishedAt: string | null
  /** Publishing outlet, e.g. `FXStreet` or `PANews (EN)`. */
  outlet: string | null
  author: string | null
  imageUrl: string | null
  /**
   * Untrusted upstream coin tagging. It may narrow later research, but must
   * never be treated as a verified entity assignment.
   */
  relatedCoinIds: string[]
}

/** A post from the @tokens account on X. */
export interface NewsFeedPost {
  kind: 'post'
  text: string
  url: string
  /** ISO 8601, normalized. null when the upstream value was missing/unparseable. */
  postedAt: string | null
  handle: string | null
  imageUrl: string | null
  /** Untrusted upstream coin tagging; see NewsFeedArticle.relatedCoinIds. */
  relatedCoinIds: string[]
}

/** One item from the blended `source=all` feed, in upstream ranking order. */
export type NewsFeedItem = NewsFeedArticle | NewsFeedPost

export interface NewsFeedMeta {
  mode: 'global' | 'token'
  terms: string[]
  limit: number
  coingeckoCandidates: number
  xCandidates: number
}

export interface NewsFeedResult<TItem> {
  items: TItem[]
  meta: NewsFeedMeta
}

export interface NewsFeedFetchOptions {
  /** 1..50. Values outside are clamped, not rejected. Defaults to 10. */
  limit?: number
  coinId?: string
  symbol?: string
  name?: string
  assetId?: string
  terms?: string[]
  /** Defaults to the canonical Tokens.xyz credential, TOKENS_API_KEY. */
  apiKey?: string
  /** Injection point for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
}
