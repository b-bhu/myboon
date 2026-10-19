import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runFirstThenInterval } from '../pipeline-store/interval-runner'
import { SqliteSignalPlatformStore } from '../signal-platform/sqlite-platform-store'
import { defaultRuntimeControl } from '../signal-platform/runtime-control'
import {
  createSharedEntityRuntime,
  isSharedEntityProcessEntrypoint,
  waitForSharedEntityShutdown,
  type SharedEntityShutdownSignalPort,
} from './run-shared'
import type { PostgresKnowledgeOperationWriter } from './postgres-knowledge-writer'
import type { SharedEntityWorkerOptions } from './shared-worker'
import { SqliteEntityShadowObservationStore } from './sqlite-shadow-observation-store'

const noOpHealthWriter = { async write() {} }

test('shared Entity entrypoint runs both directly and through PM2', () => {
  assert.equal(isSharedEntityProcessEntrypoint({ direct: true, nodeAppInstance: undefined }), true)
  assert.equal(isSharedEntityProcessEntrypoint({ direct: false, nodeAppInstance: '0' }), true)
  assert.equal(isSharedEntityProcessEntrypoint({ direct: false, nodeAppInstance: undefined }), false)
})

function workerFactory(capture: (options: SharedEntityWorkerOptions) => void) {
  return (options: SharedEntityWorkerOptions) => {
    capture(options)
    return {
      async runShadowCycle() {
        return { inspected: 0, sampled: 0, accepted: 0, rejected: 0 }
      },
      async runActiveCycle() {
        return {
          claimed: 0, completed: 0, retryWait: 0, deadLettered: 0,
          released: 0, staleLeases: 0, sourceErrors: {},
        }
      },
      stop() {},
      async drain() {},
    }
  }
}

function cutoverManifest(path: string, sources: Array<'news' | 'polymarket' | 'market_calendar' | 'x'>): string {
  const manifestPath = join(path, 'cutover-receipts.json')
  const receipts = sources.map((sourceType) => {
    const shadowName = `entity-${sourceType}-shadow.json`
    const shadowBytes = JSON.stringify({
      schemaVersion: 'myboon.feed_v3_shadow_evaluation.v1', sourceType, stage: 'entity',
      passed: true, sampleSize: 1_000,
    })
    writeFileSync(join(path, shadowName), shadowBytes)
    const rollbackName = `entity-${sourceType}-rollback.json`
    const rollbackBytes = JSON.stringify({
      schemaVersion: 'myboon.feed_v3_rollback_rehearsal.v1', sourceType, stage: 'entity',
      passed: true, rehearsedAt: '2026-08-26T00:00:00.000Z',
    })
    writeFileSync(join(path, rollbackName), rollbackBytes)
    return {
      schemaVersion: 'myboon.feed_v3_cutover_receipt.v1',
      receiptId: `entity-${sourceType}-approved`, sourceType, stage: 'entity',
      approvedAt: '2026-08-26T00:00:00.000Z', approvedBy: 'feed-v3-test',
      attestationMode: 'manual_review', expiresAt: '2099-08-26T00:00:00.000Z',
      shadowEvaluation: {
        sampleSize: 1_000, passed: true, artifactPath: shadowName,
        artifactSchemaVersion: 'myboon.feed_v3_shadow_evaluation.v1',
        artifactSha256: createHash('sha256').update(shadowBytes).digest('hex'),
      },
      rollbackRehearsal: {
        rehearsedAt: '2026-08-26T00:00:00.000Z', passed: true, artifactPath: rollbackName,
        artifactSchemaVersion: 'myboon.feed_v3_rollback_rehearsal.v1',
        artifactSha256: createHash('sha256').update(rollbackBytes).digest('hex'),
      },
    }
  })
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 'myboon.feed_v3_cutover_manifest.v1',
    receipts,
  }))
  return manifestPath
}

