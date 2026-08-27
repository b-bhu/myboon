import assert from 'node:assert/strict'
import test from 'node:test'
import { FEED_V3_ENV, loadFeedV3RuntimeConfig } from './runtime-config'
import type { FeedV3RuntimeConfig, FeedV3Source } from './runtime-config'
import {
  assertPhase1CutoverPolicy,
  Phase1CutoverPolicyError,
  PHASE1_CUTOVER_SOURCES,
} from './phase1-cutover'

function phase1Config(overrides: Record<string, string | undefined> = {}): FeedV3RuntimeConfig {
  return loadFeedV3RuntimeConfig({
    [FEED_V3_ENV.cutoverPolicy]: 'phase1',
    [FEED_V3_ENV.researchMode]: 'active',
    [FEED_V3_ENV.entityMode]: 'active',
    [FEED_V3_ENV.activeSources]: 'news,polymarket',
    [FEED_V3_ENV.legacyResearchDisabledSources]: 'news,polymarket',
    [FEED_V3_ENV.legacyEntityDisabledSources]: 'news,polymarket',
    [FEED_V3_ENV.triageProviderHealth]: 'healthy',
    ...overrides,
  })
}

/**
 * Build a FeedV3RuntimeConfig directly so the pure guard can be exercised on
 * states that runtime parsing would never produce (e.g. active mode with an
 * empty active-source set). This isolates the guard's fail-closed logic from
 * the loader's own validation.
 */
function rawConfig(partial: Partial<FeedV3RuntimeConfig>): FeedV3RuntimeConfig {
  const empty = new Set<FeedV3Source>()
  return {
    intakeMode: 'off',
    researchMode: 'off',
    entityMode: 'off',
    activeSources: empty,
    shadowSources: empty,
    intakeActiveSources: empty,
    intakeShadowSources: empty,
    researchActiveSources: empty,
    researchShadowSources: empty,
    entityActiveSources: empty,
    entityShadowSources: empty,
    legacyResearchDisabledSources: empty,
    legacyEntityDisabledSources: empty,
    shadowSampleBasisPoints: 0,
    deepResearchEnabled: false,
    triageClassifierEnabled: false,
    triageProviderHealth: 'unavailable',
    triageAllowedDepths: new Set(['light']),
    cutoverReceiptPath: null,
    cutoverPolicy: 'phase1',
    ...partial,
  }
}

test('phase1 guard passes for both stages with a bounded typed summary', () => {
  for (const stage of ['research', 'entity'] as const) {
    const summary = assertPhase1CutoverPolicy(phase1Config(), stage)
    assert.equal(summary.schemaVersion, 'myboon.feed_v3_phase1_cutover.v1')
    assert.equal(summary.policy, 'phase1')
    assert.equal(summary.stage, stage)
    assert.deepEqual(summary.activeSources, ['news', 'polymarket'])
    assert.deepEqual(summary.triageAllowedDepths, ['light'])
    assert.equal(summary.deepResearchEnabled, false)
    assert.equal(summary.triageClassifierEnabled, false)
    assert.equal(summary.triageProviderHealth, 'healthy')
  }
})

test('phase1 guard rejects an unsupported stage', () => {
  assert.throws(
    () => assertPhase1CutoverPolicy(phase1Config(), 'intake' as never),
    (error: Error) => error instanceof Phase1CutoverPolicyError && /Unsupported Phase 1 cutover stage/.test(error.message),
  )
})

test('phase1 guard rejects a runtime configured for the full cutover policy', () => {
  const config = rawConfig({
    cutoverPolicy: 'full',
    researchMode: 'active',
    researchActiveSources: new Set(['news']),
    legacyResearchDisabledSources: new Set(['news']),
    triageProviderHealth: 'healthy',
  })
  assert.throws(
    () => assertPhase1CutoverPolicy(config, 'research'),
    (error: Error) => error instanceof Phase1CutoverPolicyError && /phase1 runtime policy/.test(error.message),
  )
})

test('phase1 guard fails closed when no active source exists for the stage', () => {
  const config = rawConfig({
    researchMode: 'active',
    entityMode: 'active',
    researchActiveSources: new Set(),
    entityActiveSources: new Set(),
    triageProviderHealth: 'healthy',
  })
  assert.throws(
    () => assertPhase1CutoverPolicy(config, 'research'),
    (error: Error) => error instanceof Phase1CutoverPolicyError && /at least one active research source/.test(error.message),
  )
  assert.throws(
    () => assertPhase1CutoverPolicy(config, 'entity'),
    (error: Error) => error instanceof Phase1CutoverPolicyError && /at least one active entity source/.test(error.message),
  )
})

