/** Query-string and JSON-body parsing for the Phoenix routes, with their 400 payloads (#831). */

import { OrderFlags, Side, baseLots } from '@ellipsis-labs/rise'
import type { Authority, BaseLots, Symbol as PhoenixSymbol } from '@ellipsis-labs/rise'
import type { Context } from 'hono'
import {
  asNonEmptyString,
  asRecordLoose,
  isNonNegativeInteger,
  normalizeVenueSymbol,
  parseFiniteJsonNumber,
  parseNonNegativeInteger,
  parseNullableNumber,
  parsePositiveInteger,
} from './parse.js'
import {
  parseOrderFlag,
  sdkAuthority,
  sdkPositionSideFromInput,
  sdkSideFromInput,
  sdkSymbol,
} from './sdk.js'
import type { PhoenixInstructionBuilderResult } from './types.js'

export const SOLANA_PUBLIC_KEY_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export function parseCandleLimit(input: string | undefined, maxLimit: number): number {
  const parsed = Number.parseInt(input ?? '100', 10)
  if (!Number.isFinite(parsed) || parsed < 1) return 100
  return Math.min(parsed, maxLimit)
}

export function appendOptionalQuery(params: URLSearchParams, name: string, value: string | undefined): void {
  if (value !== undefined && value.trim() !== '') params.set(name, value)
}

export function appendOptionalIntegerQuery(
  params: URLSearchParams,
  name: string,
  value: string | undefined,
): Response | null {
  if (value === undefined || value.trim() === '') return null
  const parsed = parseNonNegativeInteger(value)
  if (parsed === null) {
    return Response.json({ error: `Invalid ${name}`, code: 'INVALID_QUERY_PARAM', field: name }, { status: 400 })
  }
  params.set(name, String(parsed))
  return null
}

export async function readJsonRecord(c: Context): Promise<{ body: Record<string, unknown> } | { response: Response }> {
  let parsed: unknown
  try {
    parsed = await c.req.json()
  } catch {
    return { response: c.json({ error: 'Invalid JSON body', code: 'INVALID_JSON' }, 400) }
  }

  const body = !Array.isArray(parsed) ? asRecordLoose(parsed) : null
  if (!body) {
    return { response: c.json({ error: 'Expected JSON object body', code: 'INVALID_JSON_OBJECT' }, 400) }
  }

  return { body }
}

export function missingStringFields(body: Record<string, unknown>, fields: string[]): string[] {
  return fields.filter((field) => asNonEmptyString(body[field]) === null)
}

export function invalidNonNegativeIntegerFields(body: Record<string, unknown>, fields: string[]): string[] {
  return fields.filter((field) => !isNonNegativeInteger(body[field]))
}

export function missingFieldsPayload(fields: string[]) {
  return {
    error: 'Missing required fields',
    code: 'MISSING_REQUIRED_FIELDS',
    fields,
  }
}

export function invalidFieldsPayload(fields: string[]) {
  return {
    error: 'Invalid required fields',
    code: 'INVALID_REQUIRED_FIELDS',
    fields,
  }
}

export function instructionBuilderResponse(
  action: string,
  endpoint: string,
  raw: unknown,
): PhoenixInstructionBuilderResult {
  const rawRecord = asRecordLoose(raw)
  const instructions = Array.isArray(raw)
    ? raw
    : (Array.isArray(rawRecord?.instructions) ? rawRecord.instructions : [])
  const result: PhoenixInstructionBuilderResult = {
    venueId: 'phoenix',
    action,
    mode: 'solana_instruction_builder',
    endpoint,
    instructions,
    raw,
  }

  if (rawRecord && 'estimatedLiquidationPriceUsd' in rawRecord) {
    result.estimatedLiquidationPriceUsd = parseNullableNumber(rawRecord.estimatedLiquidationPriceUsd)
  }

  return result
}

export function parseUsdcAmountAtomic(input: unknown): bigint | null {
  if (typeof input !== 'string' && typeof input !== 'number') return null
  const text = String(input).trim()
  if (!/^\d+(\.\d{1,6})?$/.test(text)) return null

  const [whole, fraction = ''] = text.split('.')
  const atomic = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))
  return atomic > 0n ? atomic : null
}

export function parseAtomicAmount(input: unknown): bigint | null {
  if (typeof input !== 'string' && typeof input !== 'number') return null
  const text = String(input).trim()
  if (!/^\d+$/.test(text)) return null
  const atomic = BigInt(text)
  return atomic > 0n ? atomic : null
}

export function isBlankInput(input: unknown): boolean {
  return input === undefined || input === null || (typeof input === 'string' && input.trim() === '')
}

export function isPlausibleSolanaPublicKey(input: string): boolean {
  return SOLANA_PUBLIC_KEY_PATTERN.test(input.trim())
}

