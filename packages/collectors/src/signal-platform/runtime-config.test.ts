import assert from 'node:assert/strict'
import test from 'node:test'
import { FEED_V3_ENV, loadFeedV3RuntimeConfig } from './runtime-config'

test('Feed V3 is entirely off by default', () => {
  const config = loadFeedV3RuntimeConfig({})
  assert.equal(config.intakeMode, 'off')
  assert.equal(config.researchMode, 'off')
  assert.equal(config.entityMode, 'off')
  assert.equal(config.deepResearchEnabled, false)
  assert.equal(config.activeSources.size, 0)
})

test('shadow requires explicit sources and sampling but no ownership mutation', () => {
  const config = loadFeedV3RuntimeConfig({
    [FEED_V3_ENV.researchMode]: 'shadow', [FEED_V3_ENV.entityMode]: 'shadow',
    [FEED_V3_ENV.shadowSources]: 'news,polymarket', [FEED_V3_ENV.shadowSampleBasisPoints]: '250',
  })
  assert.deepEqual([...config.shadowSources], ['news', 'polymarket'])
  assert.equal(config.activeSources.size, 0)
  assert.throws(() => loadFeedV3RuntimeConfig({ [FEED_V3_ENV.researchMode]: 'shadow' }), /Shadow workers require/)
})

test('active research and entity ownership require explicit matching legacy-disabled declarations', () => {
  const base = {
    [FEED_V3_ENV.intakeMode]: 'active', [FEED_V3_ENV.researchMode]: 'active',
    [FEED_V3_ENV.entityMode]: 'active', [FEED_V3_ENV.activeSources]: 'news',
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
  })
  assert.equal(config.deepResearchEnabled, true)
})

test('unknown sources, modes, and malformed flags fail closed', () => {
  assert.throws(() => loadFeedV3RuntimeConfig({ [FEED_V3_ENV.activeSources]: 'reddit' }), /Unknown/)
  assert.throws(() => loadFeedV3RuntimeConfig({ [FEED_V3_ENV.researchMode]: 'yes' }), /Unsupported/)
  assert.throws(() => loadFeedV3RuntimeConfig({ [FEED_V3_ENV.deepEnabled]: 'true' }), /0 or 1/)
})
