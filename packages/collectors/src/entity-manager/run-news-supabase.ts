import { createClient } from '@supabase/supabase-js'
import { config as loadEnv } from 'dotenv'
import { SupabasePipelineLedgerStore, withPipelineRun } from '../pipeline-ledger'
import { SupabaseNewsStore } from '../news/supabase-store'
import { startIntervalRunner } from '../pipeline-store/interval-runner'
import { HermesEntityExtractionProvider } from './extractor'
import { runNewsEntityManager } from './run-news'
import { SupabaseEntityMemoryStore } from './supabase-store'

const DEFAULT_BATCH_SIZE = 20
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function envFlag(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true'
}

function loadRuntimeEnv(): void {
  loadEnv({ path: '.env' })
  loadEnv({ path: '../../.env' })
  loadEnv()
}

function createSupabase() {
  loadRuntimeEnv()
  const supabase = createClient(
    requiredEnv('SUPABASE_URL'),
    requiredEnv('SUPABASE_SERVICE_ROLE_KEY')
  )
  return supabase
}

async function runOnce(): Promise<void> {
  const supabase = createSupabase()
  const batchSize = positiveInteger(process.env.ENTITY_MANAGER_NEWS_BATCH_SIZE, DEFAULT_BATCH_SIZE)
  const hermesTimeoutMs = positiveInteger(process.env.ENTITY_MANAGER_HERMES_TIMEOUT_MS, 60_000)

  const result = await withPipelineRun(
    new SupabasePipelineLedgerStore(supabase),
    {
      source: 'news',
      sourceArea: 'curated_news',
      stage: 'news.entity_manager',
      metadata: {
        batchSize,
        storage: 'supabase',
      },
    },
    () => runNewsEntityManager({
      newsStore: new SupabaseNewsStore(supabase),
      entityStore: new SupabaseEntityMemoryStore(supabase),
      extractionProvider: new HermesEntityExtractionProvider({ timeoutMs: hermesTimeoutMs }),
      batchSize,
    })
  )

  console.log(JSON.stringify(result, null, 2))
}

async function main(): Promise<void> {
  await runOnce()

  if (envFlag(process.env.ENTITY_MANAGER_NEWS_RUN_ONCE)) return

  const intervalMs = positiveInteger(process.env.ENTITY_MANAGER_NEWS_INTERVAL_MS, DEFAULT_INTERVAL_MS)
  startIntervalRunner({
    label: 'entity-manager:news',
    intervalMs,
    run: runOnce,
  })
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