test('shared Entity runtime is safe-off before opening any durable or provider dependency', async () => {
  let constructed = 0
  let controlReads = 0
  const runtime = createSharedEntityRuntime({
    env: {},
    storeFactory() { constructed += 1; throw new Error('must not open') },
    gatewayFactory() { constructed += 1; throw new Error('must not open') },
    runtimeControl: { read() { controlReads += 1; return defaultRuntimeControl() } },
    healthWriterFactory() { constructed += 1; throw new Error('must not open health') },
  })

  assert.equal(runtime.mode, 'off')
  assert.deepEqual(await runtime.runCycle(), { mode: 'off' })
  assert.equal(constructed, 0)
  assert.equal(controlReads, 0)
  await runtime.close()
})

test('inert CLI shutdown wait stays pending and resolves cleanly on the first signal', async () => {
  const signals = new EventEmitter() as EventEmitter & SharedEntityShutdownSignalPort
  let closed = 0
  const pending = waitForSharedEntityShutdown(async () => { closed += 1 }, signals)
  await Promise.resolve()
  assert.equal(closed, 0)
  signals.emit('SIGTERM')
  signals.emit('SIGINT')
  await pending
  assert.equal(closed, 1)
  assert.equal(signals.listenerCount('SIGTERM'), 0)
  assert.equal(signals.listenerCount('SIGINT'), 0)
})

