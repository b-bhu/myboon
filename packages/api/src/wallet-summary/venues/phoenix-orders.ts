/**
 * Phoenix take-profit and stop-loss orders (#900), behind
 * GET /wallet/phoenix/orders. Reads the same trader state the summary and
 * the positions route read (pdaIndex 0, the primary account). The state
 * reader already folds the v1 TP/SL triggers into each trader's
 * `limitOrders[symbol]` as synthetic rows (`mergePhoenixTraderState`):
 * only those rows (`isConditionalOrder` with a `conditionalOrderKind` of
 * `take_profit` or `stop_loss`) are listed; plain limit orders are ignored.
 */
import type { PhoenixOrdersResponse, PhoenixTraderRecord, WalletPhoenixOrder } from '@myboon/shared/wallet-summary'
import { toNumber, toUsd } from '@myboon/shared/wallet-summary'
import { asRecord, asString } from '@myboon/shared/guards'
import { getPhoenixTraderState, type PhoenixUpstream } from '../../phoenix/index.js'

type OrderKind = WalletPhoenixOrder['kind']

/** The open position on a trader for a symbol (non-zero `positionSize`), as side, |size| and entry. */
function findPosition(trader: PhoenixTraderRecord, symbol: string) {
  const positions = Array.isArray(trader.positions) ? trader.positions : []
  for (const item of positions) {
    const record = asRecord(item)
    if (!record) continue
    const positionSymbol = typeof record.symbol === 'string' ? record.symbol.trim() : null
    const size = toNumber(record.positionSize)
    if (positionSymbol !== symbol.trim() || size === null || size === 0) continue
    return {
      side: size > 0 ? ('long' as const) : ('short' as const),
      size: Math.abs(size),
      entryPriceUsd: toUsd(record.entryPrice),
    }
  }
  return null
}

/**
 * One row per active conditional take-profit or stop-loss order across
 * traders, each joined to the open position it protects (same trader, same
 * symbol). Sorted by symbol ascending, take profit before stop loss. A field
 * the upstream does not give is null.
 */
export function toPhoenixOrders(traders: PhoenixTraderRecord[]): WalletPhoenixOrder[] {
  const rows: WalletPhoenixOrder[] = []

  for (const [traderIndex, trader] of traders.entries()) {
    const limitOrders = asRecord(trader.limitOrders)
    if (!limitOrders) continue
    const traderPdaIndex = toNumber(trader.traderPdaIndex) ?? traderIndex
    const traderSubaccountIndex = toNumber(trader.traderSubaccountIndex) ?? 0

    for (const [symbol, rawOrders] of Object.entries(limitOrders)) {
      if (!Array.isArray(rawOrders)) continue
      const position = findPosition(trader, symbol)
      for (const [orderIndex, rawOrder] of rawOrders.entries()) {
        const order = asRecord(rawOrder)
        if (!order || order.isConditionalOrder !== true) continue
        const kind = order.conditionalOrderKind
        if (kind !== 'take_profit' && kind !== 'stop_loss') continue

        const triggerPriceUsd = toUsd(order.triggerPrice ?? order.price)
        const conditionalOrderIndex = toNumber(order.conditionalOrderIndex)
        const executionDirection = asString(order.executionDirection)
        const entryPriceUsd = position?.entryPriceUsd ?? null
        const pnlAtTriggerUsd =
          position && triggerPriceUsd !== null && entryPriceUsd !== null
            ? (triggerPriceUsd - entryPriceUsd) * position.size * (position.side === 'long' ? 1 : -1)
            : null

        rows.push({
          // The state reader always sets orderSequenceNumber; the fallback
          // only keeps an id unique if a row ever lacks it.
          id: asString(order.orderSequenceNumber) ?? `${symbol}-${kind}-${orderIndex}`,
          symbol,
          kind,
          triggerPriceUsd,
          positionSide: position?.side ?? null,
          size: position?.size ?? null,
          entryPriceUsd,
          pnlAtTriggerUsd,
          conditionalOrderIndex,
          executionDirection,
          // The phone's rule: both cancel keys are present.
          canCancel: conditionalOrderIndex !== null && executionDirection !== null,
          traderPdaIndex,
          traderSubaccountIndex,
        })
      }
    }
  }

  const kindRank = (kind: OrderKind) => (kind === 'take_profit' ? 0 : 1)
  rows.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : kindRank(a.kind) - kindRank(b.kind)))
  return rows
}

/**
 * The reader behind GET /wallet/phoenix/orders: trader state (pdaIndex 0)
 * through toPhoenixOrders. No address = not connected, with no upstream
 * call. Never throws: a failed trader-state call (429 included) answers
 * `unavailable`.
 */
export function createPhoenixOrdersReader(upstream: PhoenixUpstream) {
  return async function readPhoenixOrders(solana: string | null): Promise<PhoenixOrdersResponse> {
    if (!solana) return { status: 'not_connected', orders: [] }
    try {
      const result = await getPhoenixTraderState(upstream, solana, '0')
      if (result.status !== 200) {
        throw new Error(`Phoenix trader state unavailable (${result.status}): ${result.body.error}`)
      }
      const traders = result.body.traders
        .map(asRecord)
        .filter((record): record is PhoenixTraderRecord => record !== null)
      return { status: 'ok', orders: toPhoenixOrders(traders) }
    } catch (error) {
      console.error('[api] wallet-phoenix-orders failed:', error)
      return { status: 'unavailable', orders: [], error: 'phoenix_orders_failed' }
    }
  }
}
