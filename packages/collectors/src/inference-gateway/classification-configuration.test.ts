import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createConfiguredClassificationRuntime } from './classification-configuration'

function sqlitePath(): string { return join(mkdtempSync(join(tmpdir(), 'classification-config-')), 'control.sqlite') }

test('configured classification defaults safe-off and uses the approved Hermes path without Jev credentials', async () => {
  let hermesCalls = 0
  const runtime = createConfiguredClassificationRuntime({
    env: { CLASSIFICATION_SQLITE_PATH: sqlitePath() },
    hermesService: { async oneshot() {
      hermesCalls += 1
      return { stdout: '{"verdict":"new_information","reason":"new"}', stderr: '' }
    } },
  })
  try {
    const result = await runtime.gateway.classify({
      workload: 'research.novelty', decisionVersion: 'research.novelty.v1',
      state: {
        signal: { source: 'news', sourceRefId: '1', title: 't', whatChanged: 'w', observedAt: '2026-09-23T00:00:00.000Z' },
        context: { entities: [], recentMemories: [] },
      },
      trace: { stableDecisionKey: 'signal-1' },
    })
    assert.equal(result.actualProvider, 'ollama-cloud')
    assert.equal(result.actualModel, 'glm-5.3-flash')
    assert.equal(result.fallbackUsed, false)
    assert.equal(hermesCalls, 1)
  } finally { runtime.close() }
})

test('configuration rejects unknown workloads and unapproved model promotion', () => {
  assert.throws(() => createConfiguredClassificationRuntime({
    env: {
      CLASSIFICATION_SQLITE_PATH: sqlitePath(),
      CLASSIFICATION_LIFECYCLE_JSON: '{"unknown.workload":"active"}',
    },
  }), /Unknown classification workload/)
  assert.throws(() => createConfiguredClassificationRuntime({
    env: {
      CLASSIFICATION_SQLITE_PATH: sqlitePath(),
      INFERENCE_GATEWAY_PRIMARY_PROVIDER: 'openrouter',
      INFERENCE_GATEWAY_PRIMARY_MODEL: 'unreviewed-model',
    },
  }), /Unapproved classification Hermes route/)
  assert.throws(() => createConfiguredClassificationRuntime({
    env: {
      CLASSIFICATION_SQLITE_PATH: sqlitePath(),
      JEV_API_TOKEN: 'secret',
      JEV_API_ENDPOINT: 'https://example.com/steal-token',
    },
  }), /approved TypeSafe System One endpoint/)
})

test('retired identity workload and shadow lifecycle cannot be enabled', () => {
  assert.throws(() => createConfiguredClassificationRuntime({
    env: { CLASSIFICATION_LIFECYCLE_JSON: '{"entity.catalog_identity":"active"}' },
  }), /Unknown classification workload/)
  assert.throws(() => createConfiguredClassificationRuntime({
    env: { CLASSIFICATION_LIFECYCLE_JSON: '{"research.novelty":"shadow"}' },
  }), /Unsupported classification lifecycle mode/)
})

test('article Hermes fallback env flag off keeps Jev-only registry and exact true enables fallback versions', async () => {
  const baseEnv = { CLASSIFICATION_SQLITE_PATH: sqlitePath() }
  let hermesCalls = 0
  const hermesService = { async oneshot() {
    hermesCalls += 1
    return { stdout: '{"entityId":"bitcoin"}', stderr: '' }
  } }
  const placementState = {
    article: { title: 'Development', text: 'A captured article about Bitcoin custody.' },
    candidates: [{ id: 'bitcoin', name: 'Bitcoin', aliases: [], summary: null, scope: {} }],
  }
  const trace = { stableDecisionKey: 'article-fallback' }

  const off = createConfiguredClassificationRuntime({ env: baseEnv, hermesService })
  try {
    // Legacy version resolves against the Jev-only definition: the missing
    // Jev credentials surface instead of a Hermes dispatch.
    await assert.rejects(off.gateway.classify({
      workload: 'research.article_entity_placement', decisionVersion: 'research.article_entity_placement.v2',
      state: placementState, trace, maxProviderCalls: 1,
    }), /JEV_API_TOKEN is not configured/)
    // Fallback version does not resolve when the flag is off.
    await assert.rejects(off.gateway.classify({
      workload: 'research.article_entity_placement', decisionVersion: 'research.article_entity_placement.v3',
      state: placementState, trace, maxProviderCalls: 1,
    }), /Unknown classification definition/)
    assert.equal(hermesCalls, 0)
  } finally { off.close() }

  const on = createConfiguredClassificationRuntime({
    env: { ...baseEnv, CLASSIFICATION_ARTICLE_HERMES_FALLBACK: 'true' },
    hermesService,
  })
  try {
    // Legacy version still resolves so in-flight pinned work keeps working.
    await assert.rejects(on.gateway.classify({
      workload: 'research.article_entity_placement', decisionVersion: 'research.article_entity_placement.v2',
      state: placementState, trace, maxProviderCalls: 1,
    }), /JEV_API_TOKEN is not configured/)
    const result = await on.gateway.classify({
      workload: 'research.article_entity_placement', decisionVersion: 'research.article_entity_placement.v3',
      state: placementState, trace,
    })
    assert.equal(result.decisionVersion, 'research.article_entity_placement.v3')
    assert.equal(result.fallbackUsed, true)
    assert.equal(result.actualProvider, 'ollama-cloud')
    assert.deepEqual(result.value, { entityId: 'bitcoin', disposition: 'selected' })
  } finally { on.close() }
  assert.equal(hermesCalls, 1)
})

