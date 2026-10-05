import Decimal from 'decimal.js'
import { MeteoraClientError } from './errors.js'
import {
  assertFinitePositiveDecimal,
  decimalToAtomicAmount,
  strategyToSdkValue,
} from './validation.js'
import type {
  MeteoraCreatePositionPreview,
  MeteoraCreatePositionRequest,
  MeteoraExecutionDefaults,
  MeteoraExecutionPoolState,
  MeteoraLimitOrderPreview,
  MeteoraLimitOrderRequest,
  MeteoraPreviewBase,
  MeteoraRangePresetDefinition,
  MeteoraRangeRequest,
  MeteoraSnappedRange,
  MeteoraTransactionPlanPreview,
  MeteoraZapInPreview,
  MeteoraZapInRequest,
} from './types.js'

/**
 * Confirmed against @meteora-ag/dlmm 1.9.13:
 * DEFAULT_BIN_PER_POSITION = 70 and MAX_BIN_PER_LIMIT_ORDER = 50.
 * The SDK's 1,400-bin extended-position ceiling is intentionally not exposed.
 */
export const METEORA_BETA_MAX_POSITION_BINS = 70
export const METEORA_MAX_LIMIT_ORDER_BINS = 50

export const METEORA_EXECUTION_DEFAULTS: Readonly<MeteoraExecutionDefaults> = Object.freeze({
  previewTtlMs: 30_000,
  liquiditySlippageBps: 100,
  swapSlippageBps: 100,
  maxActiveBinSlippage: 3,
  maxTransferAmountExtendPercentage: 5,
  maxAccounts: 30,
  favorXInActiveId: true,
})

export function resolveExecutionDefaults(
  overrides: Partial<MeteoraExecutionDefaults> = {},
): MeteoraExecutionDefaults {
  const defaults = { ...METEORA_EXECUTION_DEFAULTS, ...overrides }
  assertIntegerInRange(defaults.previewTtlMs, 'previewTtlMs', 5_000, 120_000)
  assertIntegerInRange(defaults.liquiditySlippageBps, 'liquiditySlippageBps', 0, 5_000)
  assertIntegerInRange(defaults.swapSlippageBps, 'swapSlippageBps', 0, 5_000)
  assertIntegerInRange(defaults.maxActiveBinSlippage, 'maxActiveBinSlippage', 0, 100)
  assertIntegerInRange(
    defaults.maxTransferAmountExtendPercentage,
    'maxTransferAmountExtendPercentage',
    0,
    100,
  )
  assertIntegerInRange(defaults.maxAccounts, 'maxAccounts', 1, 64)
  if (typeof defaults.favorXInActiveId !== 'boolean') {
    throw new MeteoraClientError('INVALID_ARGUMENT', 'favorXInActiveId must be a boolean')
  }
  return defaults
}

export function resolveMeteoraPreset(
  preset: MeteoraRangePresetDefinition,
): Extract<MeteoraRangeRequest, { kind: 'meteora_preset' }> {
  if (preset.source !== 'meteora' || preset.binDelta === null) {
    throw new MeteoraClientError(
      'PRESET_UNAVAILABLE',
      `${preset.label} is unavailable until Meteora supplies its exact bin delta`,
    )
  }
  assertIntegerInRange(
    preset.binDelta,
    `${preset.id}.binDelta`,
    0,
    Math.floor((METEORA_BETA_MAX_POSITION_BINS - 1) / 2),
  )
  return {
    kind: 'meteora_preset',
    binDelta: preset.binDelta,
    label: preset.label,
  }
}

/**
 * Exact bin snapping for UI display and local validation. Unlike executable
 * previews, this intentionally reports ranges wider than Meteora's 70-bin
 * create limit so the form can show the actual count and validation error.
 */
export interface MeteoraResolvedManualRange {
  requestedMinPrice: string
  requestedMaxPrice: string
  executableMinPrice: string
  executableMaxPrice: string
  minBinId: number
  maxBinId: number
  binCount: number
}

