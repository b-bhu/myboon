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
    assert.equal(result.fallbackUsed, false)
    assert.equal(hermesCalls, 1)
  } finally { runtime.close() }
})

test('configuration rejects unknown workloads and unapproved model promotion', () => {
  assert.throws(() => createConfiguredClassificationRuntime({
    env: {
      CLASSIFICATION_SQLITE_PATH: sqlitePath(),
      CLASSIFICATION_LIFECYCLE_JSON: '{"unknown.workload":"shadow"}',
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

test('environment cannot promote Entity identity beyond its shadow-only maximum', () => {
  assert.throws(() => createConfiguredClassificationRuntime({
    env: {
      CLASSIFICATION_SQLITE_PATH: sqlitePath(),
      CLASSIFICATION_LIFECYCLE_JSON: '{"entity.catalog_identity":"active"}',
    },
  }), /exceeds source-controlled maximum/)
})
