/**
 * Meteora venue (#726): the wallet summary's Meteora LP slot. It reads the
 * same portfolio the phone reads (apps/hybrid-expo wallet.sources.ts,
 * fetchMeteoraValueUsd) through the shared MeteoraDataApiClient — imported
 * from the data-api subpath only, never `@myboon/shared/meteora`, which
 * also loads the transaction SDK. The request asks for the upstream's
 * maximum portfolio page (50 pools); `totalPools` and `hasMore` say how
 * much sits beyond the returned page.
 *
 * The totals mirror the phone exactly (Done means): a wallet with no open
 * pools is a legitimate, successfully-fetched $0, and an unparseable total
 * in a non-empty portfolio throws — which the summary service maps to this
 * app's `unavailable` while every other app still returns (#725). A
 * request without a `solana` address has no Meteora account at all:
 * `not_connected`, the same no-account state Polymarket serves for a
 * missing `evm` address (#725).
 */
import type { AppSummary, MeteoraSummary, WalletMeteoraPool } from '@myboon/shared/wallet-summary'
import { MeteoraDataApiClient } from '@myboon/shared/meteora/data-api'
import { notConnectedApp, type WalletFetchContext, type WalletVenue } from '../service.js'

// One shared client: its per-URL cache (5s fresh, from shared/meteora
// config) also deduplicates repeat summary requests inside the summary's
// own 15s cache window. Plain fetch, no key (#726).
const client = new MeteoraDataApiClient()

/**
 * The upstream sends USD amounts as strings, some of them nullable
 * (`totalPnlUsd`): `null` (absent) and non-finite values both stay null —
 * the same safe conversion the phone does in fetchMeteoraValueUsd and
 * buildMeteoraRowDetail.
 */
function parseUsd(value: string | null): number | null {
  if (value === null) return null
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

export const meteoraVenue = {
  id: 'meteora',
  /** @throws when the upstream portfolio call fails (the service maps it to `unavailable`). */
  async fetch({ solana }: WalletFetchContext): Promise<AppSummary<MeteoraSummary>> {
    if (!solana) return notConnectedApp()

    // The upstream caps portfolio page_size at 50 (#726): ask for all of it.
    const portfolio = (await client.getOpenPortfolio(solana, { pageSize: 50 })).data

    // A wallet with zero open pools is a legitimate, successfully-fetched
    // $0 — not a failure. The totals are absent in that answer, so the
    // nullable conversions stay null.
    if (portfolio.pools.length === 0) {
      return {
        status: 'ok',
        valueUsd: 0,
        summary: {
          poolCount: 0,
          totalPools: portfolio.totalPools,
          hasMore: portfolio.hasNext,
          unclaimedFeesUsd: null,
          totalPnlUsd: null,
          pools: [],
        },
      }
    }

    // Same total the phone serves: an unparseable total is an error, not 0.
    const valueUsd = parseUsd(portfolio.totalBalanceUsd)
    if (valueUsd === null) throw new Error('Meteora value unavailable')

    const pools: WalletMeteoraPool[] = portfolio.pools.map((pool) => ({
      name: pool.pair,
      valueUsd: parseUsd(pool.balanceUsd),
      unclaimedFeesUsd: parseUsd(pool.unclaimedFeesUsd),
      outOfRange: pool.outOfRange,
    }))

    return {
      status: 'ok',
      valueUsd,
      summary: {
        poolCount: pools.length,
        totalPools: portfolio.totalPools,
        hasMore: portfolio.hasNext,
        unclaimedFeesUsd: parseUsd(portfolio.totalUnclaimedFeesUsd),
        totalPnlUsd: parseUsd(portfolio.totalPnlUsd),
        pools,
      },
    }
  },
} satisfies WalletVenue
