import { createClient } from '@supabase/supabase-js'
import { config as loadEnv } from 'dotenv'
import { newsResearchToPacket } from './news-adapter'
import { EntityService } from './entity-service'
import { HermesEntityExtractionProvider } from './extractor'
import { SupabaseEntityMemoryStore } from './supabase-store'
import { SqliteNewsStore } from '../news/sqlite-store'
import type {
  NewsCandidateObservationRow,
  NewsResearchResultRow,
  NewsStore,
} from '../news/store'
import type {
  EntityMemoryStore,
  ExtractionProvider,
  ResearchPacket,
  WriteExtractionResult,
} from './types'

const DEFAULT_BATCH_SIZE = 20

export interface PendingNewsPacket {
  result: NewsResearchResultRow
  candidate: NewsCandidateObservationRow
  packet: ResearchPacket
}

export interface NewsEntityManagerResult {
  fetched: number
  processed: number
  failed: number
  skippedAlreadyMarked: number
  memoriesWritten: number
  results: WriteExtractionResult[]
  failures: Array<{
    sourceResearchId: string
    stage: 'entity_extraction' | 'news_status_update'
    error: string
  }>
}

export interface RunNewsEntityManagerInput {
  newsStore: NewsStore
  entityStore: EntityMemoryStore
  extractionProvider: ExtractionProvider
  batchSize?: number
}

interface FetchNewsPacketsResult {
  fetched: number
  skippedAlreadyMarked: number
  packets: PendingNewsPacket[]
}

export async function fetchUnprocessedNewsPackets(input: {
  newsStore: NewsStore
  entityStore: EntityMemoryStore
  batchSize: number
}): Promise<PendingNewsPacket[]> {
  return (await fetchNewsPackets(input)).packets
}

export async function runNewsEntityManager(input: RunNewsEntityManagerInput): Promise<NewsEntityManagerResult> {
  const fetched = await fetchNewsPackets({
    newsStore: input.newsStore,
    entityStore: input.entityStore,
    batchSize: input.batchSize ?? DEFAULT_BATCH_SIZE,
  })
  const results: WriteExtractionResult[] = []
  const failures: NewsEntityManagerResult['failures'] = []
  let memoriesWritten = 0
  let extractionFailures = 0
  const entityService = new EntityService(input.entityStore)

  for (const item of fetched.packets) {
    let extractionResult: WriteExtractionResult
    try {
      extractionResult = await entityService.writeExtraction(item.packet, input.extractionProvider)
    } catch (error) {
      const message = errorMessage(error)
      const failureResult = await entityService.markExtractionFailed(item.packet, message)
      memoriesWritten += failureResult.memoriesWritten
      failures.push({ sourceResearchId: item.result.id, stage: 'entity_extraction', error: message })
      extractionFailures += 1
      try {
        await input.newsStore.markResearchResultStatus(item.result.id, 'failed_entity_memory')
      } catch (statusError) {
        failures.push({
          sourceResearchId: item.result.id,
          stage: 'news_status_update',
          error: errorMessage(statusError),
        })
      }
      continue
    }

    results.push(extractionResult)
    memoriesWritten += extractionResult.memoriesWritten

    try {
      await input.newsStore.markResearchResultStatus(item.result.id, 'handed_to_entity_memory')
    } catch (error) {
      failures.push({
        sourceResearchId: item.result.id,
        stage: 'news_status_update',
        error: errorMessage(error),
      })
    }
  }

  return {
    fetched: fetched.fetched,
    processed: results.length,
    failed: extractionFailures,
    skippedAlreadyMarked: fetched.skippedAlreadyMarked,
    memoriesWritten,
    results,
    failures,
  }
}

/**
 * The news lane's own local store (`NewsStore`, in `news/sqlite-store.ts`)
 * is the sole, authoritative cursor for dedup/skip:
 * `fetchPendingResearchResults` filters strictly on its own `status` column,
 * which this module advances via `markResearchResultStatus` below. There is
 * no second cursor into `entity_memories` `source_marker` rows to keep in
 * sync - `entity-manager/resolver.ts` no longer writes those rows at all
 * (Supabase forbids `memory_type = 'source_marker'` entirely as of the
 * `entity_memories_drop_source_marker` migration), so a reconciliation
 * lookup against them would always read back empty.
 */
async function fetchNewsPackets(input: {
  newsStore: NewsStore
  entityStore: EntityMemoryStore
  batchSize: number
}): Promise<FetchNewsPacketsResult> {
  const limit = Math.max(input.batchSize * 10, 100)
  const pending = await input.newsStore.fetchPendingResearchResults(limit)
  const packets = pending
    .map((item) => ({
      ...item,
      packet: newsResearchToPacket(item.result, item.candidate),
    }))
    .slice(0, Math.max(0, input.batchSize))

  return {
    fetched: pending.length,
    skippedAlreadyMarked: 0,
    packets,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

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

async function main(): Promise<void> {
  loadEnv({ path: '.env' })
  loadEnv({ path: '../../.env' })
  loadEnv()

  const newsStore = new SqliteNewsStore()
  try {
    const supabase = createClient(
      requiredEnv('SUPABASE_URL'),
      requiredEnv('SUPABASE_SERVICE_ROLE_KEY')
    )
    const result = await runNewsEntityManager({
      newsStore,
      entityStore: new SupabaseEntityMemoryStore(supabase),
      extractionProvider: new HermesEntityExtractionProvider(),
      batchSize: positiveInteger(process.env.ENTITY_MANAGER_NEWS_BATCH_SIZE, DEFAULT_BATCH_SIZE),
    })
    console.log(JSON.stringify(result, null, 2))
  } finally {
    newsStore.close()
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(errorMessage(error))
    process.exit(1)
  })
}