test('phase1 guard rejects out-of-scope active sources', () => {
  const config = rawConfig({
    researchMode: 'active',
    researchActiveSources: new Set(['news', 'market_calendar']),
    legacyResearchDisabledSources: new Set(['news', 'market_calendar']),
    triageProviderHealth: 'healthy',
  })
  assert.throws(
    () => assertPhase1CutoverPolicy(config, 'research'),
    (error: Error) => error instanceof Phase1CutoverPolicyError && /does not admit active research source: market_calendar/.test(error.message),
  )
  const xConfig = rawConfig({
    entityMode: 'active',
    entityActiveSources: new Set(['x']),
    legacyEntityDisabledSources: new Set(['x']),
    triageProviderHealth: 'healthy',
  })
  assert.throws(
    () => assertPhase1CutoverPolicy(xConfig, 'entity'),
    (error: Error) => error instanceof Phase1CutoverPolicyError && /does not admit active entity source: x/.test(error.message),
  )
})

test('phase1 guard rejects missing legacy-disabled ownership', () => {
  const config = rawConfig({
    researchMode: 'active',
    entityMode: 'active',
    researchActiveSources: new Set(['news', 'polymarket']),
    entityActiveSources: new Set(['news', 'polymarket']),
    legacyResearchDisabledSources: new Set(['news']),
    legacyEntityDisabledSources: new Set(['news']),
    triageProviderHealth: 'healthy',
  })
  assert.throws(
    () => assertPhase1CutoverPolicy(config, 'research'),
    (error: Error) => error instanceof Phase1CutoverPolicyError && /legacy-disabled ownership for research: polymarket/.test(error.message),
  )
  assert.throws(
    () => assertPhase1CutoverPolicy(config, 'entity'),
    (error: Error) => error instanceof Phase1CutoverPolicyError && /legacy-disabled ownership for entity: polymarket/.test(error.message),
  )
})

test('phase1 guard rejects triage allowed depths other than exactly light', () => {
  const standard = phase1Config({ [FEED_V3_ENV.triageAllowedDepths]: 'light,standard' })
  assert.throws(
    () => assertPhase1CutoverPolicy(standard, 'research'),
    (error: Error) => error instanceof Phase1CutoverPolicyError && /exactly light/.test(error.message),
  )
  const deep = phase1Config({ [FEED_V3_ENV.triageAllowedDepths]: 'light,deep', [FEED_V3_ENV.deepEnabled]: '1' })
  assert.throws(
    () => assertPhase1CutoverPolicy(deep, 'research'),
    (error: Error) => error instanceof Phase1CutoverPolicyError && /exactly light/.test(error.message),
  )
})

test('phase1 guard rejects deep research enabled', () => {
  const config = phase1Config({ [FEED_V3_ENV.deepEnabled]: '1' })
  assert.throws(
    () => assertPhase1CutoverPolicy(config, 'research'),
    (error: Error) => error instanceof Phase1CutoverPolicyError && /deep research to be disabled/.test(error.message),
  )
})

test('phase1 guard rejects triage classifier enabled', () => {
  const config = phase1Config({ [FEED_V3_ENV.triageClassifierEnabled]: '1' })
  assert.throws(
    () => assertPhase1CutoverPolicy(config, 'research'),
    (error: Error) => error instanceof Phase1CutoverPolicyError && /triage classifier to be disabled/.test(error.message),
  )
})

test('phase1 guard rejects non-healthy triage provider health', () => {
  for (const health of ['degraded', 'unavailable', 'circuit_open']) {
    const config = phase1Config({ [FEED_V3_ENV.triageProviderHealth]: health })
    assert.throws(
      () => assertPhase1CutoverPolicy(config, 'research'),
      (error: Error) => error instanceof Phase1CutoverPolicyError && /healthy triage provider health/.test(error.message),
    )
  }
})

test('phase1 guard reports deterministic source ordering regardless of input order', () => {
  const config = phase1Config({ [FEED_V3_ENV.researchActiveSources]: 'polymarket,news' })
  const summary = assertPhase1CutoverPolicy(config, 'research')
  assert.deepEqual(summary.activeSources, ['news', 'polymarket'])
})

test('phase1 guard does not mutate the input config sets', () => {
  const config = phase1Config()
  const researchBefore = [...config.researchActiveSources].sort()
  const entityBefore = [...config.entityActiveSources].sort()
  const legacyResearchBefore = [...config.legacyResearchDisabledSources].sort()
  const legacyEntityBefore = [...config.legacyEntityDisabledSources].sort()
  assertPhase1CutoverPolicy(config, 'research')
  assertPhase1CutoverPolicy(config, 'entity')
  assert.deepEqual([...config.researchActiveSources].sort(), researchBefore)
  assert.deepEqual([...config.entityActiveSources].sort(), entityBefore)
  assert.deepEqual([...config.legacyResearchDisabledSources].sort(), legacyResearchBefore)
  assert.deepEqual([...config.legacyEntityDisabledSources].sort(), legacyEntityBefore)
})

test('phase1 guard summary carries no secrets', () => {
  const summary = assertPhase1CutoverPolicy(phase1Config(), 'research')
  const serialized = JSON.stringify(summary)
  assert.equal(serialized.includes('receipt'), false)
  assert.equal(serialized.includes('/run/'), false)
  assert.equal(serialized.includes('FEED_V3_'), false)
  assert.deepEqual(PHASE1_CUTOVER_SOURCES, ['news', 'polymarket'])
})
