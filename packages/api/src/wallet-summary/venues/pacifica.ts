/**
 * Pacifica venue (#728): the summary's Pacifica perps slot. The account,
 * positions and prices are the same three calls the phone makes (apps/
 * hybrid-expo features/perps/perps.public-api.ts) via the shared
 * `pacificaGetJson` helper, which carries the timeout and the 429 handling.
 * Unrealized P&L is the shared `pacificaUnrealizedPnl` — (mark - entry) *
 * size * direction, direction 1 = long (`bid`), -1 = short (`ask`) — with
 * marks from /info/prices.
 *
 * An address with no Pacifica account answers `ok` with zero values (the
 * upstream answers 404 `Account not found`), never an error. A 429 (or any
 * other upstream failure) answers `unavailable` for this app only — the
 * summary service keeps the rest — and a 429 with a retry hint carries it
 * in the error text. A request without a `solana` address has no Pacifica
 * account at all: `not_connected`, the same no-account state Polymarket
 * serves for a missing `evm` address (#725).
 */
import type { AppSummary, PacificaSummary, WalletPerpPosition } from '@myboon/shared/wallet-summary'
import { pacificaUnrealizedPnl, safeNum } from '@myboon/shared/wallet-summary'
import { PacificaApiError, pacificaGetJson } from '../../pacifica/client.js'
import { notConnectedApp, type WalletFetchContext, type WalletVenue } from '../service.js'

// The upstream answers for accounts that never traded / never existed.
interface RawAccountInfo {
  account_equity?: string
  available_to_spend?: string
}

interface RawPosition {
  symbol: string
  side: 'bid' | 'ask'
  amount: string
  entry_price: string
}

interface RawPriceInfo {
  symbol: string
  mark: string
}

const ZERO_SUMMARY: PacificaSummary = {
  equityUsd: 0,
  availableToSpendUsd: 0,
  unrealizedPnlUsd: 0,
  positionCount: 0,
  positions: [],
}

export const pacificaVenue = {
  id: 'pacifica',
  /** Upstream failures are reported as `unavailable` for this app only. */
  async fetch({ solana }: WalletFetchContext): Promise<AppSummary<PacificaSummary>> {
    if (!solana) return notConnectedApp()

    const accountPath = `/account?account=${encodeURIComponent(solana)}`
    try {
      const account = await pacificaGetJson<RawAccountInfo>(accountPath)
      const [positions, prices] = await Promise.all([
        pacificaGetJson<RawPosition[]>(`/positions?account=${encodeURIComponent(solana)}`),
        pacificaGetJson<RawPriceInfo[]>('/info/prices'),
      ])

      const markBySymbol = new Map(prices.map((price) => [price.symbol, safeNum(price.mark)]))
      const mapped: WalletPerpPosition[] = positions.map((position) => {
        const entry = safeNum(position.entry_price)
        const mark = markBySymbol.get(position.symbol) ?? entry
        const size = safeNum(position.amount)
        const direction = position.side === 'bid' ? 1 : -1
        return { symbol: position.symbol, size, unrealizedPnlUsd: pacificaUnrealizedPnl(entry, mark, size, direction) }
      })

      const equityUsd = safeNum(account.account_equity)
      return {
        status: 'ok',
        valueUsd: equityUsd,
        summary: {
          equityUsd,
          availableToSpendUsd: safeNum(account.available_to_spend),
          unrealizedPnlUsd: mapped.reduce((sum, position) => sum + (position.unrealizedPnlUsd ?? 0), 0),
          positionCount: mapped.length,
          positions: mapped,
        },
      }
    } catch (error) {
      // No Pacifica account for this address: a legitimate, successfully-
      // determined $0 — the same zero-values answer the phone renders.
      if (error instanceof PacificaApiError && error.status === 404) {
        return { status: 'ok', valueUsd: 0, summary: { ...ZERO_SUMMARY, positions: [] } }
      }
      const message = error instanceof Error ? error.message : String(error)
      return { status: 'unavailable', valueUsd: null, summary: null, error: message }
    }
  },
} satisfies WalletVenue