export function invalidPublicKeyPayload(field: string) {
  return {
    error: `Invalid ${field}`,
    code: field === 'authority' ? 'INVALID_AUTHORITY' : `INVALID_${field.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`,
    field,
  }
}

export function parseTransferBuilderInput(body: Record<string, unknown>): { input: Record<string, unknown>; response?: Response } {
  const authority = asNonEmptyString(body.authority)
  if (!authority) {
    return {
      input: {},
      response: Response.json({
        error: 'Missing required fields',
        code: 'MISSING_REQUIRED_FIELDS',
        fields: ['authority'],
      }, { status: 400 }),
    }
  }
  if (!isPlausibleSolanaPublicKey(authority)) {
    return {
      input: {},
      response: Response.json(invalidPublicKeyPayload('authority'), { status: 400 }),
    }
  }

  const amountSource = body.amountAtomic === undefined ? body.amount ?? body.amountUsdc : body.amountAtomic
  if (isBlankInput(amountSource)) {
    return {
      input: {},
      response: Response.json({
        error: 'Missing required fields',
        code: 'MISSING_REQUIRED_FIELDS',
        fields: ['amount'],
      }, { status: 400 }),
    }
  }

  const amount = body.amountAtomic === undefined
    ? parseUsdcAmountAtomic(amountSource)
    : parseAtomicAmount(amountSource)
  if (amount === null) {
    return {
      input: {},
      response: Response.json({ error: 'Invalid amount', code: 'INVALID_AMOUNT', field: 'amount' }, { status: 400 }),
    }
  }

  const input: Record<string, unknown> = {
    authority,
    amount,
  }

  const feePayer = asNonEmptyString(body.feePayer)
  if (feePayer) {
    if (!isPlausibleSolanaPublicKey(feePayer)) {
      return {
        input: {},
        response: Response.json(invalidPublicKeyPayload('feePayer'), { status: 400 }),
      }
    }
    input.feePayer = feePayer
  }

  const traderPdaIndex = body.traderPdaIndex ?? body.pdaIndex
  if (traderPdaIndex !== undefined) {
    const parsed = parseNonNegativeInteger(traderPdaIndex)
    if (parsed === null) {
      return {
        input: {},
        response: Response.json({ error: 'Invalid traderPdaIndex', code: 'INVALID_PDA_INDEX' }, { status: 400 }),
      }
    }
    input.traderPdaIndex = parsed
  }

  if (body.traderSubaccountIndex !== undefined) {
    const parsed = parseNonNegativeInteger(body.traderSubaccountIndex)
    if (parsed === null) {
      return {
        input: {},
        response: Response.json({ error: 'Invalid traderSubaccountIndex', code: 'INVALID_SUBACCOUNT_INDEX' }, { status: 400 }),
      }
    }
    input.traderSubaccountIndex = parsed
  }

  const permissionAddress = asNonEmptyString(body.permissionAddress)
  if (permissionAddress) {
    if (!isPlausibleSolanaPublicKey(permissionAddress)) {
      return {
        input: {},
        response: Response.json(invalidPublicKeyPayload('permissionAddress'), { status: 400 }),
      }
    }
    input.permissionAddress = permissionAddress
  }

  return { input }
}

export function parseOrderBuilderIndexes(body: Record<string, unknown>): {
  traderPdaIndex: number
  traderSubaccountIndex: number
} | { response: Response } {
  const traderPdaIndexInput = body.traderPdaIndex ?? body.pdaIndex
  const traderSubaccountIndexInput = body.traderSubaccountIndex ?? body.subaccountIndex

  const traderPdaIndex = traderPdaIndexInput === undefined ? 0 : parseNonNegativeInteger(traderPdaIndexInput)
  if (traderPdaIndex === null) {
    return { response: Response.json({ error: 'Invalid traderPdaIndex', code: 'INVALID_PDA_INDEX' }, { status: 400 }) }
  }

  const traderSubaccountIndex = traderSubaccountIndexInput === undefined ? 0 : parseNonNegativeInteger(traderSubaccountIndexInput)
  if (traderSubaccountIndex === null) {
    return { response: Response.json({ error: 'Invalid traderSubaccountIndex', code: 'INVALID_SUBACCOUNT_INDEX' }, { status: 400 }) }
  }

  return { traderPdaIndex, traderSubaccountIndex }
}

export function requireLimitPriceUsd(priceUsd: string | undefined): string {
  if (priceUsd === undefined) {
    throw new Error('Phoenix limit order builder: priceUsd is missing after body parsing (expected for kind=limit)')
  }
  return priceUsd
}

