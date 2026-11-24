/** Folds the v1 trader-state trigger rows into the legacy trader-state answer (#831). */

import {
  asRecord,
  asString,
  normalizeVenueSymbol,
  parseNullableInt,
  parseNullableNumber,
} from './parse.js'
import type { PhoenixPositionTriggerEnrichment } from './types.js'

export function triggerRecordPriceUsd(triggerRecord: Record<string, unknown>, positionRecord: Record<string, unknown>): number | null {
  const trigger = asRecord(triggerRecord.trigger)
  if (!trigger) return null

  const directPrice = parseNullableNumber(
    trigger.triggerPriceUsd ?? trigger.priceUsd ?? trigger.triggerPrice ?? trigger.price,
  )
  if (directPrice !== null) return directPrice

  const triggerTicks = parseNullableNumber(trigger.triggerPriceTicks)
  if (triggerTicks === null) return null

  const entryTicks = parseNullableNumber(positionRecord.entryPriceTicks)
  const entryUsd = parseNullableNumber(positionRecord.entryPriceUsd)
  const tickDivisor = entryTicks !== null && entryUsd !== null && entryUsd > 0
    ? entryTicks / entryUsd
    : 1000

  return tickDivisor > 0 ? triggerTicks / tickDivisor : null
}

export function activeTriggerRows(input: unknown): Record<string, unknown>[] {
  if (!Array.isArray(input)) return []

  return input
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => {
      if (!item) return false
      const status = asString(item.status)?.toLowerCase()
      return status === null || status === 'active' || status === 'open'
    })
}

export function enrichTriggerPriceRows(rows: Record<string, unknown>[], positionRecord: Record<string, unknown>): unknown[] {
  return rows.map((row) => {
    const trigger = asRecord(row.trigger)
    const triggerPriceUsd = triggerRecordPriceUsd(row, positionRecord)

    if (!trigger || triggerPriceUsd === null) {
      return row
    }

    return {
      ...row,
      trigger: {
        ...trigger,
        triggerPriceUsd,
      },
    }
  })
}

export function firstTriggerPriceUsd(rows: Record<string, unknown>[], positionRecord: Record<string, unknown>): number | null {
  for (const row of rows) {
    const price = triggerRecordPriceUsd(row, positionRecord)
    if (price !== null) return price
  }

  return null
}

export function syntheticOrderFromTrigger(
  symbol: string,
  kind: 'take_profit' | 'stop_loss',
  row: Record<string, unknown>,
  positionRecord: Record<string, unknown>,
): Record<string, unknown> | null {
  const trigger = asRecord(row.trigger)
  if (!trigger) return null

  const price = triggerRecordPriceUsd(row, positionRecord)
  if (price === null) return null

  const positionLots = Math.abs(parseNullableNumber(positionRecord.basePositionLots) ?? 0)
  const positionDecimals = parseNullableInt(positionRecord.baseLotsDecimals) ?? 2
  const sizeUi = positionLots > 0
    ? positionLots / (10 ** positionDecimals)
    : parseNullableNumber(asRecord(positionRecord.positionSize)?.ui)
  const percent = parseNullableNumber(trigger.percent)
  const id = asString(row.conditionalTakeProfitId)
    ?? asString(row.conditionalStopLossId)
    ?? asString(row.orderId)
    ?? `${symbol}-${kind}-${price}`
  const cancelMeta = conditionalTriggerCancelMeta(row, id)

  return {
    orderSequenceNumber: id,
    symbol,
    side: asString(trigger.side),
    price,
    triggerPrice: price,
    tradeSizeRemaining: sizeUi === null ? null : { value: sizeUi, decimals: 0, ui: String(sizeUi) },
    initialTradeSize: sizeUi === null ? null : { value: sizeUi, decimals: 0, ui: String(sizeUi) },
    isReduceOnly: true,
    isConditionalOrder: true,
    conditionalOrderKind: kind,
    conditionalOrderIndex: cancelMeta.conditionalOrderIndex,
    executionDirection: cancelMeta.executionDirection,
    status: asString(row.status) ?? 'active',
    percent,
    raw: row,
  }
}

export function conditionalTriggerCancelMeta(
  row: Record<string, unknown>,
  id: string,
): { conditionalOrderIndex: number | null; executionDirection: string | null } {
  const directIndex = parseNullableInt(row.conditionalOrderIndex ?? row.index)
  const directDirection = asString(row.executionDirection ?? row.triggerDirection)
  if (directIndex !== null && directDirection !== null) {
    return { conditionalOrderIndex: directIndex, executionDirection: directDirection }
  }

  const match = id.match(/-(\d+)-(gt|lt)$/i)
  return {
    conditionalOrderIndex: directIndex ?? (match ? Number.parseInt(match[1], 10) : null),
    executionDirection: directDirection ?? (match ? match[2].toLowerCase() : null),
  }
}