export function resolveManualRangeForDisplay(
  poolState: MeteoraExecutionPoolState,
  minPrice: string,
  maxPrice: string,
): MeteoraResolvedManualRange {
  assertPoolState(poolState)
  const requestedMinPrice = assertFinitePositiveDecimal(minPrice, 'range.minPrice')
  const requestedMaxPrice = assertFinitePositiveDecimal(maxPrice, 'range.maxPrice')
  if (requestedMinPrice.gte(requestedMaxPrice)) {
    throw new MeteoraClientError('INVALID_RANGE', 'Minimum price must be below maximum price')
  }
  const minBinId = binIdAtOrBelowPrice(poolState, requestedMinPrice)
  const maxBinId = binIdAtOrAbovePrice(poolState, requestedMaxPrice)
  if (minBinId > maxBinId) {
    throw new MeteoraClientError('INVALID_RANGE', 'The requested prices do not contain an executable bin')
  }
  return {
    requestedMinPrice: requestedMinPrice.toString(),
    requestedMaxPrice: requestedMaxPrice.toString(),
    executableMinPrice: priceForBin(poolState, minBinId).toString(),
    executableMaxPrice: priceForBin(poolState, maxBinId).toString(),
    minBinId,
    maxBinId,
    binCount: maxBinId - minBinId + 1,
  }
}

export function snapRangeToPoolState(
  poolState: MeteoraExecutionPoolState,
  request: MeteoraRangeRequest,
): MeteoraSnappedRange {
  assertPoolState(poolState)
  let minBinId: number
  let maxBinId: number
  let requestedMinPrice: Decimal
  let requestedMaxPrice: Decimal

  if (request.kind === 'meteora_preset') {
    assertIntegerInRange(
      request.binDelta,
      'range.binDelta',
      0,
      Math.floor((METEORA_BETA_MAX_POSITION_BINS - 1) / 2),
    )
    // Equivalent to Meteora's binDeltaToMinMaxBinId helper. The delta itself
    // must come from Meteora via resolveMeteoraPreset; we never invent one.
    minBinId = poolState.activeBinId - request.binDelta
    maxBinId = poolState.activeBinId + request.binDelta
    requestedMinPrice = priceForBin(poolState, minBinId)
    requestedMaxPrice = priceForBin(poolState, maxBinId)
  } else {
    const resolved = resolveManualRangeForDisplay(poolState, request.minPrice, request.maxPrice)
    requestedMinPrice = new Decimal(resolved.requestedMinPrice)
    requestedMaxPrice = new Decimal(resolved.requestedMaxPrice)
    minBinId = resolved.minBinId
    maxBinId = resolved.maxBinId
  }

  const binCount = maxBinId - minBinId + 1
  if (binCount > METEORA_BETA_MAX_POSITION_BINS) {
    throw new MeteoraClientError(
      'RANGE_TOO_WIDE',
      `Position range exceeds the ${METEORA_BETA_MAX_POSITION_BINS}-bin beta limit`,
    )
  }

  return {
    source: request.kind,
    requestedMinPrice: requestedMinPrice.toString(),
    requestedMaxPrice: requestedMaxPrice.toString(),
    executableMinPrice: priceForBin(poolState, minBinId).toString(),
    executableMaxPrice: priceForBin(poolState, maxBinId).toString(),
    minBinId,
    maxBinId,
    binCount,
  }
}

/**
 * Produces a range from already-resolved bin ids.  UI defaults use this for
 * one-sided positions so the active bin is an actual endpoint, rather than a
 * rounded display price that is snapped again later.
 */
export function rangeForPoolBins(
  poolState: MeteoraExecutionPoolState,
  minBinId: number,
  maxBinId: number,
): MeteoraSnappedRange {
  assertPoolState(poolState)
  if (!Number.isInteger(minBinId) || !Number.isInteger(maxBinId) || minBinId > maxBinId) {
    throw new MeteoraClientError('INVALID_RANGE', 'Position bins must define an ordered integer range')
  }
  const binCount = maxBinId - minBinId + 1
  if (binCount > METEORA_BETA_MAX_POSITION_BINS) {
    throw new MeteoraClientError(
      'RANGE_TOO_WIDE',
      `Position range exceeds the ${METEORA_BETA_MAX_POSITION_BINS}-bin beta limit`,
    )
  }
  const minPrice = priceForBin(poolState, minBinId).toString()
  const maxPrice = priceForBin(poolState, maxBinId).toString()
  return {
    source: 'manual',
    requestedMinPrice: minPrice,
    requestedMaxPrice: maxPrice,
    executableMinPrice: minPrice,
    executableMaxPrice: maxPrice,
    minBinId,
    maxBinId,
    binCount,
  }
}

