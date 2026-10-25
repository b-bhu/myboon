import { isDomeAvailable } from '../../dome.js'

const GAMMA_BASE = 'https://gamma-api.polymarket.com'
const CLOB_BASE = process.env.CLOB_HOST || 'https://clob.polymarket.com'

// --- TTL cache for Gamma API responses ---
const CACHE_TTL_MS = 60_000 // 60 seconds
const gammaCache = new Map<string, { data: unknown; expiresAt: number }>()

export async function gammaFetch(path: string): Promise<Response> {
  return fetch(`${GAMMA_BASE}/${path}`)
}

/** Gamma fetch with TTL cache — avoids hammering the API on concurrent featured-market requests. */
export async function gammaFetchCached<T>(path: string): Promise<T | null> {
  const now = Date.now()
  const cached = gammaCache.get(path)
  if (cached && cached.expiresAt > now) return cached.data as T

  const res = await gammaFetch(path)
  if (!res.ok) return null
  const data = await res.json() as T
  gammaCache.set(path, { data, expiresAt: now + CACHE_TTL_MS })
  return data
}

export async function clobFetch(path: string, options?: RequestInit): Promise<Response> {
  return fetch(`${CLOB_BASE}/${path}`, options)
}

// --- live price cache (background poll) ---
// Polls CLOB /midpoints every 5s for all active outcome tokens.
// Feed handler reads from this map instead of Gamma's stale outcomePrices.

const livePrices = new Map<string, number>()       // tokenId → midpoint price
const activeTokenIds = new Set<string>()            // YES token IDs to poll
const PRICE_POLL_INTERVAL_MS = 30_000
const MAX_LIVE_PRICE_TOKEN_IDS = 80

/** Register token IDs for live price polling. Called when feed builds its item list. */
export function registerTokenIds(tokenIds: string[]): void {
  for (const id of tokenIds) {
    if (!id) continue
    // Keep the newest active fixtures in the polling window and prevent
    // rotating automatic collections from growing this set forever.
    activeTokenIds.delete(id)
    activeTokenIds.add(id)
    while (activeTokenIds.size > MAX_LIVE_PRICE_TOKEN_IDS) {
      const oldest = activeTokenIds.values().next().value as string | undefined
      if (!oldest) break
      activeTokenIds.delete(oldest)
      livePrices.delete(oldest)
    }
  }
}

/** Get live price for a token, or null if not yet polled. */
export function getLivePrice(tokenId: string): number | null {
  return livePrices.get(tokenId) ?? null
}

export function normalizeTokenIds(input: string | null | undefined): string[] {
  if (!input) return []
  const seen = new Set<string>()
  const tokenIds: string[] = []
  for (const raw of input.split(',')) {
    const tokenId = raw.trim()
    if (!tokenId || seen.has(tokenId)) continue
    seen.add(tokenId)
    tokenIds.push(tokenId)
    if (tokenIds.length >= MAX_LIVE_PRICE_TOKEN_IDS) break
  }
  return tokenIds
}

export async function fetchMidpointsForTokenIds(tokenIds: string[]): Promise<Map<string, number>> {
  const prices = new Map<string, number>()
  if (tokenIds.length === 0) return prices

  const res = await clobFetch('midpoints', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tokenIds.map((id) => ({ token_id: id }))),
  })
  if (!res.ok) {
    console.error(`[api] CLOB /midpoints batch failed: ${res.status}`)
    return prices
  }

  const data = await res.json() as Record<string, unknown>
  for (const [tokenId, rawPrice] of Object.entries(data)) {
    const price = parseNullableNumber(rawPrice)
    if (price !== null) {
      prices.set(tokenId, price)
      livePrices.set(tokenId, price)
    }
  }
  return prices
}

export async function fetchBuyPricesForTokenIds(tokenIds: string[]): Promise<Map<string, number>> {
  const prices = new Map<string, number>()
  if (tokenIds.length === 0) return prices

  const results = await Promise.allSettled(
    tokenIds.map(async (tokenId) => {
      const res = await clobFetch(`price?token_id=${encodeURIComponent(tokenId)}&side=buy`)
      if (!res.ok) return null
      const body = await res.json() as Record<string, unknown>
      const price = parseNullableNumber(body.price)
      return price !== null ? { tokenId, price } : null
    })
  )

  for (const result of results) {
    if (result.status !== 'fulfilled' || result.value === null) continue
    prices.set(result.value.tokenId, result.value.price)
    livePrices.set(result.value.tokenId, result.value.price)
  }
  return prices
}

async function pollLivePrices(): Promise<void> {
  if (activeTokenIds.size === 0) return
  try {
    // V2: POST /midpoints with JSON array of { token_id } objects
    const body = [...activeTokenIds].map(id => ({ token_id: id }))
    const res = await clobFetch('midpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      console.error(`[api] CLOB /midpoints poll failed: ${res.status}`)
      return
    }
    const data = await res.json() as Record<string, string>
    for (const [tokenId, priceStr] of Object.entries(data)) {
      const price = parseFloat(priceStr)
      if (Number.isFinite(price)) {
        livePrices.set(tokenId, price)
      }
    }
  } catch (err) {
    console.error('[api] CLOB /midpoints poll error:', err instanceof Error ? err.message : err)
  }
}

let pollInterval: ReturnType<typeof setInterval> | null = null
let initialPollTimeout: ReturnType<typeof setTimeout> | null = null

/**
 * Start the existing live-price poll when the API server starts.
 * Route-module imports stay side-effect free for tests and composition.
 */
export function startMarketReadPolling(): void {
  if (pollInterval) return
  pollInterval = setInterval(pollLivePrices, PRICE_POLL_INTERVAL_MS)
  initialPollTimeout = setTimeout(pollLivePrices, 2_000)
  console.log(`[api] Live price polling started (every ${PRICE_POLL_INTERVAL_MS / 1000}s)`)
}

export function stopMarketReadPolling(): void {
  if (pollInterval) clearInterval(pollInterval)
  if (initialPollTimeout) clearTimeout(initialPollTimeout)
  pollInterval = null
  initialPollTimeout = null
}

export function parseStringArray(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input.filter((value): value is string => typeof value === 'string')
  }

  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input) as unknown
      if (Array.isArray(parsed)) {
        return parsed.filter((value): value is string => typeof value === 'string')
      }
    } catch {
      return []
    }
  }

  return []
}

export function parseNullableNumber(input: unknown): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null
  if (typeof input !== 'string') return null

  const parsed = parseFloat(input)
  return Number.isFinite(parsed) ? parsed : null
}

export function parseNullableString(input: unknown): string | null {
  return typeof input === 'string' && input.trim().length > 0 ? input : null
}

export function normalizeSoccerOutcomeLabel(input: unknown): string {
  const label = String(input ?? '').trim()
  return label.startsWith('Draw ') ? 'Draw' : label
}

// --- dome fallback wrapper ---

export async function withDomeFallback<T>(
  label: string,
  domeFn: () => Promise<T>,
  gammaFn: () => Promise<T>,
): Promise<T> {
  if (!isDomeAvailable()) return gammaFn()
  try {
    return await domeFn()
  } catch (err) {
    console.warn(`[api] Dome failed for ${label}, falling back to Gamma:`, err instanceof Error ? err.message : err)
    return gammaFn()
  }
}
