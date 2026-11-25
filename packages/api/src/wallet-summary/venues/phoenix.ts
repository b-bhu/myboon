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
import type { AppSummary, PhoenixSummary, PhoenixTraderRecord, WalletPerpPosition, WalletPerpPositionDetail } from '@myboon/shared/wallet-summary'
import { accountSummary, sumPhoenixPortfolioValue, toNumber, toUsd } from '@myboon/shared/wallet-summary'
import { getPhoenixTraderState, type PhoenixUpstream } from '../../phoenix/index.js'
import { asRecord } from '@myboon/shared/guards'
import { notConnectedApp, type WalletFetchContext, type WalletVenue } from '../service.js'

/**
 * Differs from @myboon/shared/guards asString: returns the trimmed value and
 * never stringifies numbers (#896).
 */
function asStringTrimmed(input: unknown): string | null {
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
      const symbol = asStringTrimmed(record.symbol)
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

/**
 * One row per open position with full detail (#916) — the shape the wallet
 * positions route (#899) will serve and the portfolio Positions tab (#849)
 * will render. Reads positions exactly like toPositions (every trader's
 * `positions` array, each item through `asRecord`; a row with no symbol or a
 * zero/null `positionSize` is skipped) and keeps the same `|valueUsd|`
 * descending sort, null counting as 0. Only the phone's raw keys
 * (normalizePositions, phoenix.portfolio.tsx): mark falls back to
 * `oraclePrice`, and the v1 TP/SL triggers are already merged upstream into
 * `takeProfitPrice`/`stopLossPrice`. A field the upstream does not give is
 * null, never 0.
 */
export function toPhoenixPositionDetails(traders: PhoenixTraderRecord[]): WalletPerpPositionDetail[] {
  const rows: Array<WalletPerpPositionDetail & { sortValueUsd: number }> = []

  for (const [traderIndex, trader] of traders.entries()) {
    const positions = Array.isArray(trader.positions) ? trader.positions : []
    for (const item of positions) {
      const record = asRecord(item)
      if (!record) continue
      const symbol = asStringTrimmed(record.symbol)
      const size = toNumber(record.positionSize)
      if (!symbol || size === null || size === 0) continue

      const absSize = Math.abs(size)
      const valueUsd = toUsd(record.positionValue)
      const entryPriceUsd = toUsd(record.entryPrice)
      const unrealizedPnlUsd = toUsd(record.unrealizedPnl)
      // P&L against the entry notional; null inputs or a zero divisor
      // (entry price 0 or null) stay null.
      const divisor = entryPriceUsd !== null ? entryPriceUsd * absSize : null
      const pnlPct =
        unrealizedPnlUsd !== null && divisor !== null && divisor !== 0
          ? (unrealizedPnlUsd / divisor) * 100
          : null
      const leverage = toNumber(record.leverage)

      rows.push({
        symbol,
        side: size >= 0 ? 'long' : 'short',
        size: absSize,
        leverage: leverage !== null && leverage > 0 ? leverage : null,
        valueUsd,
        entryPriceUsd,
        markPriceUsd: toUsd(record.markPrice ?? record.oraclePrice),
        liquidationPriceUsd: toUsd(record.liquidationPrice),
        unrealizedPnlUsd,
        pnlPct,
        takeProfitPriceUsd: toUsd(record.takeProfitPrice),
        stopLossPriceUsd: toUsd(record.stopLossPrice),
        traderPdaIndex: toNumber(trader.traderPdaIndex) ?? traderIndex,
        traderSubaccountIndex: toNumber(trader.traderSubaccountIndex) ?? 0,
        sortValueUsd: Math.abs(valueUsd ?? 0),
      })
    }
  }

  rows.sort((a, b) => b.sortValueUsd - a.sortValueUsd)
  return rows.map(({ sortValueUsd: _sortValueUsd, ...detail }) => detail)
}

export function createPhoenixVenue(upstream: PhoenixUpstream) {
  return {
    id: 'phoenix',
    /** @throws when the upstream trader-state call fails (the service maps it to `unavailable`). */
    async fetch({ solana }: WalletFetchContext): Promise<AppSummary<PhoenixSummary>> {
      if (!solana) return notConnectedApp()

      // The same reader the routes serve; pdaIndex 0 is the primary account,
      // matching the phone's fetchPhoenixTraderState default.
      const result = await getPhoenixTraderState(upstream, solana, '0')
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
}
