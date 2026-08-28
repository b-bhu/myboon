import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  createConfiguredInferenceGateway,
  type InferenceCircuitStatusSnapshot,
  type InferenceTelemetryObserver,
} from '../inference-gateway'
import { envFlag, loadDotenvChain, positiveInteger } from '../pipeline-store/cli-env'
import { startIntervalRunner } from '../pipeline-store/interval-runner'
import type { ExecutionTraceEvent, Signal } from '../signal-platform/contracts'
import { assertActiveCutoverReceipts } from '../signal-platform/cutover-receipt'
import type { ExecutionEventAppendResult } from '../signal-platform/execution-ledger'
import { loadFeedV3RuntimeConfig, type FeedV3RuntimeConfig } from '../signal-platform/runtime-config'
import {
  FileRuntimeControlStore,
  resolveRuntimeControlPath,
  stageRuntimeControl,
  type RuntimeControlReadPort,
} from '../signal-platform/runtime-control'
import { SqliteExecutionLedger } from '../signal-platform/sqlite-execution-ledger'
import { SqliteSignalPlatformStore } from '../signal-platform/sqlite-platform-store'
import {
  FileSqliteWriteHealthJournal,
  resolveSqliteWriteHealthJournalPath,
} from '../signal-platform/sqlite-write-error-journal'
import { EntityServiceCanonicalPacketProcessor } from './canonical-processor'
import { GatewayCanonicalEntityPlanner } from './canonical-planner'
import {
  AtomicEntityRuntimeHealthFile,
  EntityRuntimeHealthTracker,
  type EntityRuntimeHealthWriter,
} from './entity-runtime-health'
import { assertEntityMemoryMigrationReady } from './entity-memory-migration-verifier'
import {
  SharedEntityWorker,
  type ActiveCycleResult,
  type ShadowCycleResult,
  type ShadowEntityObservationPort,
  type SharedEntityWorkerOptions,
} from './shared-worker'
import { sharedEntityWorkerConfig } from './shared-worker-config'
import { SqliteEntityPacketWorkPort } from './sqlite-entity-work-port'
import { SqliteEntityShadowObservationStore } from './sqlite-shadow-observation-store'
import { SupabaseEntityMemoryStore } from './supabase-store'

const PACKAGE_DIR = resolve(__dirname, '..', '..')
const DEFAULT_INTERVAL_MS = 30_000
const INERT_KEEP_ALIVE_INTERVAL_MS = 2_147_483_647
const DEFAULT_ENTITY_RUNTIME_STATUS_PATH = '.data/feed-v3-entity-runtime-status.json'

export type SharedEntityCycleResult =
  | { mode: 'off' }
  | { mode: 'shadow', result: ShadowCycleResult }
  | {
    mode: 'active'
    controlState: 'running' | 'draining'
    controlStatus: 'ok' | 'unavailable'
    result: ActiveCycleResult
  }

export interface SharedEntityRuntime {
  mode: FeedV3RuntimeConfig['entityMode']
  runCycle(): Promise<SharedEntityCycleResult>
  stop(input?: { abortActive?: boolean }): void
  close(): Promise<void>
}

interface WorkerRuntimePort {
  runShadowCycle(): Promise<ShadowCycleResult>
  runActiveCycle(): Promise<ActiveCycleResult>
  stop(input?: { abortActive?: boolean }): void
  drain(): Promise<void>
}

interface Closable { close(): void }

