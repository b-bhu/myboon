import { createClient } from '@supabase/supabase-js'
import { resolve } from 'node:path'
import { HermesService } from '../hermes'
import { envFlag, loadDotenvChain, positiveInteger, requiredEnv } from '../pipeline-store/cli-env'
import {
  startIntervalRunner,
  type IntervalRunnerHandle,
  type IntervalRunnerOptions,
} from '../pipeline-store/interval-runner'
import type { EntityCatalogMaintenanceScope } from './contracts'
import { SupabaseEntityCatalogCleanupExecutor } from './cleanup-executor'
import { HermesEntityIdentityJudge } from './hermes-judge'
import { EntityCatalogMaintenanceService } from './service'
import { SqliteEntityDraftInventory } from './sqlite-draft-inventory'
import { SupabaseEntityCatalogMaintenanceStore } from './supabase-store'

const DEFAULT_INTERVAL_MS = 24 * 60 * 60_000
const DEFAULT_BATCH_SIZE = 8
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_LEASE_MS = 30 * 60_000
const INCREMENTAL_OVERLAP_MS = 5 * 60_000

export type RequestedScope = EntityCatalogMaintenanceScope | 'auto'

export interface MaintenanceRunPlan {
  scope: EntityCatalogMaintenanceScope
  changedSince?: string
}