/** Exact decimal price for a canonical bin, suitable for UI gesture recovery. */
export function priceForPoolBin(
  poolState: MeteoraExecutionPoolState,
  binId: number,
): string {
  assertPoolState(poolState)
  if (!Number.isInteger(binId)) {
    throw new MeteoraClientError('INVALID_RANGE', 'binId must be an integer')
  }
  return priceForBin(poolState, binId).toString()
}

export function createPositionPreview(
  poolState: MeteoraExecutionPoolState,
  request: MeteoraCreatePositionRequest,
  options: {
    defaults?: Partial<MeteoraExecutionDefaults>
    now?: Date
  } = {},
): MeteoraCreatePositionPreview {
  assertRequestPool(request.poolAddress, poolState)
  strategyToSdkValue(request.strategy)
  const range = snapRangeToPoolState(poolState, request.range)
  let tokenXAtomic: string
  let tokenYAtomic: string

  if (request.depositMode === 'two_token') {
    tokenXAtomic = decimalToAtomicAmount(
      request.tokenXAmount,
      poolState.tokenX.decimals,
      'tokenXAmount',
    )
    tokenYAtomic = decimalToAtomicAmount(
      request.tokenYAmount,
      poolState.tokenY.decimals,
      'tokenYAmount',
    )
    if (range.minBinId > poolState.activeBinId || range.maxBinId < poolState.activeBinId) {
      throw new MeteoraClientError(
        'INVALID_DEPOSIT_COMBINATION',
        'A two-token position range must include the current active bin',
      )
    }
  } else {
    const amount = request.amount
    if (request.inputToken === 'x') {
      tokenXAtomic = decimalToAtomicAmount(amount, poolState.tokenX.decimals, 'amount')
      tokenYAtomic = '0'
      if (range.maxBinId < poolState.activeBinId) {
        throw new MeteoraClientError(
          'INVALID_DEPOSIT_COMBINATION',
          `A ${poolState.tokenX.symbol}-only position range must overlap the active bin or bins above it`,
        )
      }
    } else {
      tokenXAtomic = '0'
      tokenYAtomic = decimalToAtomicAmount(amount, poolState.tokenY.decimals, 'amount')
      if (range.minBinId > poolState.activeBinId) {
        throw new MeteoraClientError(
          'INVALID_DEPOSIT_COMBINATION',
          `A ${poolState.tokenY.symbol}-only position range must overlap the active bin or bins below it`,
        )
      }
    }
  }

  const payload = {
    kind: 'create_position' as const,
    request,
    poolState,
    defaults: resolveExecutionDefaults(options.defaults),
    strategy: request.strategy,
    range,
    amounts: { tokenXAtomic, tokenYAtomic },
    depositMode: request.depositMode,
  }
  const base = createPreviewBase(payload, options.now)
  return {
    ...payload,
    ...base,
    transactionPlan: oneStepPreview('create_position', 'Create position and add liquidity'),
  }
}

export function createLimitOrderPreview(
  poolState: MeteoraExecutionPoolState,
  request: MeteoraLimitOrderRequest,
  options: {
    defaults?: Partial<MeteoraExecutionDefaults>
    now?: Date
  } = {},
): MeteoraLimitOrderPreview {
  assertRequestPool(request.poolAddress, poolState)
  const price = assertFinitePositiveDecimal(request.price, 'price')
  const binId = nearestBinForPrice(poolState, price)
  if (request.side === 'buy' && binId >= poolState.activeBinId) {
    throw new MeteoraClientError('INVALID_LIMIT_ORDER', 'A buy limit price must be below the current price')
  }
  if (request.side === 'sell' && binId <= poolState.activeBinId) {
    throw new MeteoraClientError('INVALID_LIMIT_ORDER', 'A sell limit price must be above the current price')
  }

  const inputToken: 'x' | 'y' = request.side === 'buy' ? 'y' : 'x'
  const token = inputToken === 'x' ? poolState.tokenX : poolState.tokenY
  const inputTokenAtomic = decimalToAtomicAmount(request.amount, token.decimals, 'amount')
  const payload = {
    kind: 'limit_order' as const,
    request,
    poolState,
    defaults: resolveExecutionDefaults(options.defaults),
    side: request.side,
    inputToken,
    inputTokenAtomic,
    requestedPrice: price.toString(),
    executablePrice: priceForBin(poolState, binId).toString(),
    binId,
    relativeBinId: binId - poolState.activeBinId,
    protocolMaxBins: METEORA_MAX_LIMIT_ORDER_BINS,
    estimatedFullFillOutput: request.side === 'buy'
      ? new Decimal(request.amount).div(priceForBin(poolState, binId)).toString()
      : new Decimal(request.amount).mul(priceForBin(poolState, binId)).toString(),
  }
  const base = createPreviewBase(payload, options.now)
  return {
    ...payload,
    ...base,
    transactionPlan: oneStepPreview('place_limit_order', `Place ${request.side} limit order`),
  }
}