test('shadow composition writes observations source-locally without provider construction', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'myboon-entity-shadow-'))
  const path = join(directory, 'polymarket-lane.sqlite')
  new SqliteSignalPlatformStore(path, 'polymarket').close()
  let captured: SharedEntityWorkerOptions | undefined
  let forbiddenConstruction = 0
  const healthSnapshots: unknown[] = []
  try {
    const runtime = createSharedEntityRuntime({
      env: {
        FEED_V3_RESEARCH_MODE: 'shadow',
        FEED_V3_RESEARCH_SHADOW_SOURCES: 'news',
        FEED_V3_ENTITY_MODE: 'shadow',
        FEED_V3_ENTITY_SHADOW_SOURCES: 'polymarket',
        FEED_V3_SHADOW_SAMPLE_BASIS_POINTS: '500',
        PIPELINE_SQLITE_PATH: path,
      },
      gatewayFactory() { forbiddenConstruction += 1; throw new Error('shadow provider') },
      healthWriter: { async write(snapshot) { healthSnapshots.push(snapshot) } },
      runtimeControl: { read: defaultRuntimeControl },
      workerFactory: workerFactory((options) => { captured = options }),
    })

    assert.equal(runtime.mode, 'shadow')
    assert.deepEqual([...captured!.config.shadowSources], ['polymarket'])
    assert.deepEqual(captured!.ports.map((port) => port.sourceType), ['polymarket'])
    assert.equal(captured!.executionLedger, undefined)
    assert.equal(forbiddenConstruction, 0)
    await captured!.shadowObservations.observe({
      sourceType: 'polymarket', workId: 'shadow-work', packetId: 'shadow-packet',
      outcome: 'accepted', error: null, executionEvent: null,
    })
    assert.equal((await runtime.runCycle()).mode, 'shadow')
    const shadowHealth = healthSnapshots[0] as {
      mode: string
      lifecycleState: string
      desiredState: string
      circuit: { ready: unknown }
    }
    assert.equal(shadowHealth.mode, 'shadow')
    assert.equal(shadowHealth.lifecycleState, 'running')
    assert.equal(shadowHealth.desiredState, 'running')
    assert.equal(shadowHealth.circuit.ready, null)
    await runtime.close()
    assert.equal((healthSnapshots.at(-1) as { lifecycleState: string }).lifecycleState, 'stopped')
    const observations = new SqliteEntityShadowObservationStore(path)
    assert.equal(observations.listByWork('shadow-work').length, 1)
    observations.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('active cutover receipts fail closed before opening SQLite or providers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'myboon-entity-receipt-preflight-'))
  const receiptPath = join(directory, 'cutover-receipts.json')
  writeFileSync(receiptPath, JSON.stringify({
    schemaVersion: 'myboon.feed_v3_cutover_manifest.v1',
    receipts: [],
  }))
  let constructed = 0
  try {
    assert.throws(() => createSharedEntityRuntime({
      env: {
        FEED_V3_ENTITY_MODE: 'active',
        FEED_V3_ENTITY_ACTIVE_SOURCES: 'news',
        FEED_V3_LEGACY_ENTITY_DISABLED_SOURCES: 'news',
        FEED_V3_CUTOVER_RECEIPT_PATH: receiptPath,
        NEWS_SQLITE_PATH: join(directory, 'news-lane.sqlite'),
      },
      storeFactory() { constructed += 1; throw new Error('must not open') },
      gatewayFactory() { constructed += 1; throw new Error('must not open') },
    }), /Cutover receipt missing for entity:news/)
    assert.equal(constructed, 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('full policy rejects missing and invalid receipts before any dependency construction', () => {
  const directory = mkdtempSync(join(tmpdir(), 'myboon-entity-full-invalid-'))
  const missingPath = join(directory, 'missing-cutover.json')
  let constructed = 0
  try {
    // Missing receipt path must fail before the SQLite existence check.
    assert.throws(() => createSharedEntityRuntime({
      env: {
        FEED_V3_ENTITY_MODE: 'active',
        FEED_V3_ENTITY_ACTIVE_SOURCES: 'news',
        FEED_V3_LEGACY_ENTITY_DISABLED_SOURCES: 'news',
        FEED_V3_CUTOVER_RECEIPT_PATH: missingPath,
        NEWS_SQLITE_PATH: join(directory, 'news-lane.sqlite'),
      },
      storeFactory() { constructed += 1; throw new Error('must not open') },
      gatewayFactory() { constructed += 1; throw new Error('must not open') },
    }), /receipt manifest/i)
    assert.equal(constructed, 0)

    const invalidPath = join(directory, 'cutover-receipts.json')
    writeFileSync(invalidPath, JSON.stringify({
      schemaVersion: 'myboon.feed_v3_cutover_manifest.v1',
      receipts: [],
    }))
    assert.throws(() => createSharedEntityRuntime({
      env: {
        FEED_V3_ENTITY_MODE: 'active',
        FEED_V3_ENTITY_ACTIVE_SOURCES: 'news',
        FEED_V3_LEGACY_ENTITY_DISABLED_SOURCES: 'news',
        FEED_V3_CUTOVER_RECEIPT_PATH: invalidPath,
        NEWS_SQLITE_PATH: join(directory, 'news-lane.sqlite'),
      },
      storeFactory() { constructed += 1; throw new Error('must not open') },
      gatewayFactory() { constructed += 1; throw new Error('must not open') },
    }), /Cutover receipt missing for entity:news/)
    assert.equal(constructed, 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('phase1 accepts news and polymarket with no receipt when all invariants are valid', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'myboon-entity-phase1-accept-'))
  const newsPath = join(directory, 'news-lane.sqlite')
  const pipelinePath = join(directory, 'polymarket-lane.sqlite')
  new SqliteSignalPlatformStore(newsPath, 'news').close()
  new SqliteSignalPlatformStore(pipelinePath, 'polymarket').close()
  let captured: SharedEntityWorkerOptions | undefined
  try {
    const runtime = createSharedEntityRuntime({
      env: {
        FEED_V3_CUTOVER_POLICY: 'phase1',
        FEED_V3_ENTITY_MODE: 'active',
        FEED_V3_ENTITY_ACTIVE_SOURCES: 'news,polymarket',
        FEED_V3_LEGACY_ENTITY_DISABLED_SOURCES: 'news,polymarket',
        FEED_V3_TRIAGE_PROVIDER_HEALTH: 'healthy',
        NEWS_SQLITE_PATH: newsPath,
        PIPELINE_SQLITE_PATH: pipelinePath,
        ENTITY_V4_MANAGED_WRITER_ENABLED: '1',
        ENTITY_V4_ACTIVE_SOURCES: 'news,polymarket',
        ENTITY_V4_SOURCE_OWNERSHIP_ENABLED: '1',
        ENTITY_V4_POLICY_VERSION: 'policy-v1',
        MYBOON_MANAGED_KNOWLEDGE_DATABASE_URL: 'postgres://fixtures.invalid:5432/knowledge',
      },
      storeFactory(databasePath, sourceType) {
        return new SqliteSignalPlatformStore(databasePath, sourceType)
      },
      managedWriterFactory() {
        return { close() {} } as unknown as PostgresKnowledgeOperationWriter
      },
      healthWriter: noOpHealthWriter,
      workerFactory: workerFactory((options) => { captured = options }),
    })
    assert.equal(runtime.mode, 'active')
    assert.deepEqual(captured!.ports.map((port) => port.sourceType), ['news', 'polymarket'])
    assert.deepEqual([...captured!.researchDepths!], ['light'])
    await runtime.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('phase1 rejects invalid invariants before any dependency construction', () => {
  const directory = mkdtempSync(join(tmpdir(), 'myboon-entity-phase1-reject-'))
  const newsPath = join(directory, 'news-lane.sqlite')
  const pipelinePath = join(directory, 'polymarket-lane.sqlite')
  new SqliteSignalPlatformStore(newsPath, 'news').close()
  new SqliteSignalPlatformStore(pipelinePath, 'polymarket').close()
  const base = {
    FEED_V3_CUTOVER_POLICY: 'phase1',
    FEED_V3_ENTITY_MODE: 'active',
    FEED_V3_ENTITY_ACTIVE_SOURCES: 'news,polymarket',
    FEED_V3_LEGACY_ENTITY_DISABLED_SOURCES: 'news,polymarket',
    FEED_V3_TRIAGE_PROVIDER_HEALTH: 'healthy',
    NEWS_SQLITE_PATH: newsPath,
    PIPELINE_SQLITE_PATH: pipelinePath,
  }
  const cases: Array<{ env: Record<string, string>, pattern: RegExp }> = [
    // standard depth admitted
    { env: { FEED_V3_TRIAGE_ALLOWED_DEPTHS: 'light,standard' }, pattern: /exactly light/ },
    // deep research enabled (loader requires active research ownership first)
    { env: { FEED_V3_DEEP_RESEARCH_ENABLED: '1', FEED_V3_RESEARCH_MODE: 'active', FEED_V3_RESEARCH_ACTIVE_SOURCES: 'news', FEED_V3_LEGACY_RESEARCH_DISABLED_SOURCES: 'news' }, pattern: /deep research to be disabled/ },
    // triage classifier enabled
    { env: { FEED_V3_TRIAGE_CLASSIFIER_ENABLED: '1' }, pattern: /triage classifier to be disabled/ },
    // non-healthy provider
    { env: { FEED_V3_TRIAGE_PROVIDER_HEALTH: 'degraded' }, pattern: /healthy triage provider health/ },
    // unsupported source (rejected by the config loader's Phase 1 scope guard
    // before the phase1 cutover guard, still before any dependency construction)
    { env: { FEED_V3_ENTITY_ACTIVE_SOURCES: 'news,x', FEED_V3_LEGACY_ENTITY_DISABLED_SOURCES: 'news,x' }, pattern: /Phase 1 does not admit active source: x/ },
    // missing legacy-disabled ownership (rejected by the config loader before
    // the phase1 guard, still before any dependency construction)
    { env: { FEED_V3_LEGACY_ENTITY_DISABLED_SOURCES: 'news' }, pattern: /legacy-disabled sources: polymarket/ },
  ]
  try {
    for (const { env, pattern } of cases) {
      let constructed = 0
      assert.throws(() => createSharedEntityRuntime({
        env: { ...base, ...env },
        storeFactory() { constructed += 1; throw new Error('must not open') },
        gatewayFactory() { constructed += 1; throw new Error('must not open') },
      }), pattern)
      assert.equal(constructed, 0)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('off and shadow entity never evaluate active cutover authorization', async () => {
  let constructed = 0
  const off = createSharedEntityRuntime({
    env: {},
    storeFactory() { constructed += 1; throw new Error('must not open') },
    gatewayFactory() { constructed += 1; throw new Error('must not open') },
  })
  assert.equal(off.mode, 'off')
  assert.equal(constructed, 0)
  await off.close()

  const directory = mkdtempSync(join(tmpdir(), 'myboon-entity-phase1-shadow-'))
  const path = join(directory, 'polymarket-lane.sqlite')
  new SqliteSignalPlatformStore(path, 'polymarket').close()
  try {
    const runtime = createSharedEntityRuntime({
      env: {
        FEED_V3_CUTOVER_POLICY: 'phase1',
        FEED_V3_ENTITY_MODE: 'shadow',
        FEED_V3_ENTITY_SHADOW_SOURCES: 'polymarket',
        FEED_V3_SHADOW_SAMPLE_BASIS_POINTS: '500',
        PIPELINE_SQLITE_PATH: path,
      },
      gatewayFactory() { constructed += 1; throw new Error('shadow must not open') },
      healthWriter: noOpHealthWriter,
      workerFactory: workerFactory(() => undefined),
    })
    assert.equal(runtime.mode, 'shadow')
    assert.equal(constructed, 0)
    await runtime.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('durable Entity drain control prevents claims while resident and resume re-enables them', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'myboon-entity-runtime-control-'))
  const path = join(directory, 'news-lane.sqlite')
  const receiptPath = cutoverManifest(directory, ['news'])
  let desiredState: 'running' | 'draining' = 'draining'
  let controlUnavailable = true
  let activeCycles = 0
  let capturedWorkerOptions: SharedEntityWorkerOptions | undefined
  try {
    const runtime = createSharedEntityRuntime({
      env: {
        FEED_V3_ENTITY_MODE: 'active',
        FEED_V3_ENTITY_ACTIVE_SOURCES: 'news',
        FEED_V3_LEGACY_ENTITY_DISABLED_SOURCES: 'news',
        FEED_V3_CUTOVER_RECEIPT_PATH: receiptPath,
        NEWS_SQLITE_PATH: path,
        ENTITY_V4_MANAGED_WRITER_ENABLED: '1',
        ENTITY_V4_ACTIVE_SOURCES: 'news',
        ENTITY_V4_SOURCE_OWNERSHIP_ENABLED: '1',
        ENTITY_V4_POLICY_VERSION: 'policy-v1',
        MYBOON_MANAGED_KNOWLEDGE_DATABASE_URL: 'postgres://fixtures.invalid:5432/knowledge',
      },
      runtimeControl: {
        read() {
          if (controlUnavailable) throw new Error('raw control parse details must not escape')
          const control = defaultRuntimeControl()
          return {
            ...control,
            stages: {
              ...control.stages,
              entity: { desiredState, changedAt: null, operationId: null },
            },
          }
        },
      },
      storeFactory(databasePath, sourceType) {
        return new SqliteSignalPlatformStore(databasePath, sourceType)
      },
      managedWriterFactory() {
        return { close() {} } as unknown as PostgresKnowledgeOperationWriter
      },
      healthWriter: noOpHealthWriter,
      workerFactory: (workerOptions) => {
        capturedWorkerOptions = workerOptions
        return {
          async runShadowCycle() { return { inspected: 0, sampled: 0, accepted: 0, rejected: 0 } },
          async runActiveCycle() {
            activeCycles += 1
            return {
              claimed: 0, completed: 0, retryWait: 0, deadLettered: 0,
              released: 0, staleLeases: 0, sourceErrors: {},
            }
          },
          stop() {},
          async drain() {},
        }
      },
    })

    assert.equal(capturedWorkerOptions!.claimsEnabled?.(), false)
    const unavailable = await runtime.runCycle()
    assert.deepEqual(unavailable, {
      mode: 'active',
      controlState: 'draining',
      controlStatus: 'unavailable',
      result: {
        claimed: 0, completed: 0, retryWait: 0, deadLettered: 0,
        released: 0, staleLeases: 0, sourceErrors: {},
      },
    })
    assert.doesNotMatch(JSON.stringify(unavailable), /raw control parse details/)
    assert.equal(activeCycles, 0)

    controlUnavailable = false
    assert.equal(capturedWorkerOptions!.claimsEnabled?.(), false)
    const operatorDrain = await runtime.runCycle()
    assert.equal(operatorDrain.mode, 'active')
    if (operatorDrain.mode !== 'active') throw new Error('Expected active Entity cycle')
    assert.equal(operatorDrain.controlState, 'draining')
    assert.equal(operatorDrain.controlStatus, 'ok')
    assert.equal(activeCycles, 0)

    desiredState = 'running'
    assert.equal(capturedWorkerOptions!.claimsEnabled?.(), true)
    const resumed = await runtime.runCycle()
    assert.equal(resumed.mode, 'active')
    if (resumed.mode !== 'active') throw new Error('Expected active Entity cycle')
    assert.equal(resumed.controlState, 'running')
    assert.equal(resumed.controlStatus, 'ok')
    assert.equal(activeCycles, 1)

    desiredState = 'draining'
    const drainedAgain = await runtime.runCycle()
    assert.equal(drainedAgain.mode, 'active')
    if (drainedAgain.mode !== 'active') throw new Error('Expected active Entity cycle')
    assert.equal(drainedAgain.controlState, 'draining')
    assert.equal(drainedAgain.controlStatus, 'ok')
    assert.equal(activeCycles, 1)
    await runtime.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('active mode without the managed writer throws before opening providers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'myboon-entity-managed-required-'))
  const path = join(directory, 'news-lane.sqlite')
  const receiptPath = cutoverManifest(directory, ['news'])
  let constructed = 0
  try {
    assert.throws(() => createSharedEntityRuntime({
      env: {
        FEED_V3_CUTOVER_POLICY: 'phase1',
        FEED_V3_ENTITY_MODE: 'active',
        FEED_V3_ENTITY_ACTIVE_SOURCES: 'news',
        FEED_V3_LEGACY_ENTITY_DISABLED_SOURCES: 'news',
        FEED_V3_TRIAGE_PROVIDER_HEALTH: 'healthy',
        NEWS_SQLITE_PATH: path,
      },
      storeFactory() { constructed += 1; throw new Error('must not open') },
      gatewayFactory() { constructed += 1; throw new Error('must not open') },
    }), /Active shared Entity processing requires ENTITY_V4_MANAGED_WRITER_ENABLED=1 \(the legacy public\.entities writer was retired in #337\)/)
    assert.equal(constructed, 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('managed-writer active runtime is ungated: no Supabase dependency and ticks run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'myboon-entity-gate-managed-'))
  const receiptPath = cutoverManifest(directory, ['news'])
  try {
    const runtime = createSharedEntityRuntime({
      env: {
        FEED_V3_ENTITY_MODE: 'active',
        FEED_V3_ENTITY_ACTIVE_SOURCES: 'news',
        FEED_V3_LEGACY_ENTITY_DISABLED_SOURCES: 'news',
        FEED_V3_CUTOVER_RECEIPT_PATH: receiptPath,
        NEWS_SQLITE_PATH: join(directory, 'news-lane.sqlite'),
        ENTITY_V4_MANAGED_WRITER_ENABLED: '1',
        ENTITY_V4_ACTIVE_SOURCES: 'news',
        ENTITY_V4_SOURCE_OWNERSHIP_ENABLED: '1',
        ENTITY_V4_POLICY_VERSION: 'policy-v1',
        MYBOON_MANAGED_KNOWLEDGE_DATABASE_URL: 'postgres://fixtures.invalid:5432/knowledge',
      },
      storeFactory(databasePath, sourceType) {
        return new SqliteSignalPlatformStore(databasePath, sourceType)
      },
      managedWriterFactory() {
        // Composition only stores the writer and closes it; nothing calls it.
        return { close() {} } as unknown as PostgresKnowledgeOperationWriter
      },
      healthWriter: noOpHealthWriter,
      runtimeControl: { read: defaultRuntimeControl },
      workerFactory: workerFactory(() => undefined),
    })

    assert.equal(runtime.mode, 'active')

    // With no health gate the first scheduled tick must run instead of being skipped.
    let runs = 0
    const interval = await runFirstThenInterval({
      label: 'test:entity-managed-ungated',
      intervalMs: 3_600_000,
      runOnce: false,
      run: async () => { runs += 1 },
    })
    try {
      assert.equal(runs, 1)
    } finally {
      interval?.stop()
    }
    await runtime.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
