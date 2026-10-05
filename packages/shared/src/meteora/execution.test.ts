import assert from 'node:assert/strict'
import Decimal from 'decimal.js'
import { MeteoraClientError } from './errors.js'
import {
  METEORA_BETA_MAX_POSITION_BINS,
  METEORA_MAX_LIMIT_ORDER_BINS,
  assertPoolStateCompatible,
  assertPreviewUsable,
  createLimitOrderPreview,
  createPositionPreview,
  createZapInPreview,
  resolveExecutionDefaults,
  resolveMeteoraPreset,
  resolveManualRangeForDisplay,
  snapRangeToPoolState,
} from './execution.js'
import {
  SOLANA_U64_MAX,
  assertAtomicAmount,
  assertPositiveAtomicAmount,
  decimalToAtomicAmount,
} from './validation.js'
import type { MeteoraExecutionPoolState } from './types.js'

const NOW = new Date('2026-07-16T10:00:00.000Z')
const state: MeteoraExecutionPoolState = {
  poolAddress: '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6',
  activeBinId: 1_000,
  activePrice: '100',
  binStep: 100,
  tokenX: {
    address: 'So11111111111111111111111111111111111111112',
    symbol: 'SOL',
    decimals: 9,
  },
  tokenY: {
    address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'USDC',
    decimals: 6,
  },
  refreshedAt: NOW.toISOString(),
}

function throwsCode(code: MeteoraClientError['code'], fn: () => unknown): void {
  assert.throws(
    fn,
    (error) => error instanceof MeteoraClientError && error.code === code,
    `Expected ${code}`,
  )
}

function priceAt(relativeBin: number): string {
  return new Decimal(state.activePrice)
    .mul(new Decimal(1.01).pow(relativeBin))
    .toString()
}

function testDecimalBoundaries(): void {
  assert.equal(decimalToAtomicAmount('1', 9, 'amount'), '1000000000')
  assert.equal(decimalToAtomicAmount('0.000000001', 9, 'amount'), '1')
  assert.equal(decimalToAtomicAmount(SOLANA_U64_MAX.toString(), 0, 'amount'), SOLANA_U64_MAX.toString())
  assert.equal(assertAtomicAmount('0', 'amount'), '0')
  assert.equal(assertPositiveAtomicAmount('1', 'amount'), '1')

  throwsCode('EMPTY_AMOUNT', () => decimalToAtomicAmount('', 9, 'amount'))
  throwsCode('AMOUNT_NOT_POSITIVE', () => decimalToAtomicAmount('0', 9, 'amount'))
  throwsCode('AMOUNT_NOT_POSITIVE', () => decimalToAtomicAmount('0.000000000', 9, 'amount'))
  throwsCode('AMOUNT_FORMAT_INVALID', () => decimalToAtomicAmount('-1', 9, 'amount'))
  throwsCode('AMOUNT_FORMAT_INVALID', () => decimalToAtomicAmount('+1', 9, 'amount'))
  throwsCode('AMOUNT_FORMAT_INVALID', () => decimalToAtomicAmount('1e2', 9, 'amount'))
  throwsCode('AMOUNT_FORMAT_INVALID', () => decimalToAtomicAmount(' 1', 9, 'amount'))
  throwsCode('AMOUNT_FORMAT_INVALID', () => decimalToAtomicAmount('01', 9, 'amount'))
  throwsCode('AMOUNT_PRECISION_EXCEEDED', () => decimalToAtomicAmount('0.0000000001', 9, 'amount'))
  throwsCode('AMOUNT_OVERFLOW', () => decimalToAtomicAmount((SOLANA_U64_MAX + 1n).toString(), 0, 'amount'))
  throwsCode('AMOUNT_OVERFLOW', () => assertAtomicAmount((SOLANA_U64_MAX + 1n).toString(), 'amount'))
  throwsCode('AMOUNT_NOT_POSITIVE', () => assertPositiveAtomicAmount('0', 'amount'))
}

