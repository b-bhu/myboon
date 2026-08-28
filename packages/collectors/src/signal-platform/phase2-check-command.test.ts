import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  Phase2CheckArgumentError,
  parsePhase2CheckArguments,
  probeSqliteDatabaseReadOnly,
  runPhase2Check,
} from './phase2-check-command'

const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void }
}

function phase2Env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    FEED_V3_CUTOVER_POLICY: 'phase1',
    FEED_V3_INTAKE_MODE: 'active',
    FEED_V3_RESEARCH_MODE: 'active',
    FEED_V3_ENTITY_MODE: 'active',
    FEED_V3_INTAKE_ACTIVE_SOURCES: 'news,polymarket',
    FEED_V3_RESEARCH_ACTIVE_SOURCES: 'news,polymarket',
    FEED_V3_ENTITY_ACTIVE_SOURCES: 'news,polymarket',
    FEED_V3_LEGACY_RESEARCH_DISABLED_SOURCES: 'news,polymarket',
    FEED_V3_LEGACY_ENTITY_DISABLED_SOURCES: 'news,polymarket',
    FEED_V3_TRIAGE_ALLOWED_DEPTHS: 'light',
    FEED_V3_DEEP_RESEARCH_ENABLED: '0',
    FEED_V3_TRIAGE_CLASSIFIER_ENABLED: '0',
    FEED_V3_TRIAGE_PROVIDER_HEALTH: 'healthy',
    INFERENCE_GATEWAY_PRIMARY_PROVIDER: 'ollama-cloud',
    INFERENCE_GATEWAY_PRIMARY_MODEL: 'deepseek-v4-flash',
    TOKENS_API_KEY: 'tokens-secret-value',
    SUPABASE_URL: 'https://secret-project.example',
    SUPABASE_SERVICE_ROLE_KEY: 'service-secret-value',
    NEWS_SQLITE_PATH: '.data/news.sqlite',
    PIPELINE_SQLITE_PATH: '.data/pipeline.sqlite',
    ...overrides,
  }
}

test('argument parser requires one explicit mode and rejects unknown or duplicate flags', () => {
  assert.deepEqual(parsePhase2CheckArguments(['--mode', 'preflight']), { mode: 'preflight' })
  assert.deepEqual(parsePhase2CheckArguments(['--', '--mode', 'preflight']), { mode: 'preflight' })
  assert.deepEqual(
    parsePhase2CheckArguments([
      '--mode', 'runtime', '--max-cost-usd-micros-per-packet', '2500',
    ]),
    { mode: 'runtime', maxCostUsdMicrosPerCompletedPacket: 2500 },
  )
  for (const args of [
    [] as string[],
    ['--unknown', 'x'],
    ['--mode', 'preflight', '--', 'x'],
    ['--mode', 'preflight', '--mode', 'runtime'],
    ['--mode', 'runtime'],
    ['--mode', 'preflight', '--max-cost-usd-micros-per-packet', '1'],
  ]) {
    assert.throws(() => parsePhase2CheckArguments(args), Phase2CheckArgumentError)
  }
})

test('preflight is dependency-injected, redacted, and treats absent runtime as a warning', async () => {
  const calls: string[] = []
  const report = await runPhase2Check({
    args: ['--mode', 'preflight'],
    env: phase2Env(),
    packageDirectory: '/safe/package',
  }, {
    now: () => new Date('2026-08-27T12:00:00.000Z'),
    probeDatabase(path, source) {
      calls.push(`${source}:${path}`)
      return { source, basename: `${source}.sqlite`, available: true, integrity: 'ok' }
    },
    async readRuntime() {
      calls.push('runtime')
      return {
        researchRuntime: { availability: 'missing', snapshot: null },
        entityRuntime: { availability: 'missing', snapshot: null },
      }
    },
    async readControlPlane() {
      throw new Error('preflight must not read the control plane')
    },
  })

  assert.equal(report.ready, true)
  assert.equal(report.checks.filter((check) => check.status === 'warn').length, 2)
  assert.deepEqual(calls, [
    'news:/safe/package/.data/news.sqlite',
    'polymarket:/safe/package/.data/pipeline.sqlite',
    'runtime',
  ])
  const serialized = JSON.stringify(report)
  for (const secret of ['tokens-secret-value', 'secret-project', 'service-secret-value', '/safe/package']) {
    assert.equal(serialized.includes(secret), false)
  }
})

