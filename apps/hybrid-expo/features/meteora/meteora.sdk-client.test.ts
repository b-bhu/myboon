import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { MeteoraSdkClient } from '@myboon/shared/meteora'
import type { MeteoraCreatePositionCostEstimate, MeteoraCreatePositionPreview, MeteoraExecutionPoolState } from '@myboon/shared/meteora'

// BN is the shared SDK's declared dependency, rather than an app dependency.
const sharedRequire = createRequire(require.resolve('@myboon/shared/meteora'))
const BN = sharedRequire('bn.js') as new (value: number) => unknown

const state: MeteoraExecutionPoolState = {
  poolAddress: '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6',
  activeBinId: 0, activePrice: '1', binStep: 100,
  tokenX: { address: 'So11111111111111111111111111111111111111112', symbol: 'X', decimals: 6 },
  tokenY: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'Y', decimals: 6 },
  refreshedAt: new Date().toISOString(),
}
const input = {
  poolAddress: state.poolAddress, walletAddress: state.tokenX.address,
  strategy: 'spot' as const, minPrice: '0.98', maxPrice: '1.02',
}
const complete: MeteoraCreatePositionCostEstimate = {
  positionRentLamports: '1', positionReallocRentLamports: '0',
  binArrayRentLamports: '0', bitmapExtensionRentLamports: '0',
  tokenAccountRentLamports: '0', maximumNetworkFeeLamports: '5000',
  transactionCount: 1, complete: true,
}

function client() {
  // All pool reads and estimates below are mocked; no RPC is called.
  const sdk = new MeteoraSdkClient({ rpcUrl: 'http://localhost:8899' })
  sdk.getExecutionPoolState = async () => state
  return sdk
}

test('Retry re-estimates an unavailable fee or incomplete token rent', async () => {
  for (const unavailable of [
    { ...complete, maximumNetworkFeeLamports: null },
    { ...complete, tokenAccountRentLamports: null, complete: false },
  ]) {
    const sdk = client()
    let estimates = 0
    sdk.estimateCreatePositionCosts = async () => ++estimates === 1 ? unavailable : complete
    assert.equal(await sdk.estimatePositionCostsForRange(input), unavailable)
    assert.equal(await sdk.estimatePositionCostsForRange(input), complete)
    assert.equal(await sdk.estimatePositionCostsForRange(input), complete)
    assert.equal(estimates, 2, 'complete estimates remain cached after recovery')
  }
})

test('concurrent range cost requests share the same estimate', async () => {
  const sdk = client()
  let estimates = 0
  sdk.estimateCreatePositionCosts = async () => { estimates += 1; return complete }
  assert.deepEqual(await Promise.all([
    sdk.estimatePositionCostsForRange(input), sdk.estimatePositionCostsForRange(input),
  ]), [complete, complete])
  assert.equal(estimates, 1)
})

test('zero-decimal mints retain one-atomic-unit cost inputs for each deposit shape', async () => {
  const sdk = client()
  sdk.getExecutionPoolState = async () => ({
    ...state, tokenX: { ...state.tokenX, decimals: 0 }, tokenY: { ...state.tokenY, decimals: 0 },
  })
  const previews: MeteoraCreatePositionPreview[] = []
  sdk.estimateCreatePositionCosts = async ({ preview }) => { previews.push(preview); return complete }
  await sdk.estimatePositionCostsForRange(input)
  await sdk.estimatePositionCostsForRange({ ...input, depositMode: 'single_sided', inputToken: 'x' })
  await sdk.estimatePositionCostsForRange({ ...input, depositMode: 'single_sided', inputToken: 'y' })
  assert.deepEqual(previews.map((preview) => [preview.amounts.tokenXAtomic, preview.amounts.tokenYAtomic]), [
    ['1', '1'], ['1', '0'], ['0', '1'],
  ])
})

test('zero-decimal Auto-Fill quotes preserve positive whole token amounts', async () => {
  const sdk = client()
  const mock = sdk as unknown as {
    getFreshPool: () => Promise<unknown>
    poolState: () => Promise<MeteoraExecutionPoolState>
  }
  mock.getFreshPool = async () => ({ getActiveBin: async () => ({ xAmount: new BN(100), yAmount: new BN(100) }) })
  mock.poolState = async () => ({ ...state, tokenX: { ...state.tokenX, decimals: 0 }, tokenY: { ...state.tokenY, decimals: 0 } })
  for (const inputToken of ['x', 'y'] as const) {
    const quote = await sdk.quoteAutoFill({
      poolAddress: state.poolAddress, strategy: 'spot', inputToken, amount: '10',
      range: { kind: 'manual', minPrice: input.minPrice, maxPrice: input.maxPrice },
    })
    assert.equal(quote.tokenXAmount, quote.tokenXAtomic)
    assert.equal(quote.tokenYAmount, quote.tokenYAtomic)
    assert.ok(BigInt(quote.tokenXAmount) > 0n)
    assert.ok(BigInt(quote.tokenYAmount) > 0n)
  }
})