function testMeteoraPresetContract(): void {
  assert.equal(METEORA_BETA_MAX_POSITION_BINS, 70)
  assert.equal(METEORA_MAX_LIMIT_ORDER_BINS, 50)
  assert.deepEqual(
    resolveMeteoraPreset({
      id: 'focused',
      label: 'Focused',
      source: 'meteora',
      binDelta: 10,
    }),
    {
      kind: 'meteora_preset',
      binDelta: 10,
      label: 'Focused',
    },
  )
  throwsCode('PRESET_UNAVAILABLE', () =>
    resolveMeteoraPreset({
      id: 'wide',
      label: 'Wide',
      source: 'meteora',
      binDelta: null,
    }))
  throwsCode('INVALID_ARGUMENT', () =>
    resolveMeteoraPreset({
      id: 'too-wide',
      label: 'Too wide',
      source: 'meteora',
      binDelta: 35,
    }))
}

function testRangeSnappingAndBoundary(): void {
  const oneBin = snapRangeToPoolState(state, {
    kind: 'meteora_preset',
    binDelta: 0,
  })
  assert.equal(oneBin.binCount, 1)

  const sixtyNineBins = snapRangeToPoolState(state, {
    kind: 'meteora_preset',
    binDelta: 34,
  })
  assert.equal(sixtyNineBins.binCount, 69)

  const snapped = snapRangeToPoolState(state, {
    kind: 'manual',
    minPrice: '99.1',
    maxPrice: '101.2',
  })
  assert.equal(snapped.minBinId, 999)
  assert.equal(snapped.maxBinId, 1_002)
  assert.equal(snapped.requestedMinPrice, '99.1')
  assert.equal(snapped.requestedMaxPrice, '101.2')
  assert.equal(snapped.executableMinPrice, priceAt(-1))
  assert.equal(snapped.executableMaxPrice, priceAt(2))

  const seventyBins = snapRangeToPoolState(state, {
    kind: 'manual',
    minPrice: priceAt(-34),
    maxPrice: priceAt(35),
  })
  assert.equal(seventyBins.binCount, 70)

  const overWideDisplay = resolveManualRangeForDisplay(state, priceAt(-35), priceAt(35))
  assert.equal(overWideDisplay.binCount, 71)
  assert.equal(overWideDisplay.minBinId, 965)
  assert.equal(overWideDisplay.maxBinId, 1_035)

  throwsCode('RANGE_TOO_WIDE', () =>
    snapRangeToPoolState(state, {
      kind: 'manual',
      minPrice: priceAt(-35),
      maxPrice: priceAt(35),
    }))
  throwsCode('INVALID_RANGE', () =>
    snapRangeToPoolState(state, { kind: 'manual', minPrice: '101', maxPrice: '100' }))
  throwsCode('AMOUNT_NOT_POSITIVE', () =>
    snapRangeToPoolState(state, { kind: 'manual', minPrice: '0', maxPrice: '100' }))
  throwsCode('AMOUNT_FORMAT_INVALID', () =>
    snapRangeToPoolState(state, { kind: 'manual', minPrice: '1e2', maxPrice: '101' }))
}

function testRoundedSdkActivePriceRetainsCanonicalGrid(): void {
  const movedState: MeteoraExecutionPoolState = {
    ...state,
    activeBinId: 1,
    // This is the decimal emitted after JS-number multiplication by 1.0004.
    activePrice: '76.36081728166029',
    binStep: 4,
  }
  const originalMin = '76.33028516759326'
  const originalMax = '78.46591002409725'
  const recovered = resolveManualRangeForDisplay(movedState, originalMin, originalMax)
  assert.equal(recovered.minBinId, 0)
  assert.equal(recovered.maxBinId, 69)
  assert.equal(recovered.binCount, 70)

  // A genuine off-grid price remains outward-snapped, rather than absorbed by
  // the narrow API serialization tolerance.
  const justAboveMaxBin = new Decimal(originalMax).mul(new Decimal('1.0004').pow('0.00001')).toString()
  const offGrid = resolveManualRangeForDisplay(movedState, originalMin, justAboveMaxBin)
  assert.equal(offGrid.minBinId, 0)
  assert.equal(offGrid.maxBinId, 70)
}