test('invalid ownership config performs no database, status, or runtime reads', async () => {
  let calls = 0
  await assert.rejects(() => runPhase2Check({
    args: ['--mode', 'preflight'],
    env: phase2Env({ FEED_V3_LEGACY_ENTITY_DISABLED_SOURCES: '' }),
  }, {
    probeDatabase() { calls += 1; throw new Error('must not run') },
    async readRuntime() { calls += 1; throw new Error('must not run') },
    async readControlPlane() { calls += 1; throw new Error('must not run') },
  }))
  assert.equal(calls, 0)
})

test('identical database paths block before opening either store', async () => {
  let calls = 0
  const report = await runPhase2Check({
    args: ['--mode', 'preflight'],
    env: phase2Env({ NEWS_SQLITE_PATH: '.data/shared.sqlite', PIPELINE_SQLITE_PATH: '.data/shared.sqlite' }),
  }, {
    probeDatabase() { calls += 1; throw new Error('must not run') },
    async readRuntime() { calls += 1; throw new Error('must not run') },
  })
  assert.equal(calls, 0)
  assert.equal(report.ready, false)
  assert.equal(report.checks.some((check) => (
    check.code === 'DB_BASENAMES_DISTINCT' && check.status === 'block'
  )), true)
})

test('runtime mode invokes existing read-only status composition and fails closed on missing telemetry', async () => {
  let statusCalls = 0
  const report = await runPhase2Check({
    args: ['--mode', 'runtime', '--max-cost-usd-micros-per-packet', '1000'],
    env: phase2Env({
      FEED_V3_STATUS_ALERT_POLICY_JSON: JSON.stringify({
        queueAgeSloMs: { news: { P0: 60000, P1: 120000 }, polymarket: { P0: 60000, P1: 120000 } },
        providerErrorRateThreshold: 0.1,
        deadLetterCountThreshold: 0,
      }),
    }),
  }, {
    probeDatabase(_path, source) {
      return { source, basename: `${source}.sqlite`, available: true, integrity: 'ok' }
    },
    async readRuntime() {
      return {
        researchRuntime: { availability: 'missing', snapshot: null },
        entityRuntime: { availability: 'missing', snapshot: null },
      }
    },
    async readControlPlane() {
      statusCalls += 1
      throw new Error('simulated unavailable status')
    },
  })
  assert.equal(statusCalls, 1)
  assert.equal(report.ready, false)
  assert.equal(report.checks.some((check) => (
    check.code === 'CONTROL_PLANE_AVAILABILITY' && check.status === 'block'
  )), true)
})

test('SQLite probe uses read-only quick_check and preserves fixture bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'myboon-phase2-probe-'))
  try {
    const path = join(directory, 'fixture.sqlite')
    const database = new DatabaseSync(path)
    database.exec('CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES (\'unchanged\')')
    database.close()
    const before = { bytes: readFileSync(path), stat: statSync(path) }

    const report = probeSqliteDatabaseReadOnly(path, 'news')

    const after = { bytes: readFileSync(path), stat: statSync(path) }
    assert.deepEqual(report, {
      source: 'news', basename: 'fixture.sqlite', available: true, integrity: 'ok',
    })
    assert.deepEqual(after.bytes, before.bytes)
    assert.equal(after.stat.size, before.stat.size)
    assert.equal(after.stat.mtimeMs, before.stat.mtimeMs)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
