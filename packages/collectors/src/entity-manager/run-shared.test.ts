import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SqliteSignalPlatformStore } from '../signal-platform/sqlite-platform-store'
import {
  createSharedEntityRuntime,
  waitForSharedEntityShutdown,
  type SharedEntityShutdownSignalPort,
} from './run-shared'
import type { SharedEntityWorkerOptions } from './shared-worker'
import { SqliteEntityShadowObservationStore } from './sqlite-shadow-observation-store'

function migrationReport(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'myboon.entity_memory_migration_verification.v1',
    total_rows: 0,
    null_identity_keys: 0,
    duplicate_identity_key_groups: 0,
    identity_column_exists: true,
    identity_not_null: true,
    required_indexes: {
      entity_memories_identity_key_unique_idx: true,
      entity_memories_observed_cursor_idx: true,
      entity_memories_updated_cursor_idx: true,
      entity_memories_priority_observed_cursor_idx: true,
    },
    required_functions: {
      entity_manager_lookup_entities_v1: true,
      entity_manager_create_entity_v1: true,
    },
    service_role_grants: {
      entity_manager_lookup_entities_v1: true,
      entity_manager_create_entity_v1: true,
    },
    rolling_trigger_present: true,
    ...overrides,
  }
}

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

test('shared Entity runtime is safe-off before opening any durable or provider dependency', async () => {
  let constructed = 0
  const runtime = createSharedEntityRuntime({
    env: {},
    storeFactory() { constructed += 1; throw new Error('must not open') },
    supabaseFactory() { constructed += 1; throw new Error('must not open') },
    gatewayFactory() { constructed += 1; throw new Error('must not open') },
  })

  assert.equal(runtime.mode, 'off')
  assert.deepEqual(await runtime.runCycle(), { mode: 'off' })
  assert.equal(constructed, 0)
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

test('shadow composition writes observations source-locally without Supabase/provider construction', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'myboon-entity-shadow-'))
  const path = join(directory, 'pipeline.sqlite')
  new SqliteSignalPlatformStore(path, 'polymarket').close()
  let captured: SharedEntityWorkerOptions | undefined
  let forbiddenConstruction = 0
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
      supabaseFactory() { forbiddenConstruction += 1; throw new Error('shadow write') },
      gatewayFactory() { forbiddenConstruction += 1; throw new Error('shadow provider') },
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
    await runtime.close()
    const observations = new SqliteEntityShadowObservationStore(path)
    assert.equal(observations.listByWork('shadow-work').length, 1)
    observations.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('active composition requires explicit legacy cutover and wires scoped ownership', async () => {
  assert.throws(() => createSharedEntityRuntime({
    env: {
      FEED_V3_ENTITY_MODE: 'active',
      FEED_V3_ENTITY_ACTIVE_SOURCES: 'news',
    },
  }), /legacy-disabled sources: news/)

  const directory = mkdtempSync(join(tmpdir(), 'myboon-entity-active-'))
  const path = join(directory, 'news.sqlite')
  let captured: SharedEntityWorkerOptions | undefined
  try {
    const runtime = createSharedEntityRuntime({
      env: {
        FEED_V3_ENTITY_MODE: 'active',
        FEED_V3_ENTITY_ACTIVE_SOURCES: 'news',
        FEED_V3_LEGACY_ENTITY_DISABLED_SOURCES: 'news',
        NEWS_SQLITE_PATH: path,
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'test-only',
      },
      storeFactory(databasePath, sourceType) {
        return new SqliteSignalPlatformStore(databasePath, sourceType)
      },
      supabaseFactory() {
        return { async rpc() { return { data: migrationReport(), error: null } } } as never
      },
      gatewayFactory() {
        return { async generateStructured() { throw new Error('not invoked during composition') } } as never
      },
      workerFactory: workerFactory((options) => { captured = options }),
    })

    assert.equal(runtime.mode, 'active')
    assert.equal(captured!.config.ownership.news, 'shared')
    assert.equal(captured!.config.ownership.polymarket, 'legacy')
    assert.deepEqual(captured!.ports.map((port) => port.sourceType), ['news'])
    assert.ok(captured!.executionLedger)
    assert.equal((await runtime.runCycle()).mode, 'active')
    await runtime.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('active migration preflight fails before the worker can claim', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'myboon-entity-preflight-'))
  const path = join(directory, 'news.sqlite')
  let activeCycles = 0
  try {
    const runtime = createSharedEntityRuntime({
      env: {
        FEED_V3_ENTITY_MODE: 'active',
        FEED_V3_ENTITY_ACTIVE_SOURCES: 'news',
        FEED_V3_LEGACY_ENTITY_DISABLED_SOURCES: 'news',
        NEWS_SQLITE_PATH: path,
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'test-only',
      },
      storeFactory(databasePath, sourceType) {
        return new SqliteSignalPlatformStore(databasePath, sourceType)
      },
      supabaseFactory() {
        return {
          async rpc() {
            return { data: migrationReport({ rolling_trigger_present: false }), error: null }
          },
        } as never
      },
      gatewayFactory() {
        return { async generateStructured() { throw new Error('must not run') } } as never
      },
      workerFactory: (options) => ({
        async runShadowCycle() { return { inspected: 0, sampled: 0, accepted: 0, rejected: 0 } },
        async runActiveCycle() {
          activeCycles += 1
          return {
            claimed: 0, completed: 0, retryWait: 0, deadLettered: 0,
            released: 0, staleLeases: 0, sourceErrors: {},
          }
        },
        stop: (input) => { options.processor; input },
        async drain() {},
      }),
    })
    await assert.rejects(runtime.runCycle(), /migration is incomplete/)
    assert.equal(activeCycles, 0)
    await runtime.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