function testCreatePositionModes(): void {
  const twoToken = createPositionPreview(state, {
    poolAddress: state.poolAddress,
    strategy: 'spot',
    range: { kind: 'manual', minPrice: '99', maxPrice: '102' },
    depositMode: 'two_token',
    tokenXAmount: '1.25',
    tokenYAmount: '100',
  }, { now: NOW })
  assert.deepEqual(twoToken.amounts, {
    tokenXAtomic: '1250000000',
    tokenYAtomic: '100000000',
  })
  assert.equal(twoToken.transactionPlan.expectedSteps.length, 1)

  const xOnly = createPositionPreview(state, {
    poolAddress: state.poolAddress,
    strategy: 'curve',
    range: { kind: 'manual', minPrice: '100', maxPrice: '103' },
    depositMode: 'single_sided',
    inputToken: 'x',
    amount: '0.5',
  }, { now: NOW })
  assert.deepEqual(xOnly.amounts, { tokenXAtomic: '500000000', tokenYAtomic: '0' })

  const xOnlyStraddling = createPositionPreview(state, {
    poolAddress: state.poolAddress,
    strategy: 'spot',
    range: { kind: 'manual', minPrice: priceAt(-2), maxPrice: priceAt(2) },
    depositMode: 'single_sided',
    inputToken: 'x',
    amount: '0.5',
  }, { now: NOW })
  assert.deepEqual(xOnlyStraddling.amounts, { tokenXAtomic: '500000000', tokenYAtomic: '0' })

  const yOnly = createPositionPreview(state, {
    poolAddress: state.poolAddress,
    strategy: 'bid_ask',
    range: { kind: 'manual', minPrice: '97', maxPrice: '100' },
    depositMode: 'single_sided',
    inputToken: 'y',
    amount: '20',
  }, { now: NOW })
  assert.deepEqual(yOnly.amounts, { tokenXAtomic: '0', tokenYAtomic: '20000000' })

  const yOnlyStraddling = createPositionPreview(state, {
    poolAddress: state.poolAddress,
    strategy: 'bid_ask',
    range: { kind: 'manual', minPrice: priceAt(-2), maxPrice: priceAt(2) },
    depositMode: 'single_sided',
    inputToken: 'y',
    amount: '20',
  }, { now: NOW })
  assert.deepEqual(yOnlyStraddling.amounts, { tokenXAtomic: '0', tokenYAtomic: '20000000' })

  throwsCode('INVALID_DEPOSIT_COMBINATION', () =>
    createPositionPreview(state, {
      poolAddress: state.poolAddress,
      strategy: 'spot',
      range: { kind: 'manual', minPrice: priceAt(-2), maxPrice: priceAt(-1) },
      depositMode: 'single_sided',
      inputToken: 'x',
      amount: '1',
    }))
  throwsCode('INVALID_DEPOSIT_COMBINATION', () =>
    createPositionPreview(state, {
      poolAddress: state.poolAddress,
      strategy: 'curve',
      range: { kind: 'manual', minPrice: priceAt(1), maxPrice: priceAt(2) },
      depositMode: 'single_sided',
      inputToken: 'y',
      amount: '1',
    }))
  throwsCode('INVALID_DEPOSIT_COMBINATION', () =>
    createPositionPreview(state, {
      poolAddress: state.poolAddress,
      strategy: 'spot',
      range: { kind: 'manual', minPrice: '101', maxPrice: '103' },
      depositMode: 'two_token',
      tokenXAmount: '1',
      tokenYAmount: '1',
    }))
}