export function createZapInPreview(
  poolState: MeteoraExecutionPoolState,
  request: MeteoraZapInRequest,
  options: {
    defaults?: Partial<MeteoraExecutionDefaults>
    now?: Date
    estimate?: MeteoraZapInPreview['estimate']
  } = {},
): MeteoraZapInPreview {
  assertRequestPool(request.poolAddress, poolState)
  strategyToSdkValue(request.strategy)
  const range = snapRangeToPoolState(poolState, request.range)
  const token = request.inputToken === 'x' ? poolState.tokenX : poolState.tokenY
  const inputTokenAtomic = decimalToAtomicAmount(request.amount, token.decimals, 'amount')
  const payload = {
    kind: 'zap_in' as const,
    request,
    poolState,
    defaults: resolveExecutionDefaults(options.defaults),
    strategy: request.strategy,
    range,
    inputToken: request.inputToken,
    inputTokenAtomic,
    estimate: options.estimate ?? null,
  }
  const base = createPreviewBase(payload, options.now)
  return {
    ...payload,
    ...base,
    transactionPlan: {
      action: 'zap_in',
      expectedSteps: [
        { id: 'setup', kind: 'setup', label: 'Prepare token accounts' },
        { id: 'swap', kind: 'swap', label: 'Balance pool tokens' },
        { id: 'ledger', kind: 'ledger', label: 'Record Zap balances' },
        { id: 'execute', kind: 'execute', label: 'Create position and add liquidity' },
        { id: 'cleanup', kind: 'cleanup', label: 'Close temporary accounts' },
      ],
    },
  }
}

export function assertPreviewUsable(
  preview: MeteoraCreatePositionPreview | MeteoraLimitOrderPreview | MeteoraZapInPreview,
  now = new Date(),
): void {
  const expectedHash = hashCanonical(previewIntegrityPayload(preview))
  if (preview.inputHash !== expectedHash || preview.previewId !== previewId(expectedHash, preview.expiresAt)) {
    throw new MeteoraClientError('PREVIEW_INPUT_CHANGED', 'Preview inputs changed after validation')
  }
  const expiresAt = Date.parse(preview.expiresAt)
  if (!Number.isFinite(expiresAt) || now.getTime() >= expiresAt) {
    throw new MeteoraClientError('PREVIEW_EXPIRED', 'Preview expired; refresh prices and try again')
  }
}

export function assertPoolStateCompatible(
  preview: MeteoraCreatePositionPreview | MeteoraLimitOrderPreview | MeteoraZapInPreview,
  freshState: MeteoraExecutionPoolState,
): void {
  if (preview.poolState.poolAddress !== freshState.poolAddress) {
    throw new MeteoraClientError('POOL_STATE_CHANGED', 'The refreshed pool does not match this preview')
  }
  const delta = Math.abs(preview.poolState.activeBinId - freshState.activeBinId)
  if (delta > preview.defaults.maxActiveBinSlippage) {
    throw new MeteoraClientError(
      'POOL_STATE_CHANGED',
      `Pool moved ${delta} bins; refresh the preview before signing`,
    )
  }
}