export interface SharedEntityShutdownSignalPort {
  once(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown
  removeListener(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown
}

export interface CreateSharedEntityRuntimeOptions {
  env?: Readonly<Record<string, string | undefined>>
  storeFactory?: (path: string, sourceType: Signal['sourceType'], readOnly: boolean) => SqliteSignalPlatformStore
  supabaseFactory?: (url: string, serviceRoleKey: string) => SupabaseClient
  ledgerFactory?: (path: string) => SqliteExecutionLedger
  gatewayFactory?: (
    env: Readonly<Record<string, string | undefined>>,
    observer: InferenceTelemetryObserver,
  ) => ReturnType<typeof createConfiguredInferenceGateway>['gateway']
  workerFactory?: (options: SharedEntityWorkerOptions) => WorkerRuntimePort
  shadowObservations?: ShadowEntityObservationPort
  shadowObservationFactory?: (path: string) => SqliteEntityShadowObservationStore
  runtimeControl?: RuntimeControlReadPort
  healthWriter?: EntityRuntimeHealthWriter
  healthWriterFactory?: (path: string) => EntityRuntimeHealthWriter
  now?: () => Date
}

/**
 * Production composition boundary. Safe-off returns before opening SQLite,
 * reading Supabase credentials, or constructing inference providers.
 */
export function createSharedEntityRuntime(options: CreateSharedEntityRuntimeOptions = {}): SharedEntityRuntime {
  const env = options.env ?? process.env
  const runtime = loadFeedV3RuntimeConfig(env)
  if (runtime.entityMode === 'off') return disabledRuntime()
  const now = options.now ?? (() => new Date())

  const sources = runtime.entityMode === 'shadow'
    ? runtime.entityShadowSources
    : runtime.entityActiveSources
  if (sources.size === 0) throw new Error(`Shared Entity ${runtime.entityMode} mode has no configured sources.`)
  if (runtime.entityMode === 'active') {
    assertActiveCutoverReceipts({
      path: runtime.cutoverReceiptPath!,
      required: [...runtime.entityActiveSources].map((sourceType) => ({ sourceType, stage: 'entity' })),
    })
  }
  const sourcePaths = new Map<Signal['sourceType'], string>()
  const stores: SqliteSignalPlatformStore[] = []
  const writeHealthJournal = !options.storeFactory
    ? new FileSqliteWriteHealthJournal(resolveSqliteWriteHealthJournalPath(env), {
      readOnly: runtime.entityMode === 'shadow',
    }) : null
  const storeFactory = options.storeFactory ?? ((path, sourceType, readOnly) =>
    new SqliteSignalPlatformStore(path, sourceType, { readOnly, writeHealthJournal }))
  for (const source of sources) {
    const path = sourceDatabasePath(source, env)
    if (!options.storeFactory && !existsSync(path)) {
      throw new Error(`${source} SQLite database does not exist at configured path ${path}`)
    }
    const store = storeFactory(path, source, runtime.entityMode === 'shadow')
    stores.push(store)
    sourcePaths.set(source, path)
  }

  const closables: Closable[] = [...stores]
  try {
    const healthTracker = new EntityRuntimeHealthTracker()
    const healthWriter = options.healthWriter
      ?? (options.healthWriterFactory ?? ((path) => new AtomicEntityRuntimeHealthFile(path)))(configuredPath(
        env.FEED_V3_ENTITY_RUNTIME_STATUS_PATH?.trim() || DEFAULT_ENTITY_RUNTIME_STATUS_PATH,
      ))
    const ports = stores.map((store) => new SqliteEntityPacketWorkPort(store))
    let shadowObservations = options.shadowObservations
    if (!shadowObservations && runtime.entityMode === 'shadow') {
      const byPath = new Map<string, SqliteEntityShadowObservationStore>()
      const bySource = new Map<Signal['sourceType'], SqliteEntityShadowObservationStore>()
      for (const [source, path] of sourcePaths) {
        let store = byPath.get(path)
        if (!store) {
          store = (options.shadowObservationFactory
            ?? ((value) => new SqliteEntityShadowObservationStore(value)))(path)
          byPath.set(path, store)
          closables.push(store)
        }
        bySource.set(source, store)
      }
      shadowObservations = {
        async observe(observation) {
          const store = bySource.get(observation.sourceType)
          if (!store) throw new Error(`No Entity shadow observation store for ${observation.sourceType}`)
          await store.observe(observation)
        },
      }
    }
    shadowObservations ??= noOpShadowObservations
    let processor: EntityServiceCanonicalPacketProcessor
    let executionLedger: SharedEntityWorkerOptions['executionLedger']
    let activePreflight: (() => Promise<void>) | undefined
    let circuitSnapshot: (() => InferenceCircuitStatusSnapshot) | undefined
    let inferenceClaimsReady = () => true

    if (runtime.entityMode === 'active') {
      const supabase = (options.supabaseFactory ?? createClient)(
        required(env, 'SUPABASE_URL'),
        required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
      )
      const entityStore = new SupabaseEntityMemoryStore(supabase)
      if (!entityStore.createCanonicalEntity || !entityStore.findEntitiesByIdentity) {
        throw new Error('Active shared Entity processing requires atomic canonical identity store capabilities.')
      }
      const observeInference: InferenceTelemetryObserver = (event) => healthTracker.observe(event, now().toISOString())
      const gateway = options.gatewayFactory
        ? options.gatewayFactory(env, observeInference)
        : createConfiguredInferenceGateway({ env, observer: observeInference }).gateway
      circuitSnapshot = () => gateway.circuitStatusSnapshot()
      inferenceClaimsReady = () => typeof gateway.checkReadiness === 'function'
        && gateway.checkReadiness('entity.extract').ready
      processor = new EntityServiceCanonicalPacketProcessor({
        store: entityStore,
        planner: new GatewayCanonicalEntityPlanner({ gateway }),
      })
      activePreflight = async () => { await assertEntityMemoryMigrationReady(supabase) }

      const ledgerByPath = new Map<string, SqliteExecutionLedger>()
      const ledgerBySource = new Map<Signal['sourceType'], SqliteExecutionLedger>()
      for (const [source, path] of sourcePaths) {
        let ledger = ledgerByPath.get(path)
        if (!ledger) {
          ledger = (options.ledgerFactory ?? ((value) => new SqliteExecutionLedger(value)))(path)
          ledgerByPath.set(path, ledger)
          closables.push(ledger)
        }
        ledgerBySource.set(source, ledger)
      }
      executionLedger = {
        append(event: ExecutionTraceEvent): ExecutionEventAppendResult {
          const ledger = ledgerBySource.get(event.sourceType)
          if (!ledger) throw new Error(`No Entity execution ledger for ${event.sourceType}`)
          return ledger.append(event)
        },
      }
    } else {
      processor = new EntityServiceCanonicalPacketProcessor({
        store: failClosedShadowStore(),
        planner: { async plan() { throw new Error('Shadow Entity worker cannot invoke the planner.') } },
      })
    }

    const ownership = Object.fromEntries(
      [...runtime.entityActiveSources].map((source) => [source, 'shared']),
    )
    const topology = Object.fromEntries([...runtime.entityActiveSources].map((source) => [source, {
      legacyActiveClaimers: runtime.legacyEntityDisabledSources.has(source) ? 0 : 1,
      sharedActiveClaimers: 1,
    }]))
    const config = sharedEntityWorkerConfig({
      ownership,
      shadowSources: [...runtime.entityShadowSources],
      shadowSampleBasisPoints: runtime.shadowSampleBasisPoints,
      runtimeTopology: topology,
    })
    const runtimeControl = options.runtimeControl ?? new FileRuntimeControlStore(resolveRuntimeControlPath(env))
    const worker = (options.workerFactory ?? ((input) => new SharedEntityWorker(input)))({
      config,
      ports,
      processor,
      shadowObservations,
      workerId: safeWorkerId(env.FEED_V3_ENTITY_WORKER_ID),
      activeLimitPerSource: positiveInteger(env.FEED_V3_ENTITY_BATCH_SIZE, 10),
      now,
      executionLedger,
      claimsEnabled: runtime.entityMode === 'active'
        ? () => entityClaimControl(runtimeControl).enabled && inferenceClaimsReady()
        : undefined,
    })
    return managedRuntime(runtime.entityMode, worker, closables, activePreflight, runtimeControl, {
      writer: healthWriter,
      tracker: healthTracker,
      circuitSnapshot,
      now,
    })
  } catch (error) {
    for (const resource of [...closables].reverse()) resource.close()
    throw error
  }
}

function managedRuntime(
  mode: Exclude<FeedV3RuntimeConfig['entityMode'], 'off'>,
  worker: WorkerRuntimePort,
  resources: Closable[],
  preflight?: () => Promise<void>,
  runtimeControl?: RuntimeControlReadPort,
  health?: {
    writer: EntityRuntimeHealthWriter
    tracker: EntityRuntimeHealthTracker
    circuitSnapshot?: () => InferenceCircuitStatusSnapshot
    now: () => Date
  },
): SharedEntityRuntime {
  let closed = false
  let ready: Promise<void> | null = null
  const ensureReady = async () => {
    if (!preflight) return
    ready ??= preflight().catch((error) => {
      ready = null
      throw error
    })
    await ready
  }
  const writeHealth = async (
    lifecycleState: 'running' | 'draining' | 'stopped',
    control = entityClaimControl(runtimeControl!),
  ) => {
    if (!health) return
    try {
      await health.writer.write(health.tracker.snapshot({
        capturedAt: health.now().toISOString(),
        mode,
        lifecycleState,
        desiredState: control.desiredState,
        controlStatus: control.status,
        circuit: safeCircuitSnapshot(health.circuitSnapshot),
      }))
    } catch {
      // Health is observational. A missing/invalid snapshot is visible to the
      // status command but must never alter a durable queue outcome.
    }
  }
  return {
    mode,
    async runCycle() {
      if (closed) throw new Error('Shared Entity runtime is closed.')
      if (mode === 'active') {
        const control = entityClaimControl(runtimeControl!)
        if (!control.enabled) {
          await writeHealth('draining', control)
          return { mode, controlState: 'draining', controlStatus: control.status, result: emptyActiveCycleResult() }
        }
        try {
          await ensureReady()
          return { mode, controlState: 'running', controlStatus: 'ok', result: await worker.runActiveCycle() }
        } finally {
          const finalControl = entityClaimControl(runtimeControl!)
          await writeHealth(finalControl.enabled ? 'running' : 'draining', finalControl)
        }
      }
      try {
        return { mode, result: await worker.runShadowCycle() }
      } finally {
        const finalControl = entityClaimControl(runtimeControl!)
        await writeHealth(finalControl.enabled ? 'running' : 'draining', finalControl)
      }
    },
    stop(input) { worker.stop(input) },
    async close() {
      if (closed) return
      closed = true
      worker.stop({ abortActive: true })
      try {
        await worker.drain()
        await writeHealth('stopped')
      } finally {
        for (const resource of [...resources].reverse()) resource.close()
      }
    },
  }
}

function entityClaimControl(control: RuntimeControlReadPort): {
  enabled: boolean
  status: 'ok' | 'unavailable'
  desiredState: 'running' | 'draining'
} {
  try {
    const desiredState = stageRuntimeControl(control.read(), 'entity').desiredState
    return {
      enabled: desiredState === 'running',
      status: 'ok',
      desiredState,
    }
  } catch {
    // A malformed or temporarily unreadable control file is a disabled claim
    // gate, not a process-fatal condition. Later reads can observe a repair.
    return { enabled: false, status: 'unavailable', desiredState: 'draining' }
  }
}

function safeCircuitSnapshot(
  snapshot: (() => InferenceCircuitStatusSnapshot) | undefined,
): InferenceCircuitStatusSnapshot | null {
  try {
    return snapshot?.() ?? null
  } catch {
    return null
  }
}

function emptyActiveCycleResult(): ActiveCycleResult {
  return {
    claimed: 0,
    completed: 0,
    retryWait: 0,
    deadLettered: 0,
    released: 0,
    staleLeases: 0,
    sourceErrors: {},
  }
}

function disabledRuntime(): SharedEntityRuntime {
  return {
    mode: 'off',
    async runCycle() { return { mode: 'off' } },
    stop() {},
    async close() {},
  }
}

function sourceDatabasePath(
  source: Signal['sourceType'],
  env: Readonly<Record<string, string | undefined>>,
): string {
  const configured = source === 'news'
    ? env.NEWS_SQLITE_PATH ?? '.data/news.sqlite'
    : env.PIPELINE_SQLITE_PATH ?? '.data/pipeline.sqlite'
  return configuredPath(configured)
}

function configuredPath(value: string): string {
  return isAbsolute(value) ? value : resolve(PACKAGE_DIR, value)
}

function required(env: Readonly<Record<string, string | undefined>>, field: string): string {
  const value = env[field]?.trim()
  if (!value) throw new Error(`Missing required env var: ${field}`)
  return value
}

function safeWorkerId(value: string | undefined): string {
  const workerId = value?.trim() || `shared-entity-${process.pid}`
  if (workerId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(workerId)) throw new Error('Invalid FEED_V3_ENTITY_WORKER_ID')
  return workerId
}

const noOpShadowObservations: ShadowEntityObservationPort = { async observe() {} }

function failClosedShadowStore(): SupabaseEntityMemoryStore {
  return new SupabaseEntityMemoryStore({
    from() { throw new Error('Shadow Entity worker cannot access Supabase.') },
    rpc() { throw new Error('Shadow Entity worker cannot access Supabase.') },
  } as unknown as SupabaseClient)
}

/** Keeps the CLI alive without opening durable/provider dependencies until stopped. */
export function waitForSharedEntityShutdown(
  shutdown: () => Promise<void>,
  signals: SharedEntityShutdownSignalPort = process,
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    let stopping = false
    // Signal listeners and an unresolved Promise alone do not keep Node's
    // event loop alive. This no-op timer is the only safe-off runtime handle.
    const keepAlive = setInterval(() => {}, INERT_KEEP_ALIVE_INTERVAL_MS)
    const stop = () => {
      if (stopping) return
      stopping = true
      clearInterval(keepAlive)
      signals.removeListener('SIGTERM', stop)
      signals.removeListener('SIGINT', stop)
      shutdown().then(resolvePromise, rejectPromise)
    }
    signals.once('SIGTERM', stop)
    signals.once('SIGINT', stop)
  })
}

async function main(): Promise<void> {
  loadDotenvChain()
  const runtime = createSharedEntityRuntime()
  if (runtime.mode === 'off') {
    process.stdout.write(`${JSON.stringify({ mode: 'off', worker: 'shared_entity_manager' })}\n`)
    if (envFlag(process.env.FEED_V3_ENTITY_RUN_ONCE)) {
      await runtime.close()
      return
    }
    await waitForSharedEntityShutdown(() => runtime.close())
    return
  }
  const run = async () => { process.stdout.write(`${JSON.stringify(await runtime.runCycle())}\n`) }
  await run()
  if (envFlag(process.env.FEED_V3_ENTITY_RUN_ONCE)) {
    await runtime.close()
    return
  }
  const interval = startIntervalRunner({
    label: 'feed-v3:shared-entity-manager',
    intervalMs: positiveInteger(process.env.FEED_V3_ENTITY_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    run,
  })
  await waitForSharedEntityShutdown(async () => {
    interval.stop()
    await runtime.close()
  })
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[feed-v3-entity] ${error instanceof Error ? error.message : 'unknown failure'}\n`)
    process.exitCode = 1
  })
}
