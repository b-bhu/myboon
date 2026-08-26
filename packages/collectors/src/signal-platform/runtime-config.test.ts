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
