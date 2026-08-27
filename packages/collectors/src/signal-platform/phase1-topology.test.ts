import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import { FEED_V3_ENV, loadFeedV3RuntimeConfig } from './runtime-config'

const nodeRequire = createRequire(__filename)
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..')
const ECOSYSTEM_PATH = resolve(REPO_ROOT, 'ecosystem.config.cjs')

/**
 * The exact Phase 1 env contract (News + Polymarket only). Every value is
 * required; the shared workers and the legacy claimers must agree on it.
 */
const PHASE1_ENV: Record<string, string> = {
  [FEED_V3_ENV.cutoverPolicy]: 'phase1',
  [FEED_V3_ENV.intakeMode]: 'active',
  [FEED_V3_ENV.researchMode]: 'active',
  [FEED_V3_ENV.entityMode]: 'active',
  [FEED_V3_ENV.intakeActiveSources]: 'news,polymarket',
  [FEED_V3_ENV.researchActiveSources]: 'news,polymarket',
  [FEED_V3_ENV.entityActiveSources]: 'news,polymarket',
  [FEED_V3_ENV.legacyResearchDisabledSources]: 'news,polymarket',
  [FEED_V3_ENV.legacyEntityDisabledSources]: 'news,polymarket',
  [FEED_V3_ENV.triageAllowedDepths]: 'light',
  [FEED_V3_ENV.deepEnabled]: '0',
  [FEED_V3_ENV.triageClassifierEnabled]: '0',
  [FEED_V3_ENV.triageProviderHealth]: 'healthy',
}

test('Phase 1 env contract parses both sources and stages with all invariants', () => {
  const config = loadFeedV3RuntimeConfig(PHASE1_ENV)

  // Both stages active for both sources.
  assert.equal(config.intakeMode, 'active')
  assert.equal(config.researchMode, 'active')
  assert.equal(config.entityMode, 'active')
  assert.deepEqual([...config.intakeActiveSources].sort(), ['news', 'polymarket'])
  assert.deepEqual([...config.researchActiveSources].sort(), ['news', 'polymarket'])
  assert.deepEqual([...config.entityActiveSources].sort(), ['news', 'polymarket'])

  // Legacy-disabled ownership matches the active sources for both stages.
  assert.deepEqual([...config.legacyResearchDisabledSources].sort(), ['news', 'polymarket'])
  assert.deepEqual([...config.legacyEntityDisabledSources].sort(), ['news', 'polymarket'])

  // Phase 1 invariants: policy phase1, depth exactly light, deep off,
  // classifier off, provider healthy, no receipt.
  assert.equal(config.cutoverPolicy, 'phase1')
  assert.deepEqual([...config.triageAllowedDepths], ['light'])
  assert.equal(config.deepResearchEnabled, false)
  assert.equal(config.triageClassifierEnabled, false)
  assert.equal(config.triageProviderHealth, 'healthy')
  assert.equal(config.cutoverReceiptPath, null)
})

test('ecosystem registers both shared apps with the policy/safety keys and legacy apps with ownership', () => {
  const originalEnv = { ...process.env }
  const originalCache = { ...nodeRequire.cache }
  try {
    // Load the ecosystem with the Phase 1 contract in the invoking shell so the
    // ownership and policy env objects are populated exactly as PM2 would.
    for (const [key, value] of Object.entries(PHASE1_ENV)) process.env[key] = value
    delete nodeRequire.cache[ECOSYSTEM_PATH]

    const ecosystem = nodeRequire(ECOSYSTEM_PATH) as {
      apps: Array<{ name: string, env?: Record<string, string> }>
    }
    const byName = new Map(ecosystem.apps.map((app) => [app.name, app]))

    // Both shared apps exist.
    const sharedResearch = byName.get('myboon-feed-v3-research')
    const sharedEntity = byName.get('myboon-feed-v3-entity-manager')
    assert.ok(sharedResearch, 'shared Research app must be registered')
    assert.ok(sharedEntity, 'shared Entity app must be registered')

    // Both shared apps receive the policy/safety keys with the Phase 1 values.
    const policyKeys = [
      FEED_V3_ENV.cutoverPolicy,
      FEED_V3_ENV.triageAllowedDepths,
      FEED_V3_ENV.triageClassifierEnabled,
      FEED_V3_ENV.triageProviderHealth,
      FEED_V3_ENV.deepEnabled,
    ]
    for (const app of [sharedResearch, sharedEntity]) {
      for (const key of policyKeys) {
        assert.equal(app.env?.[key], PHASE1_ENV[key], `${app.name} must receive ${key}`)
      }
    }

    // Legacy News+Polymarket Research apps receive the research ownership
    // declarations; legacy Entity apps receive the entity ownership ones.
    const researchOwnershipKeys = [
      FEED_V3_ENV.researchMode,
      FEED_V3_ENV.researchActiveSources,
      FEED_V3_ENV.legacyResearchDisabledSources,
    ]
    const entityOwnershipKeys = [
      FEED_V3_ENV.entityMode,
      FEED_V3_ENV.entityActiveSources,
      FEED_V3_ENV.legacyEntityDisabledSources,
    ]
    for (const name of ['myboon-news-researcher', 'myboon-polymarket-researcher']) {
      const app = byName.get(name)
      assert.ok(app, `${name} must be registered`)
      for (const key of researchOwnershipKeys) {
        assert.equal(app.env?.[key], PHASE1_ENV[key], `${name} must receive ${key}`)
      }
    }
    for (const name of ['myboon-news-entity-manager', 'myboon-polymarket-entity-manager']) {
      const app = byName.get(name)
      assert.ok(app, `${name} must be registered`)
      for (const key of entityOwnershipKeys) {
        assert.equal(app.env?.[key], PHASE1_ENV[key], `${name} must receive ${key}`)
      }
    }
  } finally {
    // Restore process.env and the module cache exactly as they were.
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
    for (const key of Object.keys(nodeRequire.cache)) {
      if (!(key in originalCache)) delete nodeRequire.cache[key]
    }
    Object.assign(nodeRequire.cache, originalCache)
  }
})

test('no third Feed V3 SQLite path is introduced', () => {
  const ecosystemSource = readFileSync(ECOSYSTEM_PATH, 'utf8')

  // The only Feed V3 SQLite paths are the two existing physical stores. No
  // FEED_V3_*_SQLITE_PATH key may appear beyond the legacy NEWS/PIPELINE pair.
  const feedV3SqliteKeys = [...ecosystemSource.matchAll(/FEED_V3_[A-Z0-9_]*SQLITE_PATH/g)]
    .map((match) => match[0])
  assert.deepEqual(feedV3SqliteKeys, [])

  // The shared apps must not introduce a third physical store: the only SQLite
  // path references in the ecosystem are news.sqlite and pipeline.sqlite.
  const sqlitePaths = [...ecosystemSource.matchAll(/['"]([^'"]*\.sqlite)['"]/g)]
    .map((match) => match[1])
  assert.ok(sqlitePaths.length > 0, 'expected at least the two source SQLite paths')
  for (const path of sqlitePaths) {
    assert.ok(
      path === '.data/news.sqlite' || path === '.data/pipeline.sqlite',
      `unexpected SQLite path in ecosystem: ${path}`,
    )
  }
})