export function parseSdkOrderBuilderBody(body: Record<string, unknown>, kind: 'market' | 'limit'): {
  authority: Authority
  positionAuthority?: Authority
  symbol: PhoenixSymbol
  side: Side
  baseUnits: string
  priceUsd?: string
  priceLimitUsd?: string | null
  traderPdaIndex: number
  traderSubaccountIndex: number
  orderFlags: OrderFlags
} | { response: Response } {
  const authority = asNonEmptyString(body.authority)
  if (!authority) {
    return { response: Response.json(missingFieldsPayload(['authority']), { status: 400 }) }
  }
  if (!isPlausibleSolanaPublicKey(authority)) {
    return { response: Response.json(invalidPublicKeyPayload('authority'), { status: 400 }) }
  }

  const positionAuthority = asNonEmptyString(body.positionAuthority)
  if (positionAuthority && !isPlausibleSolanaPublicKey(positionAuthority)) {
    return { response: Response.json(invalidPublicKeyPayload('positionAuthority'), { status: 400 }) }
  }

  const symbol = normalizeVenueSymbol(asNonEmptyString(body.symbol))
  if (!symbol) {
    return { response: Response.json({ error: 'Invalid Phoenix market symbol', code: 'INVALID_MARKET_SYMBOL' }, { status: 400 }) }
  }

  const side = sdkSideFromInput(body.side)
  if (side === null) {
    return { response: Response.json({ error: 'Invalid side', code: 'INVALID_SIDE', field: 'side' }, { status: 400 }) }
  }

  const quantitySource = body.quantity ?? body.baseUnits ?? body.baseQuantity ?? body.numBaseUnits
  const quantity = parseFiniteJsonNumber(quantitySource)
  if (quantity === null || quantity <= 0) {
    return { response: Response.json({ error: 'Invalid quantity', code: 'INVALID_QUANTITY', field: 'quantity' }, { status: 400 }) }
  }

  const indexes = parseOrderBuilderIndexes(body)
  if ('response' in indexes) return indexes

  const orderFlags = parseOrderFlag(body.isReduceOnly ?? body.reduceOnly)
  const base = {
    authority: sdkAuthority(authority),
    positionAuthority: positionAuthority ? sdkAuthority(positionAuthority) : undefined,
    symbol: sdkSymbol(symbol),
    side,
    baseUnits: String(quantity),
    traderPdaIndex: indexes.traderPdaIndex,
    traderSubaccountIndex: indexes.traderSubaccountIndex,
    orderFlags,
  }

  if (kind === 'limit') {
    const price = parseFiniteJsonNumber(body.price ?? body.priceUsd)
    if (price === null || price <= 0) {
      return { response: Response.json({ error: 'Invalid price', code: 'INVALID_PRICE', field: 'price' }, { status: 400 }) }
    }
    return { ...base, priceUsd: String(price) }
  }

  const priceLimitSource = body.priceLimitUsd ?? body.limitPriceUsd ?? body.price ?? body.maxPriceUsd
  const priceLimit = isBlankInput(priceLimitSource) ? null : parseFiniteJsonNumber(priceLimitSource)
  if (priceLimitSource !== undefined && !isBlankInput(priceLimitSource) && (priceLimit === null || priceLimit <= 0)) {
    return { response: Response.json({ error: 'Invalid priceLimitUsd', code: 'INVALID_PRICE_LIMIT', field: 'priceLimitUsd' }, { status: 400 }) }
  }

  return { ...base, priceLimitUsd: priceLimit === null ? null : String(priceLimit) }
}

