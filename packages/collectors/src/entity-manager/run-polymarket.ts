import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@supabase/supabase-js'
import { envFlag, loadDotenvChain, positiveInteger, requiredEnv } from '../pipeline-store/cli-env'
import { SupabasePipelineLedgerStore, withPipelineRun } from '../pipeline-ledger'
import { startIntervalRunner } from '../pipeline-store/interval-runner'
import { SqlitePipelineStore } from '../pipeline-store/sqlite-store'
import type { PipelineStore } from '../pipeline-store/store'
import { HermesEntityExtractionProvider } from './extractor'
import { polymarketResearchToPacket, type PolymarketCandidateContext, type PolymarketResearchRow } from './polymarket-adapter'
import { EntityService } from './entity-service'
import { SupabaseEntityMemoryStore } from './supabase-store'
import { legacyEntityOwnership, runLegacyEntityWhenOwned } from './legacy-ownership-guard'
import type { EntityMemoryStore, ExtractionProvider, ResearchPacket, WriteExtractionResult } from './types'

const SOURCE = 'polymarket'
const AREA = 'markets'
const DEFAULT_BATCH_SIZE = 20
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000
const DEFAULT_MAX_AGE_MS = 48 * 60 * 60 * 1000
const DEFAULT_LEASE_MS = 2 * 60 * 60 * 1000
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_RETRY_BASE_MS = 5 * 60 * 1000
const MAX_RETRY_BACKOFF_MS = 60 * 60 * 1000

export interface RunPolymarketEntityManagerOptions {
  batchSize?: number
  extractionProvider?: ExtractionProvider
  entityStore?: EntityMemoryStore
  maxAgeMs?: number
  leaseMs?: number
  now?: Date
  leaseOwner?: string
  maxAttempts?: number
  retryBaseMs?: number
}

export interface PolymarketEntityManagerCliConfig {
  batchSize: number
  intervalMs: number
  runOnce: boolean
  hermesTimeoutMs: number
  maxAgeMs: number
  leaseMs: number
  maxAttempts: number
  retryBaseMs: number
}

export interface PolymarketEntityManagerResult {
  fetched: number
  processed: number
  failed: number
  retried: number
  terminalFailed: number
  results: WriteExtractionResult[]
  failures: Array<{ sourceResearchId: string, error: string }>
}

function toPolymarketResearchRow(row: {
  id: string
  candidateId: string
  source: string
  area: string
  slug: string
  title: string
  candidateType: string
  researchMode: string
  summary: string
  notes: string
  keyFindings: unknown
  evidenceLinks: unknown
  uncertainty: string
  editorNotes: string
  researchedAt: string
  researchFamilyKey: string
  researchClusterKey: string
  researchDepth: string
  evidenceQuality: string
  catalystFound: boolean
  recommendedEditorAction: string
  researchBackend: string
  researchModel: string | null
  entityManagerAttemptCount: number
}): PolymarketResearchRow {
  return {
    id: row.id,
    candidate_id: row.candidateId,
    source: row.source,
    area: row.area,
    slug: row.slug,
    title: row.title,
    candidate_type: row.candidateType,
    research_mode: row.researchMode,
    summary: row.summary,
    notes: row.notes,
    key_findings: row.keyFindings,
    evidence_links: row.evidenceLinks,
    uncertainty: row.uncertainty,
    editor_notes: row.editorNotes,
    researched_at: row.researchedAt,
    research_family_key: row.researchFamilyKey,
    research_cluster_key: row.researchClusterKey,
    research_depth: row.researchDepth,
    evidence_quality: row.evidenceQuality,
    catalyst_found: row.catalystFound,
    recommended_editor_action: row.recommendedEditorAction,
    research_backend: row.researchBackend,
    research_model: row.researchModel,
    entity_manager_attempt_count: row.entityManagerAttemptCount,
  }
}

function toPolymarketCandidateContext(row: {
  id: string
  marketId: string
  slug: string
  title: string
  tagSlug: string
  tagLabel: string | null
  observedAt: string
  whatChanged: string
  whyFlagged: string
  score: number
  scoreBreakdown: unknown
  metrics: unknown
  evidenceRefs: unknown
}): PolymarketCandidateContext {
  return {
    id: row.id,
    market_id: row.marketId,
    slug: row.slug,
    title: row.title,
    tag_slug: row.tagSlug,
    tag_label: row.tagLabel,
    observed_at: row.observedAt,
    what_changed: row.whatChanged,
    why_flagged: row.whyFlagged,
    score: row.score,
    score_breakdown: row.scoreBreakdown,
    metrics: row.metrics,
    evidence_refs: row.evidenceRefs,
  }
}

