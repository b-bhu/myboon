import assert from 'node:assert/strict'
import test from 'node:test'
import { FEED_V3_ENV, feedV3ModeForSource, loadFeedV3RuntimeConfig } from './runtime-config'

test('Feed V3 is entirely off by default', () => {
  const config = loadFeedV3RuntimeConfig({})
  assert.equal(config.intakeMode, 'off')
  assert.equal(config.researchMode, 'off')
  assert.equal(config.entityMode, 'off')
  assert.equal(config.deepResearchEnabled, false)
  assert.deepEqual([...config.triageAllowedDepths], ['light'])
  assert.equal(config.triageProviderHealth, 'unavailable')
  assert.equal(config.triageClassifierEnabled, false)
  assert.equal(config.activeSources.size, 0)
  assert.equal(config.intakeActiveSources.size, 0)
  assert.equal(config.cutoverReceiptPath, null)
  assert.equal(config.cutoverPolicy, 'full')
})

test('shadow requires explicit sources and sampling but no ownership mutation', () => {
  const config = loadFeedV3RuntimeConfig({
    [FEED_V3_ENV.researchMode]: 'shadow', [FEED_V3_ENV.entityMode]: 'shadow',
    [FEED_V3_ENV.shadowSources]: 'news,polymarket', [FEED_V3_ENV.shadowSampleBasisPoints]: '250',
  })
  assert.deepEqual([...config.shadowSources], ['news', 'polymarket'])
  assert.equal(config.activeSources.size, 0)
  assert.throws(() => loadFeedV3RuntimeConfig({ [FEED_V3_ENV.researchMode]: 'shadow' }), /Shadow research requires/)
})

test('active research and entity ownership require explicit matching legacy-disabled declarations', () => {
  const base = {
    [FEED_V3_ENV.intakeMode]: 'active', [FEED_V3_ENV.researchMode]: 'active',
    [FEED_V3_ENV.entityMode]: 'active', [FEED_V3_ENV.activeSources]: 'news',
    [FEED_V3_ENV.cutoverReceiptPath]: '/run/myboon/feed-v3-cutover.json',
  }
  assert.throws(() => loadFeedV3RuntimeConfig(base), /legacy-disabled sources: news/)
  const config = loadFeedV3RuntimeConfig({
    ...base,
    [FEED_V3_ENV.legacyResearchDisabledSources]: 'news',
    [FEED_V3_ENV.legacyEntityDisabledSources]: 'news',
  })
  assert.equal(config.researchMode, 'active')
  assert.deepEqual([...config.activeSources], ['news'])
})

test('deep is fail-closed unless shared research is active', () => {
  assert.throws(() => loadFeedV3RuntimeConfig({ [FEED_V3_ENV.deepEnabled]: '1' }), /only with active/)
  const config = loadFeedV3RuntimeConfig({
    [FEED_V3_ENV.researchMode]: 'active', [FEED_V3_ENV.activeSources]: 'news',
    [FEED_V3_ENV.legacyResearchDisabledSources]: 'news', [FEED_V3_ENV.deepEnabled]: '1',
    [FEED_V3_ENV.cutoverReceiptPath]: '/run/myboon/feed-v3-cutover.json',
  })
  assert.equal(config.deepResearchEnabled, true)
})

test('unknown sources, modes, and malformed flags fail closed', () => {
  assert.throws(() => loadFeedV3RuntimeConfig({ [FEED_V3_ENV.activeSources]: 'reddit' }), /Unknown/)
  assert.throws(() => loadFeedV3RuntimeConfig({ [FEED_V3_ENV.researchMode]: 'yes' }), /Unsupported/)
  assert.throws(() => loadFeedV3RuntimeConfig({ [FEED_V3_ENV.deepEnabled]: 'true' }), /0 or 1/)
  assert.throws(() => loadFeedV3RuntimeConfig({ [FEED_V3_ENV.triageAllowedDepths]: 'light,wide' }), /triage depth/)
  assert.throws(() => loadFeedV3RuntimeConfig({ [FEED_V3_ENV.triageAllowedDepths]: 'deep' }), /Deep triage admission/)
})