export function parsePositionConditionalOrderBody(body: Record<string, unknown>): {
  authority: Authority
  positionAuthority?: Authority
  symbol: PhoenixSymbol
  positionSide: 'long' | 'short'
  takeProfitPriceUsd: string | null
  stopLossPriceUsd: string | null
  baseUnits: string | null
  sizeBaseLots: BaseLots | null
  sizePercent: number | null
  traderPdaIndex: number
  traderSubaccountIndex: number
} | { response: Response } {
  const authority = asNonEmptyString(body.authority)
  if (!authority) {
    return { response: Response.json(missingFieldsPayload(['authority']), { status: 400 }) }
  }
  if (!isPlausibleSolanaPublicKey(authority)) {
    return { response: Response.json(invalidPublicKeyPayload('authority'), { status: 400 }) }
  }

  const positionAuthority = asNonEmptyString(body.positionAuthority)
  if (positionAuthority && !isPlausibleSolanaPublicKey(positionAuthority)) {
    return { response: Response.json(invalidPublicKeyPayload('positionAuthority'), { status: 400 }) }
  }

  const symbol = normalizeVenueSymbol(asNonEmptyString(body.symbol))
  if (!symbol) {
    return { response: Response.json({ error: 'Invalid Phoenix market symbol', code: 'INVALID_MARKET_SYMBOL' }, { status: 400 }) }
  }

  const positionSide = sdkPositionSideFromInput(body.positionSide ?? body.side)
  if (!positionSide) {
    return { response: Response.json({ error: 'Invalid positionSide', code: 'INVALID_POSITION_SIDE', field: 'positionSide' }, { status: 400 }) }
  }

  const takeProfitSource = body.takeProfitPriceUsd ?? body.takeProfitPrice ?? body.tpPrice ?? body.tp
  const stopLossSource = body.stopLossPriceUsd ?? body.stopLossPrice ?? body.slPrice ?? body.sl
  const takeProfitPrice = isBlankInput(takeProfitSource) ? null : parseFiniteJsonNumber(takeProfitSource)
  const stopLossPrice = isBlankInput(stopLossSource) ? null : parseFiniteJsonNumber(stopLossSource)

  if (takeProfitSource !== undefined && !isBlankInput(takeProfitSource) && (takeProfitPrice === null || takeProfitPrice <= 0)) {
    return { response: Response.json({ error: 'Invalid takeProfitPrice', code: 'INVALID_TAKE_PROFIT_PRICE', field: 'takeProfitPrice' }, { status: 400 }) }
  }
  if (stopLossSource !== undefined && !isBlankInput(stopLossSource) && (stopLossPrice === null || stopLossPrice <= 0)) {
    return { response: Response.json({ error: 'Invalid stopLossPrice', code: 'INVALID_STOP_LOSS_PRICE', field: 'stopLossPrice' }, { status: 400 }) }
  }
  if (takeProfitPrice === null && stopLossPrice === null) {
    return { response: Response.json({ error: 'Enter a take profit or stop loss price', code: 'MISSING_TRIGGER_PRICE' }, { status: 400 }) }
  }

  const baseUnitsSource = body.baseUnits ?? body.quantity ?? body.size
  const baseUnitsValue = isBlankInput(baseUnitsSource) ? null : parseFiniteJsonNumber(baseUnitsSource)
  if (baseUnitsSource !== undefined && !isBlankInput(baseUnitsSource) && (baseUnitsValue === null || baseUnitsValue <= 0)) {
    return { response: Response.json({ error: 'Invalid baseUnits', code: 'INVALID_BASE_UNITS', field: 'baseUnits' }, { status: 400 }) }
  }

  const sizeBaseLotsSource = body.sizeBaseLots ?? body.baseLots
  const sizeBaseLotsValue = isBlankInput(sizeBaseLotsSource) ? null : parsePositiveInteger(sizeBaseLotsSource)
  if (sizeBaseLotsSource !== undefined && !isBlankInput(sizeBaseLotsSource) && sizeBaseLotsValue === null) {
    return { response: Response.json({ error: 'Invalid sizeBaseLots', code: 'INVALID_SIZE_BASE_LOTS', field: 'sizeBaseLots' }, { status: 400 }) }
  }

  if (baseUnitsValue !== null && sizeBaseLotsValue !== null) {
    return { response: Response.json({ error: 'baseUnits and sizeBaseLots cannot both be set', code: 'DUPLICATE_SIZE_FIELD' }, { status: 400 }) }
  }

  const sizePercentSource = baseUnitsValue === null && sizeBaseLotsValue === null ? body.sizePercent ?? 100 : body.sizePercent
  const sizePercent = isBlankInput(sizePercentSource) ? null : parseNonNegativeInteger(sizePercentSource)
  if (sizePercent !== null && (sizePercent < 1 || sizePercent > 100)) {
    return { response: Response.json({ error: 'Invalid sizePercent', code: 'INVALID_SIZE_PERCENT', field: 'sizePercent' }, { status: 400 }) }
  }
  if ((baseUnitsValue !== null || sizeBaseLotsValue !== null) && sizePercent !== null) {
    return { response: Response.json({ error: 'Fixed size and sizePercent cannot both be set', code: 'DUPLICATE_SIZE_FIELD' }, { status: 400 }) }
  }

  const indexes = parseOrderBuilderIndexes(body)
  if ('response' in indexes) return indexes

  return {
    authority: sdkAuthority(authority),
    positionAuthority: positionAuthority ? sdkAuthority(positionAuthority) : undefined,
    symbol: sdkSymbol(symbol),
    positionSide,
    takeProfitPriceUsd: takeProfitPrice === null ? null : String(takeProfitPrice),
    stopLossPriceUsd: stopLossPrice === null ? null : String(stopLossPrice),
    baseUnits: baseUnitsValue === null ? null : String(baseUnitsValue),
    sizeBaseLots: sizeBaseLotsValue === null ? null : baseLots(sizeBaseLotsValue),
    sizePercent,
    traderPdaIndex: indexes.traderPdaIndex,
    traderSubaccountIndex: indexes.traderSubaccountIndex,
  }
}