function testLimitOrders(): void {
  const buy = createLimitOrderPreview(state, {
    poolAddress: state.poolAddress,
    side: 'buy',
    amount: '25',
    price: '98.9',
  }, { now: NOW })
  assert.equal(buy.inputToken, 'y')
  assert.equal(buy.inputTokenAtomic, '25000000')
  assert.equal(buy.binId < state.activeBinId, true)
  assert.equal(buy.protocolMaxBins, 50)
  assert.equal(new Decimal(buy.estimatedFullFillOutput).gt(0), true)

  const sell = createLimitOrderPreview(state, {
    poolAddress: state.poolAddress,
    side: 'sell',
    amount: '0.25',
    price: '101.2',
  }, { now: NOW })
  assert.equal(sell.inputToken, 'x')
  assert.equal(sell.inputTokenAtomic, '250000000')
  assert.equal(sell.binId > state.activeBinId, true)
  assert.equal(
    sell.estimatedFullFillOutput,
    new Decimal('0.25').mul(sell.executablePrice).toString(),
  )

  throwsCode('INVALID_LIMIT_ORDER', () =>
    createLimitOrderPreview(state, {
      poolAddress: state.poolAddress,
      side: 'buy',
      amount: '1',
      price: '100',
    }))
  throwsCode('INVALID_LIMIT_ORDER', () =>
    createLimitOrderPreview(state, {
      poolAddress: state.poolAddress,
      side: 'sell',
      amount: '1',
      price: '100',
    }))
}

function testPreviewIntegrityExpiryAndPoolMovement(): void {
  const preview = createPositionPreview(state, {
    poolAddress: state.poolAddress,
    strategy: 'spot',
    range: { kind: 'manual', minPrice: '99', maxPrice: '102' },
    depositMode: 'two_token',
    tokenXAmount: '1',
    tokenYAmount: '100',
  }, { now: NOW })
  assertPreviewUsable(preview, new Date('2026-07-16T10:00:29.999Z'))
  throwsCode('PREVIEW_EXPIRED', () =>
    assertPreviewUsable(preview, new Date('2026-07-16T10:00:30.000Z')))

  const tampered = {
    ...preview,
    amounts: { ...preview.amounts, tokenXAtomic: '2' },
  }
  throwsCode('PREVIEW_INPUT_CHANGED', () => assertPreviewUsable(tampered, NOW))

  assertPoolStateCompatible(preview, { ...state, activeBinId: 1_003 })
  throwsCode('POOL_STATE_CHANGED', () =>
    assertPoolStateCompatible(preview, { ...state, activeBinId: 1_004 }))

  const sameInput = createPositionPreview(state, preview.request, { now: NOW })
  assert.equal(sameInput.previewId, preview.previewId)
  assert.equal(sameInput.inputHash, preview.inputHash)
}

function testZapInContractAndDefaults(): void {
  const zap = createZapInPreview(state, {
    poolAddress: state.poolAddress,
    strategy: 'spot',
    range: { kind: 'manual', minPrice: '99', maxPrice: '102' },
    inputToken: 'x',
    amount: '1',
  }, { now: NOW })
  assert.equal(zap.inputTokenAtomic, '1000000000')
  assert.equal(zap.estimate, null)
  assert.deepEqual(
    zap.transactionPlan.expectedSteps.map((step) => step.kind),
    ['setup', 'swap', 'ledger', 'execute', 'cleanup'],
  )
  assert.equal(zap.poolState.tokenX.address, state.tokenX.address)
  assert.equal(zap.poolState.tokenY.address, state.tokenY.address)

  assert.equal(resolveExecutionDefaults({ swapSlippageBps: 50 }).swapSlippageBps, 50)
  throwsCode('INVALID_ARGUMENT', () => resolveExecutionDefaults({ previewTtlMs: 4_999 }))
  throwsCode('INVALID_ARGUMENT', () => resolveExecutionDefaults({ maxAccounts: 65 }))
}

testDecimalBoundaries()
testMeteoraPresetContract()
testRangeSnappingAndBoundary()
testRoundedSdkActivePriceRetainsCanonicalGrid()
testCreatePositionModes()
testLimitOrders()
testPreviewIntegrityExpiryAndPoolMovement()
testZapInContractAndDefaults()

console.log('Meteora execution boundary tests passed')
