import { createClient } from '@supabase/supabase-js'
import { HermesService } from '../hermes'
import { envFlag, loadDotenvChain, positiveInteger, requiredEnv } from '../pipeline-store/cli-env'
import { startIntervalRunner } from '../pipeline-store/interval-runner'
import type { EntityCatalogMaintenanceScope } from './contracts'
import { HermesEntityIdentityJudge } from './hermes-judge'
import { EntityCatalogMaintenanceService } from './service'
import { SupabaseEntityCatalogMaintenanceStore } from './supabase-store'

const DEFAULT_INTERVAL_MS = 24 * 60 * 60_000
const DEFAULT_BATCH_SIZE = 8
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_LEASE_MS = 30 * 60_000
const INCREMENTAL_OVERLAP_MS = 5 * 60_000

type RequestedScope = EntityCatalogMaintenanceScope | 'auto'

async function main(): Promise<void> {
  loadDotenvChain()
  const intervalMs = positiveInteger(process.env.ENTITY_CATALOG_MAINTENANCE_INTERVAL_MS, DEFAULT_INTERVAL_MS)
  const batchSize = positiveInteger(process.env.ENTITY_CATALOG_MAINTENANCE_BATCH_SIZE, DEFAULT_BATCH_SIZE)
  const timeoutMs = positiveInteger(process.env.ENTITY_CATALOG_MAINTENANCE_HERMES_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  const leaseMs = positiveInteger(process.env.ENTITY_CATALOG_MAINTENANCE_LEASE_MS, DEFAULT_LEASE_MS)
  const runOnceOnly = envFlag(process.env.ENTITY_CATALOG_MAINTENANCE_RUN_ONCE)
  const requestedScope = maintenanceScope(process.env.ENTITY_CATALOG_MAINTENANCE_SCOPE)
  const provider = process.env.ENTITY_CATALOG_MAINTENANCE_PROVIDER?.trim()
    || process.env.INFERENCE_GATEWAY_PRIMARY_PROVIDER?.trim()
    || 'ollama-cloud'
  const model = process.env.ENTITY_CATALOG_MAINTENANCE_MODEL?.trim()
    || process.env.INFERENCE_GATEWAY_PRIMARY_MODEL?.trim()
    || 'glm-5.3-flash'
  const db = createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'))
  const store = new SupabaseEntityCatalogMaintenanceStore(db)
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
  })

  const safeRun = async (trigger: 'manual' | 'scheduled'): Promise<void> => {
    try {
      const latest = requestedScope === 'auto' ? await store.latestCompletedRun() : null
      const scope: EntityCatalogMaintenanceScope = requestedScope === 'auto'
        ? latest ? 'incremental' : 'full_catalog'
        : requestedScope
      const changedSince = scope === 'incremental'
        ? new Date(Date.parse(latest?.startedAt ?? new Date(Date.now() - intervalMs).toISOString()) - INCREMENTAL_OVERLAP_MS).toISOString()
        : undefined
      const result = await service.run({ trigger, scope, changedSince, mode: 'dry_run' })
      console.log(JSON.stringify({ event: 'entity_catalog_maintenance_completed', ...result }))
    } catch (error) {
      console.error('[entity-maintenance] run failed:', error)
      if (runOnceOnly) process.exitCode = 1
    }
  }

  await safeRun('manual')
  if (!runOnceOnly) {
    const interval = startIntervalRunner({
      label: 'entity-catalog-maintenance',
      intervalMs,
      run: () => safeRun('scheduled'),
    })
    const stop = () => {
      interval.stop()
      process.exit(0)
    }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
  }
}

function maintenanceScope(value: string | undefined): RequestedScope {
  const cleaned = value?.trim() || 'auto'
  if (cleaned === 'auto' || cleaned === 'full_catalog' || cleaned === 'incremental') return cleaned
  throw new Error('ENTITY_CATALOG_MAINTENANCE_SCOPE must be auto, full_catalog, or incremental.')
}

if (require.main === module || process.env.NODE_APP_INSTANCE !== undefined) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
