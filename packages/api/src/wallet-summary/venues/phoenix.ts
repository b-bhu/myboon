/**
 * Phoenix venue (#744): the wallet summary's Phoenix slot. It reads the same
 * trader state the Phoenix routes serve (the reader function extracted in
 * #727) and the phone reads, so the summary matches what the phone shows
 * for the same address.
 *
 * Sums mirror the phone (wallet.sources.ts / phoenix.portfolio.tsx) via the
 * shared helpers (`accountSummary`, `sumPhoenixPortfolioValue`, `toUsd`,
 * `toNumber`) — used, never copied. A successful trader-state lookup that
 * finds no trader records is a legitimate $0, not a failure and not
 * `not_connected` — the same reading the shared `sumPhoenixPortfolioValue`
 * documents and the phone's Wallet row shows. `not_connected` is reserved
 * for a missing `solana` address, exactly like the spot venue. A failed
 * upstream (429 included) is thrown and the
 * summary service maps it to this app's `unavailable` slot while every
 * other app still returns (#725) — the same contract as the Meteora and
 * spot venues.
 */
import type { AppSummary, PhoenixSummary, PhoenixTraderRecord, WalletPerpPosition } from '@myboon/shared/wallet-summary'
import { accountSummary, sumPhoenixPortfolioValue, toNumber, toUsd } from '@myboon/shared/wallet-summary'
import { getPhoenixTraderState } from '../../phoenix.js'
import { notConnectedApp, type WalletFetchContext, type WalletVenue } from '../service.js'

function asRecord(input: unknown): Record<string, unknown> | null {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null
}

function asString(input: unknown): string | null {
  return typeof input === 'string' && input.trim().length > 0 ? input.trim() : null
}

/** The phone's normalizePositions (phoenix.portfolio.tsx): one row per open
 * position, zero-size rows skipped, |notional| descending. */
function toPositions(traders: PhoenixTraderRecord[]): WalletPerpPosition[] {
  const rows: Array<WalletPerpPosition & { notional: number }> = []

  for (const trader of traders) {
    const positions = Array.isArray(trader.positions) ? trader.positions : []
    for (const item of positions) {
      const record = asRecord(item)
      if (!record) continue
      const symbol = asString(record.symbol)
      const size = toNumber(record.positionSize)
      if (!symbol || size === null || size === 0) continue
      rows.push({
        symbol,
        size: Math.abs(size),
        unrealizedPnlUsd: toUsd(record.unrealizedPnl),
        notional: Math.abs(toUsd(record.positionValue) ?? 0),
      })
    }
  }

  rows.sort((a, b) => b.notional - a.notional)
  return rows.map(({ notional: _notional, ...position }) => position)
}

export const phoenixVenue = {
  id: 'phoenix',
  /** @throws when the upstream trader-state call fails (the service maps it to `unavailable`). */
  async fetch({ solana }: WalletFetchContext): Promise<AppSummary<PhoenixSummary>> {
    if (!solana) return notConnectedApp()

    // The same reader the routes serve; pdaIndex 0 is the primary account,
    // matching the phone's fetchPhoenixTraderState default.
    const result = await getPhoenixTraderState(solana, '0')
    if (result.status !== 200) {
      throw new Error(`Phoenix trader state unavailable (${result.status}): ${result.body.error}`)
    }

    const traders = result.body.traders
      .map(asRecord)
      .filter((record): record is PhoenixTraderRecord => record !== null)
    // A successful lookup with no trader records is a legitimate $0 — the
    // same reading `sumPhoenixPortfolioValue` documents and the phone's
    // Wallet row shows. Literal zeros, not `accountSummary([])`'s nulls.
    if (traders.length === 0) {
      return {
        status: 'ok',
        valueUsd: 0,
        summary: { equityUsd: 0, collateralUsd: 0, unrealizedPnlUsd: 0, positionCount: 0, positions: [] },
      }
    }

    // Same totals the phone sums (portfolioValue, collateralBalance,
    // effectiveCollateral, unrealizedPnl) via the shared helpers.
    const summary = accountSummary(traders)
    const valueUsd = sumPhoenixPortfolioValue(traders)
    // Traders exist but none reported a parseable portfolioValue: the phone
    // throws here too, so the service answers `unavailable`.
    if (valueUsd === null) throw new Error('Phoenix value unavailable')

    const positions = toPositions(traders)

    return {
      status: 'ok',
      valueUsd,
      summary: {
        equityUsd: valueUsd,
        collateralUsd: summary.collateralBalance,
        unrealizedPnlUsd: summary.unrealizedPnl,
        positionCount: positions.length,
        positions,
      },
    }
  },
} satisfies WalletVenue
