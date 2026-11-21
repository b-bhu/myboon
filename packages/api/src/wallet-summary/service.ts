/**
 * Wallet summary service (#725): assembles the single GET /wallet/summary
 * response from the per-app registry in ./venues. Venues run under
 * `Promise.allSettled`, so one app failing never fails the response — it
 * answers `unavailable` while the log keeps the detail (Rule: `[api]`
 * prefix in the log, short messages on the wire). Every app is a stub
 * until its own issue lands (#714 checklist); the response shape is final.
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

export type VenueId = keyof WalletSummary['apps']

/** The addresses a summary is built for (null = that address was not sent). */
export interface WalletSummaryQuery {
  solana: string | null
  evm: string | null
}

export interface WalletSummaryService {
  getSummary(query: WalletSummaryQuery): Promise<WalletSummary>
}

// One app behind the summary. The union keys each venue to exactly its own
// apps slice, so a venue registered as, say, 'meteora' cannot fill any
// other slot (later issues add one file and one list entry per app).
export type WalletVenue =
  | { id: 'polymarket'; fetch(ctx: WalletSummaryQuery): Promise<AppSummary<PolymarketSummary>> }
  | { id: 'phoenix'; fetch(ctx: WalletSummaryQuery): Promise<AppSummary<PhoenixSummary>> }
  | { id: 'pacifica'; fetch(ctx: WalletSummaryQuery): Promise<AppSummary<PacificaSummary>> }
  | { id: 'meteora'; fetch(ctx: WalletSummaryQuery): Promise<AppSummary<MeteoraSummary>> }
  | { id: 'spot'; fetch(ctx: WalletSummaryQuery): Promise<AppSummary<SpotSummary>> }

/** The stub slot: nothing behind this app yet, not an error. */
export function unavailableApp(): AppSummary<never> {
  return { status: 'unavailable', valueUsd: null, summary: null, error: NOT_AVAILABLE_YET }
}

/** This person has no account at this venue (e.g. no `evm` address sent). */
export function notConnectedApp(): AppSummary<never> {
  return { status: 'not_connected', valueUsd: null, summary: null }
}

export function createWalletSummaryService(
  options: { venues?: WalletVenue[]; now?: () => Date } = {},
): WalletSummaryService {
  const venues = options.venues ?? walletVenues()
  const now = options.now ?? (() => new Date())

  return {
    async getSummary(query) {
      const results = await Promise.allSettled(venues.map((venue) => venue.fetch(query)))

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
    },
  }
}