async function fetchUnprocessedPolymarketResearchRows(
  store: PipelineStore,
  input: {
    limit: number
    leaseOwner: string
    now: Date
    leaseMs: number
    maxAgeMs: number
  }
): Promise<PolymarketResearchRow[]> {
  const now = input.now.toISOString()
  const rows = await store.claimResearchForEntityManager({
    source: SOURCE,
    area: AREA,
    limit: input.limit,
    leaseOwner: input.leaseOwner,
    now,
    leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs).toISOString(),
    observedAfter: new Date(input.now.getTime() - input.maxAgeMs).toISOString(),
  })
  return rows.map(toPolymarketResearchRow)
}

export async function fetchUnprocessedPolymarketPackets(
  store: PipelineStore,
  batchSize: number,
  options: {
    leaseOwner?: string
    now?: Date
    leaseMs?: number
    maxAgeMs?: number
  } = {}
): Promise<ResearchPacket[]> {
  const rows = await fetchUnprocessedPolymarketResearchRows(store, {
    limit: batchSize,
    leaseOwner: options.leaseOwner ?? `${process.pid}:${randomUUID()}`,
    now: options.now ?? new Date(),
    leaseMs: options.leaseMs ?? DEFAULT_LEASE_MS,
    maxAgeMs: options.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
  })
  if (rows.length === 0) return []

  const candidateIds = [...new Set(rows.map((row) => row.candidate_id))]
  const candidateRows = await store.getCandidatesByIds(candidateIds)
  const candidates = new Map(candidateRows.map((row) => [row.id, toPolymarketCandidateContext(row)]))

  return rows.map((row) => polymarketResearchToPacket(row, candidates.get(row.candidate_id) ?? null))
}

export async function runPolymarketEntityManager(
  store: PipelineStore,
  db: SupabaseClient,
  options: RunPolymarketEntityManagerOptions = {}
): Promise<PolymarketEntityManagerResult> {
  const batchSize = options.batchSize ?? 20
  const now = options.now ?? new Date()
  const leaseOwner = options.leaseOwner ?? `${process.pid}:${randomUUID()}`
  const extractionProvider = options.extractionProvider ?? new HermesEntityExtractionProvider()
  const entityStore = options.entityStore ?? new SupabaseEntityMemoryStore(db)
  const entityService = new EntityService(entityStore)
  const packets = await fetchUnprocessedPolymarketPackets(store, batchSize, {
    now,
    leaseOwner,
    leaseMs: options.leaseMs,
    maxAgeMs: options.maxAgeMs,
  })
  const results: WriteExtractionResult[] = []
  const failures: Array<{ sourceResearchId: string, error: string }> = []
  let retried = 0
  let terminalFailed = 0
  const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS))
  const retryBaseMs = Math.max(1, Math.trunc(options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS))

  for (const packet of packets) {
    let result: WriteExtractionResult
    try {
      result = await entityService.writeExtraction(packet, extractionProvider)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push({ sourceResearchId: packet.sourceResearchId, error: message })
      const attemptCount = positivePacketInteger(packet.context.entity_manager_attempt_count, 1)
      const terminal = isPermanentEntityManagerError(error) || attemptCount >= maxAttempts
      if (terminal) {
        terminalFailed += 1
        try {
          await entityService.markExtractionFailed(packet, message)
        } finally {
          await store.finishResearchForEntityManager({
            id: packet.sourceResearchId,
            leaseOwner,
            status: 'failed',
            observedAt: now.toISOString(),
            error: message,
          })
        }
      } else {
        retried += 1
        await store.finishResearchForEntityManager({
          id: packet.sourceResearchId,
          leaseOwner,
          status: 'pending',
          observedAt: now.toISOString(),
          error: message,
          nextRetryAt: new Date(now.getTime() + retryDelayMs(attemptCount, retryBaseMs)).toISOString(),
        })
      }
      continue
    }

    // Keep the durable Supabase write and the local queue receipt separate:
    // if this local status update fails, do not incorrectly write a failure
    // memory for extraction work that already succeeded.
    results.push(result)
    await store.finishResearchForEntityManager({
      id: packet.sourceResearchId,
      leaseOwner,
      status: 'processed',
      observedAt: new Date().toISOString(),
    })
  }

  return {
    fetched: packets.length,
    processed: results.length,
    failed: failures.length,
    retried,
    terminalFailed,
    results,
    failures,
  }
}