export function buildPhoenixTriggerEnrichment(v1Raw: unknown): Map<string, PhoenixPositionTriggerEnrichment> {
  const result = new Map<string, PhoenixPositionTriggerEnrichment>()
  const v1Record = asRecord(v1Raw)
  const snapshot = asRecord(v1Record?.snapshot)
  const subaccounts = Array.isArray(snapshot?.subaccounts) ? snapshot.subaccounts : []

  for (const rawSubaccount of subaccounts) {
    const subaccount = asRecord(rawSubaccount)
    if (!subaccount) continue

    const subaccountIndex = parseNullableInt(subaccount.subaccountIndex) ?? 0
    const positions = Array.isArray(subaccount.positions) ? subaccount.positions : []

    for (const rawPosition of positions) {
      const position = asRecord(rawPosition)
      const venueSymbol = normalizeVenueSymbol(asString(position?.symbol))
      if (!position || !venueSymbol) continue

      const takeProfitRows = activeTriggerRows(position.takeProfitTriggers)
      const stopLossRows = activeTriggerRows(position.stopLossTriggers)
      const conditionalTakeProfitRows = activeTriggerRows(position.conditionalTakeProfitTriggers)
      const conditionalStopLossRows = activeTriggerRows(position.conditionalStopLossTriggers)
      const allTakeProfitRows = [...conditionalTakeProfitRows, ...takeProfitRows]
      const allStopLossRows = [...conditionalStopLossRows, ...stopLossRows]
      const syntheticOrders = [
        ...allTakeProfitRows.map((row) => syntheticOrderFromTrigger(venueSymbol, 'take_profit', row, position)),
        ...allStopLossRows.map((row) => syntheticOrderFromTrigger(venueSymbol, 'stop_loss', row, position)),
      ].filter((order): order is Record<string, unknown> => order !== null)

      result.set(`${subaccountIndex}:${venueSymbol}`, {
        takeProfitPrice: firstTriggerPriceUsd(allTakeProfitRows, position),
        stopLossPrice: firstTriggerPriceUsd(allStopLossRows, position),
        takeProfitTriggers: enrichTriggerPriceRows(takeProfitRows, position),
        stopLossTriggers: enrichTriggerPriceRows(stopLossRows, position),
        conditionalTakeProfitTriggers: enrichTriggerPriceRows(conditionalTakeProfitRows, position),
        conditionalStopLossTriggers: enrichTriggerPriceRows(conditionalStopLossRows, position),
        syntheticOrders,
      })
    }
  }

  return result
}

export function mergePhoenixTraderState(raw: unknown, v1Raw: unknown | null): { traders: unknown[]; triggerSource: 'v1' | 'legacy' } {
  const rawRecord = asRecord(raw)
  const traders = Array.isArray(rawRecord?.traders) ? rawRecord.traders : []
  if (!v1Raw) return { traders, triggerSource: 'legacy' }

  const enrichment = buildPhoenixTriggerEnrichment(v1Raw)
  if (enrichment.size === 0) return { traders, triggerSource: 'legacy' }

  const enrichedTraders = traders.map((rawTrader) => {
    const trader = asRecord(rawTrader)
    if (!trader) return rawTrader

    const traderSubaccountIndex = parseNullableInt(trader.traderSubaccountIndex) ?? 0
    const positions = Array.isArray(trader.positions)
      ? trader.positions.map((rawPosition) => {
        const position = asRecord(rawPosition)
        const venueSymbol = normalizeVenueSymbol(asString(position?.symbol))
        const trigger = venueSymbol ? enrichment.get(`${traderSubaccountIndex}:${venueSymbol}`) : undefined
        if (!position || !trigger) return rawPosition

        return {
          ...position,
          takeProfitPrice: position.takeProfitPrice ?? trigger.takeProfitPrice,
          stopLossPrice: position.stopLossPrice ?? trigger.stopLossPrice,
          takeProfitTriggers: trigger.takeProfitTriggers,
          stopLossTriggers: trigger.stopLossTriggers,
          conditionalTakeProfitTriggers: trigger.conditionalTakeProfitTriggers,
          conditionalStopLossTriggers: trigger.conditionalStopLossTriggers,
        }
      })
      : trader.positions

    const limitOrders = asRecord(trader.limitOrders) ? { ...asRecord(trader.limitOrders) } : {}
    for (const [key, trigger] of enrichment.entries()) {
      const [subaccountIndex, venueSymbol] = key.split(':')
      if (Number(subaccountIndex) !== traderSubaccountIndex || trigger.syntheticOrders.length === 0) continue

      const existing = Array.isArray(limitOrders[venueSymbol]) ? limitOrders[venueSymbol] as unknown[] : []
      const existingIds = new Set(
        existing
          .map((order) => asString(asRecord(order)?.orderSequenceNumber))
          .filter((id): id is string => id !== null),
      )
      const newOrders = trigger.syntheticOrders.filter((order) => {
        const id = asString(asRecord(order)?.orderSequenceNumber)
        return id === null || !existingIds.has(id)
      })
      limitOrders[venueSymbol] = [...existing, ...newOrders]
    }

    return { ...trader, positions, limitOrders }
  })

  return { traders: enrichedTraders, triggerSource: 'v1' }
}