test('article Hermes fallback env flag accepts only the exact string true', async () => {
  const hermesService = { async oneshot() { throw new Error('must not dispatch') } }
  const placementState = {
    article: { title: 'Development', text: 'A captured article about Bitcoin custody.' },
    candidates: [{ id: 'bitcoin', name: 'Bitcoin', aliases: [], summary: null, scope: {} }],
  }
  for (const value of ['TRUE', 'true ', '1', 'yes']) {
    const runtime = createConfiguredClassificationRuntime({
      env: { CLASSIFICATION_SQLITE_PATH: sqlitePath(), CLASSIFICATION_ARTICLE_HERMES_FALLBACK: value },
      hermesService,
    })
    try {
      await assert.rejects(runtime.gateway.classify({
        workload: 'research.article_entity_placement', decisionVersion: 'research.article_entity_placement.v3',
        state: placementState, trace: { stableDecisionKey: 'strict-flag' }, maxProviderCalls: 1,
      }), /Unknown classification definition/)
    } finally { runtime.close() }
  }
})

test('article batching env flag registers batched versions only behind the exact string true', async () => {
  const hermesService = { async oneshot() { throw new Error('must not dispatch') } }
  const catalogueState = {
    article: { title: 'Development', text: 'A captured article about Bitcoin custody.' },
    candidates: [{ id: 'bitcoin', name: 'Bitcoin', aliases: [], summary: null, scope: {} }],
  }
  const trace = { stableDecisionKey: 'article-batching' }
  // Without credentials the batched base versions resolve to the Jev-required
  // definitions and surface the missing Jev configuration, exactly like the
  // standalone placement workload.
  const batched = createConfiguredClassificationRuntime({
    env: { CLASSIFICATION_SQLITE_PATH: sqlitePath(), CLASSIFICATION_ARTICLE_BATCHING: 'true' },
    hermesService,
  })
  try {
    await assert.rejects(batched.gateway.classify({
      workload: 'research.article_catalogue_batch', decisionVersion: 'research.article_catalogue_batch.v1',
      state: catalogueState, trace, maxProviderCalls: 1,
    }), /JEV_API_TOKEN is not configured/)
    // Non-exact values never register the batched versions.
    for (const value of ['TRUE', '1', 'yes']) {
      const runtime = createConfiguredClassificationRuntime({
        env: { CLASSIFICATION_SQLITE_PATH: sqlitePath(), CLASSIFICATION_ARTICLE_BATCHING: value },
        hermesService,
      })
      try {
        await assert.rejects(runtime.gateway.classify({
          workload: 'research.article_catalogue_batch', decisionVersion: 'research.article_catalogue_batch.v1',
          state: catalogueState, trace, maxProviderCalls: 1,
        }), /Unknown classification definition/)
      } finally { runtime.close() }
    }
  } finally { batched.close() }

  // Both flags on: the batched Hermes fallback versions resolve and dispatch
  // Hermes (no Jev credentials configured).
  let hermesCalls = 0
  const both = createConfiguredClassificationRuntime({
    env: {
      CLASSIFICATION_SQLITE_PATH: sqlitePath(),
      CLASSIFICATION_ARTICLE_BATCHING: 'true',
      CLASSIFICATION_ARTICLE_HERMES_FALLBACK: 'true',
    },
    hermesService: { async oneshot() {
      hermesCalls += 1
      return { stdout: '{"entityId":"bitcoin","dispositions":{"bitcoin":"not_related"}}', stderr: '' }
    } },
  })
  try {
    const result = await both.gateway.classify({
      workload: 'research.article_catalogue_batch', decisionVersion: 'research.article_catalogue_batch.v2',
      state: catalogueState, trace,
    })
    assert.equal(result.decisionVersion, 'research.article_catalogue_batch.v2')
    assert.equal(result.fallbackUsed, true)
    // A validated Hermes selection among the supplied ids backs up the
    // catalogue stage (entityId kept); only an unvalidated id is rejected.
    assert.deepEqual(result.value, { entityId: 'bitcoin', disposition: 'selected', dispositions: { bitcoin: 'not_related' } })
  } finally { both.close() }
  assert.equal(hermesCalls, 1)
})