export function polymarketEntityManagerCliConfig(env: NodeJS.ProcessEnv = process.env): PolymarketEntityManagerCliConfig {
  const hermesTimeoutMs = positiveInteger(env.ENTITY_MANAGER_HERMES_TIMEOUT_MS, 60_000)
  return {
    batchSize: positiveInteger(env.ENTITY_MANAGER_POLYMARKET_BATCH_SIZE, DEFAULT_BATCH_SIZE),
    intervalMs: positiveInteger(env.ENTITY_MANAGER_POLYMARKET_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    runOnce: envFlag(env.ENTITY_MANAGER_POLYMARKET_RUN_ONCE),
    hermesTimeoutMs,
    maxAgeMs: positiveInteger(env.ENTITY_MANAGER_POLYMARKET_MAX_AGE_MS, DEFAULT_MAX_AGE_MS),
    leaseMs: positiveInteger(
      env.ENTITY_MANAGER_POLYMARKET_LEASE_MS,
      Math.max(DEFAULT_LEASE_MS, hermesTimeoutMs * positiveInteger(env.ENTITY_MANAGER_POLYMARKET_BATCH_SIZE, DEFAULT_BATCH_SIZE))
    ),
    maxAttempts: positiveInteger(env.ENTITY_MANAGER_POLYMARKET_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS),
    retryBaseMs: positiveInteger(env.ENTITY_MANAGER_POLYMARKET_RETRY_BASE_MS, DEFAULT_RETRY_BASE_MS),
  }
}

async function runAndLog(
  store: PipelineStore,
  db: SupabaseClient,
  config: PolymarketEntityManagerCliConfig
): Promise<void> {
  const result = await withPipelineRun(
    new SupabasePipelineLedgerStore(db),
    {
      source: 'polymarket',
      sourceArea: 'markets',
      stage: 'polymarket.entity_manager',
      metadata: {
        batchSize: config.batchSize,
      },
    },
    () => runPolymarketEntityManager(store, db, {
      batchSize: config.batchSize,
      maxAgeMs: config.maxAgeMs,
      leaseMs: config.leaseMs,
      maxAttempts: config.maxAttempts,
      retryBaseMs: config.retryBaseMs,
      extractionProvider: new HermesEntityExtractionProvider({ timeoutMs: config.hermesTimeoutMs }),
    })
  )
  console.log(JSON.stringify(result, null, 2))
}

function retryDelayMs(attemptCount: number, baseMs: number): number {
  return Math.min(MAX_RETRY_BACKOFF_MS, baseMs * (2 ** Math.max(0, attemptCount - 1)))
}

function positivePacketInteger(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function isPermanentEntityManagerError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const classified = error as { retryable?: unknown, permanent?: unknown, code?: unknown }
  if (classified.retryable === false || classified.permanent === true) return true
  return classified.code === 'ENTITY_PACKET_INVALID' || classified.code === 'ENTITY_SOURCE_UNSUPPORTED'
}

async function main(): Promise<void> {
  loadDotenvChain()
  const { ownership } = await runLegacyEntityWhenOwned({
    sourceType: 'polymarket',
    run: runOwnedPolymarketRunner,
  })
  if (ownership.owner === 'shared') {
    console.log('[entity-manager:polymarket] shared Entity owns polymarket; legacy runner is inert')
    if (envFlag(process.env.ENTITY_MANAGER_POLYMARKET_RUN_ONCE)) return
    await waitForShutdownSignal()
    return
  }

}

async function runOwnedPolymarketRunner(): Promise<void> {
  const config = polymarketEntityManagerCliConfig()
  const supabase = createClient(
    requiredEnv('SUPABASE_URL'),
    requiredEnv('SUPABASE_SERVICE_ROLE_KEY')
  )
  const store = new SqlitePipelineStore()

  try {
    await runAndLog(store, supabase, config)
    if (config.runOnce) return

    startIntervalRunner({
      label: 'entity-manager:polymarket',
      intervalMs: config.intervalMs,
      run: () => runAndLog(store, supabase, config),
    })
  } finally {
    if (config.runOnce) store.close()
  }
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => {
      process.removeListener('SIGTERM', stop)
      process.removeListener('SIGINT', stop)
      resolve()
    }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
  })
}

export function polymarketEntityRunnerOwnership(
  env: Readonly<Record<string, string | undefined>>,
  now?: Date,
) {
  return legacyEntityOwnership('polymarket', env, now)
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[entity-manager:polymarket] fatal:', err)
    process.exit(1)
  })
}