interface ShutdownSignalPort {
  once(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown
  removeListener(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown
}

interface MaintenanceDaemonOptions {
  intervalMs: number
  runOnceOnly: boolean
  runInitial: (signal: AbortSignal) => Promise<void>
  runScheduled: (signal: AbortSignal) => Promise<void>
  signals?: ShutdownSignalPort
  intervalFactory?: (options: IntervalRunnerOptions) => IntervalRunnerHandle
}

async function main(): Promise<void> {
  loadDotenvChain()
  const intervalMs = positiveInteger(process.env.ENTITY_CATALOG_MAINTENANCE_INTERVAL_MS, DEFAULT_INTERVAL_MS)
  const batchSize = positiveInteger(process.env.ENTITY_CATALOG_MAINTENANCE_BATCH_SIZE, DEFAULT_BATCH_SIZE)
  const timeoutMs = positiveInteger(process.env.ENTITY_CATALOG_MAINTENANCE_HERMES_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  const leaseMs = positiveInteger(process.env.ENTITY_CATALOG_MAINTENANCE_LEASE_MS, DEFAULT_LEASE_MS)
  const runOnceOnly = envFlag(process.env.ENTITY_CATALOG_MAINTENANCE_RUN_ONCE)
  const requestedScope = maintenanceScope(process.env.ENTITY_CATALOG_MAINTENANCE_SCOPE)
  const mode = maintenanceMode(process.env.ENTITY_CATALOG_MAINTENANCE_MODE)
  const provider = process.env.ENTITY_CATALOG_MAINTENANCE_PROVIDER?.trim()
    || process.env.INFERENCE_GATEWAY_PRIMARY_PROVIDER?.trim()
    || 'ollama-cloud'
  const model = process.env.ENTITY_CATALOG_MAINTENANCE_MODEL?.trim()
    || process.env.INFERENCE_GATEWAY_PRIMARY_MODEL?.trim()
    || 'glm-5.3-flash'
  const db = createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'))
  const store = new SupabaseEntityCatalogMaintenanceStore(db)
  const draftInventory = new SqliteEntityDraftInventory(resolve(
    process.env.PIPELINE_SQLITE_PATH?.trim() || '.data/pipeline.sqlite',
  ), { leaseMs })
  const judge = new HermesEntityIdentityJudge({
    service: new HermesService(),
    provider,
    model,
    profile: process.env.ENTITY_CATALOG_MAINTENANCE_HERMES_PROFILE,
    command: process.env.HERMES_COMMAND,
    timeoutMs,
  })
  const service = new EntityCatalogMaintenanceService({
    store,
    judge,
    provider,
    model,
    batchSize,
    leaseMs,
    cleanup: new SupabaseEntityCatalogCleanupExecutor(db, draftInventory),
  })

  const safeRun = async (trigger: 'manual' | 'scheduled', signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return
    try {
      const hasFullCatalogBaseline = requestedScope === 'auto'
        ? await store.hasCompletedFullCatalogRun()
        : false
      const latest = requestedScope === 'incremental' || (requestedScope === 'auto' && hasFullCatalogBaseline)
        ? await store.latestCompletedRun()
        : null
      const plan = resolveMaintenanceRunPlan({
        requestedScope,
        hasFullCatalogBaseline,
        latestCompletedStartedAt: latest?.startedAt ?? null,
        intervalMs,
        nowMs: Date.now(),
      })
      const result = await service.run({ trigger, ...plan, mode, signal })
      console.log(JSON.stringify({ event: 'entity_catalog_maintenance_completed', ...result }))
    } catch (error) {
      console.error('[entity-maintenance] run failed:', error)
      if (runOnceOnly && !signal.aborted) process.exitCode = 1
    }
  }

  try {
    await runMaintenanceDaemon({
      intervalMs,
      runOnceOnly,
      runInitial: (signal) => safeRun('manual', signal),
      runScheduled: (signal) => safeRun('scheduled', signal),
    })
  } finally {
    draftInventory.close()
  }
}

/**
 * Auto mode cannot become incremental until a completed full-catalog run
 * exists. A completed explicit incremental run is only a watermark, never a
 * substitute for that baseline.
 */
export function resolveMaintenanceRunPlan(input: {
  requestedScope: RequestedScope
  hasFullCatalogBaseline: boolean
  latestCompletedStartedAt: string | null
  intervalMs: number
  nowMs: number
}): MaintenanceRunPlan {
  const scope: EntityCatalogMaintenanceScope = input.requestedScope === 'auto'
    ? input.hasFullCatalogBaseline ? 'incremental' : 'full_catalog'
    : input.requestedScope
  if (scope === 'full_catalog') return { scope }

  const fallbackMs = input.nowMs - input.intervalMs
  const watermarkMs = input.latestCompletedStartedAt === null
    ? fallbackMs
    : Date.parse(input.latestCompletedStartedAt)
  if (!Number.isFinite(watermarkMs)) {
    throw new Error('Latest Entity maintenance watermark must be a valid timestamp.')
  }
  return {
    scope,
    changedSince: new Date(watermarkMs - INCREMENTAL_OVERLAP_MS).toISOString(),
  }
}

/**
 * Installs signal handling before the initial run. Shutdown stops future
 * ticks, asks the service to stop after its bounded active call, and waits for
 * the database lease to be released before this process can exit.
 */
export async function runMaintenanceDaemon(options: MaintenanceDaemonOptions): Promise<void> {
  const signals = options.signals ?? process
  const intervalFactory = options.intervalFactory ?? startIntervalRunner
  const coordinator = new MaintenanceRunCoordinator()
  let interval: IntervalRunnerHandle | null = null
  let stopping = false
  let resolveShutdown!: () => void
  let rejectShutdown!: (error: unknown) => void
  const shutdownComplete = new Promise<void>((resolve, reject) => {
    resolveShutdown = resolve
    rejectShutdown = reject
  })
  const stop = () => {
    if (stopping) return
    stopping = true
    interval?.stop()
    signals.removeListener('SIGTERM', stop)
    signals.removeListener('SIGINT', stop)
    void coordinator.stop().then(resolveShutdown, rejectShutdown)
  }
  signals.once('SIGTERM', stop)
  signals.once('SIGINT', stop)

  try {
    await coordinator.run(options.runInitial)
    if (stopping) {
      await shutdownComplete
      return
    }
    if (options.runOnceOnly) return

    interval = intervalFactory({
      label: 'entity-catalog-maintenance',
      intervalMs: options.intervalMs,
      run: () => coordinator.run(options.runScheduled),
    })
    await shutdownComplete
  } finally {
    interval?.stop()
    signals.removeListener('SIGTERM', stop)
    signals.removeListener('SIGINT', stop)
  }
}

class MaintenanceRunCoordinator {
  private readonly controller = new AbortController()
  private active: Promise<void> | null = null
  private stopping = false

  async run(work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.stopping) return
    if (this.active) throw new Error('Entity maintenance coordinator already has a run in flight.')
    const active = work(this.controller.signal)
    this.active = active
    try {
      await active
    } finally {
      if (this.active === active) this.active = null
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.controller.abort()
    await this.active
  }
}

function maintenanceScope(value: string | undefined): RequestedScope {
  const cleaned = value?.trim() || 'auto'
  if (cleaned === 'auto' || cleaned === 'full_catalog' || cleaned === 'incremental') return cleaned
  throw new Error('ENTITY_CATALOG_MAINTENANCE_SCOPE must be auto, full_catalog, or incremental.')
}

export function maintenanceMode(value: string | undefined): 'dry_run' | 'apply' {
  const cleaned = value?.trim() || 'dry_run'
  if (cleaned === 'dry_run' || cleaned === 'apply') return cleaned
  throw new Error('ENTITY_CATALOG_MAINTENANCE_MODE must be dry_run or apply.')
}

if (require.main === module || process.env.NODE_APP_INSTANCE !== undefined) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
