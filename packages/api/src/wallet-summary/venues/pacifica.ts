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
import type { AppSummary, PacificaSummary, PerpPositionsResponse, WalletPerpPosition, WalletPerpPositionDetail } from '@myboon/shared/wallet-summary'
import { pacificaUnrealizedPnl, safeNum } from '@myboon/shared/wallet-summary'
import { PacificaApiError, pacificaGetJson } from '../../pacifica/client.js'
import { notConnectedApp, type WalletFetchContext, type WalletVenue } from '../service.js'

// The upstream answers for accounts that never traded / never existed.
interface RawAccountInfo {
  account_equity?: string
  available_to_spend?: string
}

export interface RawPosition {
  symbol: string
  side: 'bid' | 'ask'
  amount: string
  entry_price: string
}

export interface RawPriceInfo {
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

/**
 * One row per open position in the same shape as Phoenix's position detail
 * (#868). Entry, side, size and mark come from the same raw answers the
 * summary reads, and `unrealizedPnlUsd` is computed exactly as the summary
 * does (mark falls back to entry), so the two numbers always match. The
 * Pacifica answers used here carry no leverage, liquidation, TP/SL or trader
 * index: those are null. Sorted by |valueUsd| descending, null counting as 0.
 */
export function toPacificaPositionDetails(positions: RawPosition[], prices: RawPriceInfo[]): WalletPerpPositionDetail[] {
  const markBySymbol = new Map(prices.map((price) => [price.symbol, safeNum(price.mark)]))
  const rows = positions.map((position) => {
    const entry = safeNum(position.entry_price)
    const mark = markBySymbol.get(position.symbol) ?? null
    const size = safeNum(position.amount)
    const direction = position.side === 'bid' ? 1 : -1
    const unrealizedPnlUsd = pacificaUnrealizedPnl(entry, mark ?? entry, size, direction)
    const divisor = entry * size
    const valueUsd = mark !== null ? mark * size : null
    const detail: WalletPerpPositionDetail = {
      symbol: position.symbol,
      side: direction === 1 ? 'long' : 'short',
      size,
      leverage: null,
      valueUsd,
      entryPriceUsd: entry,
      markPriceUsd: mark,
      liquidationPriceUsd: null,
      unrealizedPnlUsd,
      pnlPct: divisor !== 0 ? (unrealizedPnlUsd / divisor) * 100 : null,
      takeProfitPriceUsd: null,
      stopLossPriceUsd: null,
      traderPdaIndex: null,
      traderSubaccountIndex: null,
    }
    return detail
  })
  return rows.sort((a, b) => Math.abs(b.valueUsd ?? 0) - Math.abs(a.valueUsd ?? 0))
}

/**
 * The reader behind GET /wallet/pacifica/positions (#868): the summary's
 * three upstream calls (account, positions, prices) through
 * toPacificaPositionDetails. No address = not connected, with no upstream
 * call; no Pacifica account (404) = ok and empty, as the summary answers.
 * Never throws: any other upstream failure (429 included) answers
 * `unavailable`.
 */
export async function fetchPacificaPositions(solana: string | null): Promise<PerpPositionsResponse> {
  if (!solana) return { status: 'not_connected', positions: [] }
  try {
    await pacificaGetJson<RawAccountInfo>(`/account?account=${encodeURIComponent(solana)}`)
    const [positions, prices] = await Promise.all([
      pacificaGetJson<RawPosition[]>(`/positions?account=${encodeURIComponent(solana)}`),
      pacificaGetJson<RawPriceInfo[]>('/info/prices'),
    ])
    return { status: 'ok', positions: toPacificaPositionDetails(positions, prices) }
  } catch (error) {
    if (error instanceof PacificaApiError && error.status === 404) return { status: 'ok', positions: [] }
    console.error('[api] wallet-pacifica-positions failed:', error)
    return { status: 'unavailable', positions: [], error: 'pacifica_positions_failed' }
  }
}