test('standard depth requires explicit capability config while deep also requires active deep ownership', () => {
  const standard = loadFeedV3RuntimeConfig({ [FEED_V3_ENV.triageAllowedDepths]: 'light,standard' })
  assert.deepEqual([...standard.triageAllowedDepths], ['light', 'standard'])
  const deep = loadFeedV3RuntimeConfig({
    [FEED_V3_ENV.triageAllowedDepths]: 'light,deep',
    [FEED_V3_ENV.deepEnabled]: '1',
    [FEED_V3_ENV.researchMode]: 'active',
    [FEED_V3_ENV.researchActiveSources]: 'news',
    [FEED_V3_ENV.legacyResearchDisabledSources]: 'news',
    [FEED_V3_ENV.cutoverReceiptPath]: '/run/myboon/feed-v3-cutover.json',
  })
  assert.equal(deep.triageAllowedDepths.has('deep'), true)
})

test('stage-specific source sets permit independent cutover and override legacy aliases', () => {
  const config = loadFeedV3RuntimeConfig({
    [FEED_V3_ENV.intakeMode]: 'observe',
    [FEED_V3_ENV.researchMode]: 'active',
    [FEED_V3_ENV.entityMode]: 'shadow',
    [FEED_V3_ENV.activeSources]: 'x',
    [FEED_V3_ENV.shadowSources]: 'x',
    [FEED_V3_ENV.intakeShadowSources]: 'news,polymarket',
    [FEED_V3_ENV.researchActiveSources]: 'news',
    [FEED_V3_ENV.entityShadowSources]: 'polymarket',
    [FEED_V3_ENV.legacyResearchDisabledSources]: 'news',
    [FEED_V3_ENV.cutoverReceiptPath]: '/run/myboon/feed-v3-cutover.json',
    [FEED_V3_ENV.shadowSampleBasisPoints]: '100',
  })
  assert.equal(feedV3ModeForSource(config, 'intake', 'news'), 'observe')
  assert.equal(feedV3ModeForSource(config, 'intake', 'x'), 'off')
  assert.equal(feedV3ModeForSource(config, 'research', 'news'), 'active')
  assert.equal(feedV3ModeForSource(config, 'research', 'x'), 'off')
  assert.equal(feedV3ModeForSource(config, 'entity', 'polymarket'), 'shadow')
  assert.equal(feedV3ModeForSource(config, 'entity', 'news'), 'off')
})

test('ownership validation uses the stage-specific active set', () => {
  assert.throws(() => loadFeedV3RuntimeConfig({
    [FEED_V3_ENV.researchMode]: 'active',
    [FEED_V3_ENV.researchActiveSources]: 'polymarket',
    [FEED_V3_ENV.activeSources]: 'news',
    [FEED_V3_ENV.legacyResearchDisabledSources]: 'news',
    [FEED_V3_ENV.cutoverReceiptPath]: '/run/myboon/feed-v3-cutover.json',
  }), /legacy-disabled sources: polymarket/)
})

test('cutover policy defaults to full and rejects unknown values', () => {
  assert.equal(loadFeedV3RuntimeConfig({}).cutoverPolicy, 'full')
  assert.equal(loadFeedV3RuntimeConfig({ [FEED_V3_ENV.cutoverPolicy]: 'full' }).cutoverPolicy, 'full')
  assert.equal(loadFeedV3RuntimeConfig({ [FEED_V3_ENV.cutoverPolicy]: 'phase1' }).cutoverPolicy, 'phase1')
  assert.throws(() => loadFeedV3RuntimeConfig({ [FEED_V3_ENV.cutoverPolicy]: 'partial' }), /cutover policy/)
})

test('full policy keeps the receipt path mandatory for active shared ownership', () => {
  const base = {
    [FEED_V3_ENV.researchMode]: 'active', [FEED_V3_ENV.entityMode]: 'active',
    [FEED_V3_ENV.activeSources]: 'news',
    [FEED_V3_ENV.legacyResearchDisabledSources]: 'news',
    [FEED_V3_ENV.legacyEntityDisabledSources]: 'news',
  }
  assert.throws(() => loadFeedV3RuntimeConfig(base), /FEED_V3_CUTOVER_RECEIPT_PATH/)
  const config = loadFeedV3RuntimeConfig({
    ...base, [FEED_V3_ENV.cutoverReceiptPath]: '/run/myboon/feed-v3-cutover.json',
  })
  assert.equal(config.cutoverPolicy, 'full')
  assert.equal(config.cutoverReceiptPath, '/run/myboon/feed-v3-cutover.json')
})

