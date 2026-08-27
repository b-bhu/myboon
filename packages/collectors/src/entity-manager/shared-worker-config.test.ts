import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SharedEntityWorkerConfigError,
  sharedEntityWorkerConfig,
} from './shared-worker-config'

test('shared worker config defaults preserve legacy ownership with shadow off', () => {
  const config = sharedEntityWorkerConfig()
  assert.deepEqual(config.ownership, {
    news: 'legacy',
    polymarket: 'legacy',
    market_calendar: 'legacy',
    x: 'legacy',
  })
  assert.equal(config.shadowSources.size, 0)
  assert.equal(config.shadowSampleBasisPoints, 0)
})

test('runtime topology hard-fails dual active claimers for any source', () => {
  assert.throws(() => sharedEntityWorkerConfig({
    ownership: { news: 'shared' },
    runtimeTopology: { news: { legacyActiveClaimers: 1, sharedActiveClaimers: 1 } },
  }), (error: unknown) => error instanceof SharedEntityWorkerConfigError && /both legacy and shared/.test(error.message))
})

test('shadow sampling basis points are strictly bounded', () => {
  assert.throws(() => sharedEntityWorkerConfig({ shadowSampleBasisPoints: 10_001 }), SharedEntityWorkerConfigError)
  assert.throws(() => sharedEntityWorkerConfig({ shadowSampleBasisPoints: 0.5 }), SharedEntityWorkerConfigError)
})

test('config rejects unknown sources and invalid ownership values at runtime', () => {
  assert.throws(
    () => sharedEntityWorkerConfig({ ownership: { unknown: 'shared' } as never }),
    /unknown source/,
  )
  assert.throws(
    () => sharedEntityWorkerConfig({ ownership: { news: 'both' } as never }),
    /legacy or shared/,
  )
})
