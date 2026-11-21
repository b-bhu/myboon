/**
 * Wallet summary service (#725): assembles the single GET /wallet/summary
 * response from the per-app registry in ./venues. Venues run under
 * `Promise.allSettled`, so one app failing never fails the response — it
 * answers `unavailable` while the log keeps the detail (Rule: `[api]`
 * prefix in the log, short messages on the wire). Every app is a stub
 * until its own issue lands (#714 checklist); the response shape is final.
 *
 * Guards (#743): each app is raced against an 8 second timeout via
 * `AbortController` — the signal rides in the fetch context so a venue can
 * cancel its own upstream calls, and a timed-out app alone answers
 * `unavailable`. The whole summary is cached for 15 seconds keyed by both
 * addresses; the cache holds at most 500 entries and drops the oldest
 * (unlike the spot.ts / phoenix.ts caches, which never evict), and
 * concurrent requests for the same key share one fetch.
 */
import type {
  AppSummary,
  MeteoraSummary,
  PacificaSummary,
  PhoenixSummary,
  PolymarketSummary,
  SpotSummary,
  WalletSummary,
} from '@myboon/shared/wallet-summary'
import { walletVenues } from './venues/index.js'

/** Error string every app serves until its own issue lands. */
export const NOT_AVAILABLE_YET = 'not_available_yet'

/** Per-app timeout (#743): a slow app answers `unavailable`, the rest return. */
const APP_TIMEOUT_MS = 8_000
/** Whole-summary cache (#743): 15 second TTL, 500 entries, oldest dropped. */
const CACHE_TTL_MS = 15_000
const CACHE_MAX_ENTRIES = 500

export type VenueId = keyof WalletSummary['apps']

/** The addresses a summary is built for (null = that address was not sent). */
export interface WalletSummaryQuery {
  solana: string | null
  evm: string | null
}

/** One venue fetch's context: the addresses plus that app's timeout signal. */
export interface WalletFetchContext extends WalletSummaryQuery {
  signal: AbortSignal
}

export interface WalletSummaryService {
  getSummary(query: WalletSummaryQuery): Promise<WalletSummary>
}

export interface WalletSummaryServiceOptions {
  venues?: WalletVenue[]
  now?: () => Date
  /** Per-app timeout in milliseconds (#743). */
  timeoutMs?: number
  /** Whole-summary cache TTL in milliseconds (#743). */
  cacheTtlMs?: number
  /** Whole-summary cache entry cap (#743). */
  cacheMaxEntries?: number
}

// One app behind the summary. The union keys each venue to exactly its own
// apps slice, so a venue registered as, say, 'meteora' cannot fill any
// other slot (later issues add one file and one list entry per app).
export type WalletVenue =
  | { id: 'polymarket'; fetch(ctx: WalletFetchContext): Promise<AppSummary<PolymarketSummary>> }
  | { id: 'phoenix'; fetch(ctx: WalletFetchContext): Promise<AppSummary<PhoenixSummary>> }
  | { id: 'pacifica'; fetch(ctx: WalletFetchContext): Promise<AppSummary<PacificaSummary>> }
  | { id: 'meteora'; fetch(ctx: WalletFetchContext): Promise<AppSummary<MeteoraSummary>> }
  | { id: 'spot'; fetch(ctx: WalletFetchContext): Promise<AppSummary<SpotSummary>> }

/** The stub slot: nothing behind this app yet, not an error. */
export function unavailableApp(): AppSummary<never> {
  return { status: 'unavailable', valueUsd: null, summary: null, error: NOT_AVAILABLE_YET }
}

/** This person has no account at this venue (e.g. no `evm` address sent). */
export function notConnectedApp(): AppSummary<never> {
  return { status: 'not_connected', valueUsd: null, summary: null }
}

/** One app race (#743): the timer aborts the controller and its listener
 * rejects the lane, so the deadline unblocks the response while the
 * controller's signal is available to the venue's own upstream calls. */
async function raceAppTimeout(
  venue: WalletVenue,
  query: WalletSummaryQuery,
  timeoutMs: number,
): Promise<AppSummary<unknown>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await Promise.race([
      venue.fetch({ ...query, signal: controller.signal }),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('app timed out')), { once: true })
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function createWalletSummaryService(
  options: WalletSummaryServiceOptions = {},
): WalletSummaryService {
  const venues = options.venues ?? walletVenues()
  const now = options.now ?? (() => new Date())
  const timeoutMs = options.timeoutMs ?? APP_TIMEOUT_MS
  const cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_MS
  const cacheMaxEntries = options.cacheMaxEntries ?? CACHE_MAX_ENTRIES

  // Whole-summary cache and in-flight fetch table (#743). Map keys keep
  // insertion order and hits do not reorder, so eviction at the cap drops
  // the oldest entry first.
  const cache = new Map<string, { at: number; value: WalletSummary }>()
  const inFlight = new Map<string, Promise<WalletSummary>>()
  const keyFor = (query: WalletSummaryQuery): string => `${query.solana ?? ''}|${query.evm ?? ''}`

  return {
    async getSummary(query) {
      const key = keyFor(query)
      const cached = cache.get(key)
      if (cached) {
        if (now().getTime() - cached.at < cacheTtlMs) return cached.value
        cache.delete(key) // past the TTL: recompute
      }
      // Two requests for the same key at the same time share one fetch.
      const running = inFlight.get(key)
      if (running) return running

      const build = (async () => {
        const results = await Promise.allSettled(venues.map((venue) => raceAppTimeout(venue, query, timeoutMs)))

        // Slots keyed exactly as the registry: the venue with id K serves
        // slot K. Seeded with the stub so a missing registry entry can never
        // leave a slot undefined — the shape is final (#722).
        const gathered: Record<VenueId, AppSummary<unknown>> = {
          polymarket: unavailableApp(),
          phoenix: unavailableApp(),
          pacifica: unavailableApp(),
          meteora: unavailableApp(),
          spot: unavailableApp(),
        }
        venues.forEach((venue, index) => {
          const outcome = results[index]
          if (outcome.status === 'fulfilled') {
            gathered[venue.id] = outcome.value
            return
          }
          // One app failing never fails the response; the log keeps the detail.
          if (outcome.reason instanceof Error) console.error(`[api] wallet-summary ${venue.id} failed:`, outcome.reason)
          else console.error(`[api] wallet-summary ${venue.id} failed: ${String(outcome.reason)}`)
        })

        return {
          solana: query.solana,
          evm: query.evm,
          fetchedAt: now().toISOString(),
          apps: {
            polymarket: gathered.polymarket as AppSummary<PolymarketSummary>,
            phoenix: gathered.phoenix as AppSummary<PhoenixSummary>,
            pacifica: gathered.pacifica as AppSummary<PacificaSummary>,
            meteora: gathered.meteora as AppSummary<MeteoraSummary>,
            spot: gathered.spot as AppSummary<SpotSummary>,
          },
        }
      })()

      inFlight.set(key, build)
      try {
        const summary = await build
        cache.set(key, { at: now().getTime(), value: summary })
        while (cache.size > cacheMaxEntries) {
          const oldest = cache.keys().next().value
          if (oldest === undefined) break
          cache.delete(oldest)
        }
        return summary
      } finally {
        inFlight.delete(key)
      }
    },
  }
}