function createPreviewBase(
  payload: Record<string, unknown>,
  now = new Date(),
): MeteoraPreviewBase {
  const createdAtMs = now.getTime()
  if (!Number.isFinite(createdAtMs)) {
    throw new MeteoraClientError('INVALID_ARGUMENT', 'Preview time is invalid')
  }
  const defaults = payload.defaults as MeteoraExecutionDefaults
  const createdAt = now.toISOString()
  const expiresAt = new Date(createdAtMs + defaults.previewTtlMs).toISOString()
  const inputHash = hashCanonical(payload)
  return {
    schemaVersion: 1,
    previewId: previewId(inputHash, expiresAt),
    inputHash,
    createdAt,
    expiresAt,
    poolState: payload.poolState as MeteoraExecutionPoolState,
    defaults,
  }
}

function previewIntegrityPayload(
  preview: MeteoraCreatePositionPreview | MeteoraLimitOrderPreview | MeteoraZapInPreview,
): Record<string, unknown> {
  const {
    schemaVersion: _schemaVersion,
    previewId: _previewId,
    inputHash: _inputHash,
    createdAt: _createdAt,
    expiresAt: _expiresAt,
    transactionPlan: _transactionPlan,
    ...payload
  } = preview
  return payload
}

function previewId(inputHash: string, expiresAt: string): string {
  return `meteora_${inputHash}_${Date.parse(expiresAt).toString(36)}`
}

function oneStepPreview(
  action: MeteoraTransactionPlanPreview['action'],
  label: string,
): MeteoraTransactionPlanPreview {
  return {
    action,
    expectedSteps: [{ id: 'execute', kind: 'execute', label }],
  }
}

function assertRequestPool(poolAddress: string, state: MeteoraExecutionPoolState): void {
  if (poolAddress !== state.poolAddress) {
    throw new MeteoraClientError('INVALID_ARGUMENT', 'Request pool does not match refreshed pool state')
  }
}

function assertPoolState(state: MeteoraExecutionPoolState): void {
  if (!Number.isInteger(state.activeBinId)) {
    throw new MeteoraClientError('INVALID_ARGUMENT', 'activeBinId must be an integer')
  }
  assertIntegerInRange(state.binStep, 'binStep', 1, 10_000)
  assertFinitePositiveDecimal(state.activePrice, 'activePrice')
}

function assertIntegerInRange(value: number, field: string, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new MeteoraClientError('INVALID_ARGUMENT', `${field} must be an integer between ${min} and ${max}`)
  }
}

function binIdAtOrAbovePrice(state: MeteoraExecutionPoolState, price: Decimal): number {
  return state.activeBinId + Math.ceil(relativeBin(state, price) - Number.EPSILON)
}

function binIdAtOrBelowPrice(state: MeteoraExecutionPoolState, price: Decimal): number {
  return state.activeBinId + Math.floor(relativeBin(state, price) + Number.EPSILON)
}

function nearestBinForPrice(state: MeteoraExecutionPoolState, price: Decimal): number {
  return state.activeBinId + Math.round(relativeBin(state, price))
}

// Meteora's API snapshots active prices through JS numeric serialization. A
// canonical neighbour can therefore arrive ~2.4e-13 bins from its integer.
// This tolerance is still one millionth of a bin, so manual off-grid prices
// retain their required outward floor/ceiling snapping.
const SDK_PRICE_GRID_TOLERANCE_BINS = new Decimal('0.000000001')

function relativeBin(state: MeteoraExecutionPoolState, price: Decimal): number {
  const activePrice = new Decimal(state.activePrice)
  const step = new Decimal(1).plus(new Decimal(state.binStep).div(10_000))
  const relative = price.div(activePrice).ln().div(step.ln())
  const nearest = relative.toNearest(1)
  const normalized = relative.minus(nearest).abs().lte(SDK_PRICE_GRID_TOLERANCE_BINS)
    ? nearest
    : relative
  const delta = normalized.toNumber()
  if (!Number.isFinite(delta)) {
    throw new MeteoraClientError('INVALID_RANGE', 'Price is outside the supported bin range')
  }
  return delta
}

function priceForBin(state: MeteoraExecutionPoolState, binId: number): Decimal {
  const step = new Decimal(1).plus(new Decimal(state.binStep).div(10_000))
  return new Decimal(state.activePrice).mul(step.pow(binId - state.activeBinId))
}

function hashCanonical(value: unknown): string {
  const input = canonicalJson(value)
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, '0')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}
