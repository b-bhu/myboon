/**
 * Jupiter token lookup — identity for arbitrary SPL mints.
 *
 * The Tokens registry curates a few hundred assets by hand and does not accept
 * outside contributions, so it will never cover a venue that lists new mints
 * daily. Jupiter *indexes* instead: measured against 40 real Meteora pool
 * mints it returned an icon for 40 of them, including brand-new meme tokens.
 *
 * So the division of labour is:
 *   Tokens registry -> perps and majors, where curated identity is the point
 *   Jupiter         -> the open-ended long tail, keyed by mint
 *
 * Deliberately mint-generic rather than Meteora-specific. Spot lists, a meme
 * discovery feed and a token page all need identity for an arbitrary mint, and
 * they should all land here rather than each growing their own lookup.
 *
 * Note what Jupiter returns is a URL on someone else's host — IPFS, Arweave,
 * Irys, a launchpad CDN, whatever the mint's metadata declares (8+ distinct
 * hosts across those 40). Those URLs never reach a client: the icon proxy
 * fetches the bytes once and serves them from our own origin, so a slow IPFS
 * gateway costs one server-side miss instead of a broken row on every device.
 */

/** Free tier. `JUP_API_KEY` upgrades to api.jup.ag via the swap proxy config. */
const JUPITER_TOKEN_SEARCH_URL = process.env.JUPITER_API_BASE
  ? `${process.env.JUPITER_API_BASE}/tokens/v2/search`
  : 'https://lite-api.jup.ag/tokens/v2/search'

/** Jupiter accepts a comma-separated query; 10 keeps URLs and failures small. */
const MINTS_PER_REQUEST = 10

/** How long a resolved mint stays warm before we would look it up again. */
const ENTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * How long a *failed* lookup is remembered. Short, and deliberately far below
 * ENTRY_TTL_MS: a mint minted seconds ago may simply not be indexed yet, and
 * we want the next screen that asks to retry rather than show a letter box for
 * a week.
 */
const MISS_TTL_MS = 10 * 60 * 1000

export interface JupiterTokenInfo {
  mint: string
  symbol: string | null
  name: string | null
  /** Upstream icon URL — third-party host, proxied before any client sees it. */
  iconUrl: string | null
  decimals: number | null
  verified: boolean
}

interface CacheEntry {
  info: JupiterTokenInfo | null
  expiresAt: number
}

type FetchLike = typeof fetch

const mintCache = new Map<string, CacheEntry>()
/** Mints currently being looked up, so concurrent callers share one request. */
const inFlight = new Map<string, Promise<void>>()

/** Test-only: reset module state between cases. */
export function __clearJupiterCacheForTest(): void {
  mintCache.clear()
  inFlight.clear()
}

/**
 * Read a mint from the warm cache. Synchronous by design — `resolveRef` is
 * pure and synchronous so a market list never awaits a network call, and this
 * has to be callable from inside it. Returns null when we have not looked the
 * mint up yet (or the lookup failed); callers fall back to the letter box and
 * the row still renders.
 */
export function getCachedJupiterToken(mint: string): JupiterTokenInfo | null {
  const entry = mintCache.get(mint)
  if (!entry || entry.expiresAt <= Date.now()) return null
  return entry.info
}

/** Mints we have no live cache entry for — the set worth asking Jupiter about. */
export function unknownMints(mints: readonly string[]): string[] {
  const now = Date.now()
  const unknown = new Set<string>()
  for (const mint of mints) {
    const entry = mintCache.get(mint)
    if (!entry || entry.expiresAt <= now) unknown.add(mint)
  }
  return [...unknown]
}

function parseToken(raw: Record<string, unknown>): JupiterTokenInfo | null {
  // v2/search returns `id` for the mint and `icon` for the image; older shapes
  // used `address`/`logoURI`. Accept both so a Jupiter change degrades to a
  // miss rather than a crash.
  const mint = typeof raw.id === 'string' ? raw.id : typeof raw.address === 'string' ? raw.address : null
  if (!mint) return null
  const icon = typeof raw.icon === 'string' ? raw.icon : typeof raw.logoURI === 'string' ? raw.logoURI : null
  return {
    mint,
    symbol: typeof raw.symbol === 'string' ? raw.symbol : null,
    name: typeof raw.name === 'string' ? raw.name : null,
    iconUrl: icon && icon.length > 0 ? icon : null,
    decimals: typeof raw.decimals === 'number' ? raw.decimals : null,
    // Jupiter exposes verification under a couple of names depending on tier.
    verified: raw.isVerified === true || raw.verified === true,
  }
}

async function fetchBatch(mints: string[], fetchImpl: FetchLike, apiKey?: string): Promise<void> {
  const url = `${JUPITER_TOKEN_SEARCH_URL}?query=${encodeURIComponent(mints.join(','))}`
  const expiresAt = Date.now() + ENTRY_TTL_MS
  try {
    const res = await fetchImpl(url, {
      headers: apiKey ? { 'x-api-key': apiKey } : undefined,
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`jupiter token search ${res.status}`)
    const body = await res.json() as unknown
    const rows = Array.isArray(body)
      ? body
      : Array.isArray((body as { tokens?: unknown[] }).tokens)
        ? (body as { tokens: unknown[] }).tokens
        : []

    const seen = new Set<string>()
    for (const row of rows) {
      const info = parseToken(row as Record<string, unknown>)
      if (!info) continue
      mintCache.set(info.mint, { info, expiresAt })
      seen.add(info.mint)
    }
    // Mints Jupiter did not return: cache the miss briefly so a burst of rows
    // does not re-ask on every render, but retry soon in case it is just new.
    const missExpiry = Date.now() + MISS_TTL_MS
    for (const mint of mints) {
      if (!seen.has(mint)) mintCache.set(mint, { info: null, expiresAt: missExpiry })
    }
  } catch (err) {
    console.error('[api] Jupiter token lookup failed:', err instanceof Error ? err.message : err)
    const missExpiry = Date.now() + MISS_TTL_MS
    for (const mint of mints) {
      if (!mintCache.has(mint)) mintCache.set(mint, { info: null, expiresAt: missExpiry })
    }
  }
}

/**
 * Look up any mints we do not already have warm, and fill the cache.
 *
 * Never throws: a failed lookup leaves those mints uncached (briefly) and the
 * rows that wanted them render the letter box. Identity is a decoration on a
 * market row, never a precondition for one.
 */
export async function warmJupiterTokens(
  mints: readonly string[],
  fetchImpl: FetchLike = globalThis.fetch,
  apiKey = process.env.JUP_API_KEY,
): Promise<void> {
  const missing = unknownMints(mints)
  if (missing.length === 0) return

  const batches: string[][] = []
  for (let i = 0; i < missing.length; i += MINTS_PER_REQUEST) {
    batches.push(missing.slice(i, i + MINTS_PER_REQUEST))
  }

  await Promise.all(batches.map((batch) => {
    const key = batch.join(',')
    let pending = inFlight.get(key)
    if (!pending) {
      pending = fetchBatch(batch, fetchImpl, apiKey).finally(() => inFlight.delete(key))
      inFlight.set(key, pending)
    }
    return pending
  }))
}