test('phase1 policy parses active ownership without a receipt path', () => {
  const config = loadFeedV3RuntimeConfig({
    [FEED_V3_ENV.cutoverPolicy]: 'phase1',
    [FEED_V3_ENV.researchMode]: 'active', [FEED_V3_ENV.entityMode]: 'active',
    [FEED_V3_ENV.activeSources]: 'news,polymarket',
    [FEED_V3_ENV.legacyResearchDisabledSources]: 'news,polymarket',
    [FEED_V3_ENV.legacyEntityDisabledSources]: 'news,polymarket',
  })
  assert.equal(config.cutoverPolicy, 'phase1')
  assert.equal(config.cutoverReceiptPath, null)
  assert.equal(config.researchMode, 'active')
  assert.equal(config.entityMode, 'active')
})

test('phase1 rejects any active intake/research/entity source outside news and polymarket', () => {
  const base = {
    [FEED_V3_ENV.cutoverPolicy]: 'phase1',
    [FEED_V3_ENV.legacyResearchDisabledSources]: 'news,polymarket,market_calendar,x',
    [FEED_V3_ENV.legacyEntityDisabledSources]: 'news,polymarket,market_calendar,x',
  }
  // Active intake source outside scope.
  assert.throws(() => loadFeedV3RuntimeConfig({
    ...base, [FEED_V3_ENV.intakeMode]: 'active', [FEED_V3_ENV.intakeActiveSources]: 'news,market_calendar',
  }), /Phase 1 does not admit active source: market_calendar/)
  // Active research source outside scope.
  assert.throws(() => loadFeedV3RuntimeConfig({
    ...base, [FEED_V3_ENV.researchMode]: 'active', [FEED_V3_ENV.researchActiveSources]: 'news,x',
  }), /Phase 1 does not admit active source: x/)
  // Active entity source outside scope.
  assert.throws(() => loadFeedV3RuntimeConfig({
    ...base, [FEED_V3_ENV.entityMode]: 'active', [FEED_V3_ENV.entityActiveSources]: 'polymarket,x',
  }), /Phase 1 does not admit active source: x/)
  // A single out-of-scope source across any stage is rejected.
  assert.throws(() => loadFeedV3RuntimeConfig({
    ...base,
    [FEED_V3_ENV.intakeMode]: 'active', [FEED_V3_ENV.intakeActiveSources]: 'news',
    [FEED_V3_ENV.researchMode]: 'active', [FEED_V3_ENV.researchActiveSources]: 'news',
    [FEED_V3_ENV.entityMode]: 'active', [FEED_V3_ENV.entityActiveSources]: 'news,market_calendar',
  }), /Phase 1 does not admit active source: market_calendar/)
})

test('phase1 keeps shadow and off sources outside scope safe and deterministic', () => {
  const base = {
    [FEED_V3_ENV.cutoverPolicy]: 'phase1',
    [FEED_V3_ENV.shadowSampleBasisPoints]: '100',
  }
  // Shadow sources outside the Phase 1 scope are allowed (shadow is not active
  // ownership) and remain deterministic.
  const shadow = loadFeedV3RuntimeConfig({
    ...base,
    [FEED_V3_ENV.researchMode]: 'shadow', [FEED_V3_ENV.researchShadowSources]: 'market_calendar,x',
    [FEED_V3_ENV.entityMode]: 'shadow', [FEED_V3_ENV.entityShadowSources]: 'market_calendar,x',
  })
  assert.deepEqual([...shadow.researchShadowSources].sort(), ['market_calendar', 'x'])
  assert.deepEqual([...shadow.entityShadowSources].sort(), ['market_calendar', 'x'])
  // Off mode with out-of-scope sources configured is also accepted.
  const off = loadFeedV3RuntimeConfig({
    ...base,
    [FEED_V3_ENV.researchMode]: 'off', [FEED_V3_ENV.researchActiveSources]: 'market_calendar',
  })
  assert.equal(off.researchMode, 'off')
})
