import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@supabase/supabase-js'
import { config as loadEnv } from 'dotenv'
import { SupabasePipelineLedgerStore, withPipelineRun } from '../pipeline-ledger'
import { startIntervalRunner } from '../pipeline-store/interval-runner'
import { SqlitePipelineStore } from '../pipeline-store/sqlite-store'
import type { PipelineStore } from '../pipeline-store/store'
import { HermesEntityExtractionProvider } from './extractor'
import { polymarketResearchToPacket, type PolymarketCandidateContext, type PolymarketResearchRow } from './polymarket-adapter'
import { EntityService } from './entity-service'
import { SupabaseEntityMemoryStore } from './supabase-store'
import type { ExtractionProvider, ResearchPacket, WriteExtractionResult } from './types'

const SOURCE = 'polymarket'
const AREA = 'markets'
const DEFAULT_BATCH_SIZE = 20
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000

export interface RunPolymarketEntityManagerOptions {
  batchSize?: number
  extractionProvider?: ExtractionProvider
}

export interface PolymarketEntityManagerCliConfig {
  batchSize: number
  intervalMs: number
  runOnce: boolean
  hermesTimeoutMs: number
}

export interface PolymarketEntityManagerResult {
  fetched: number
  processed: number
  failed: number
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

/**
 * Finds the next batch of Polymarket research rows the entity manager has not
 * yet processed.
 *
 * This used to page through up to 50 pages of `polymarket_market_candidate_research`
 * via Supabase `.range()` and cross-check every row against `source_marker`
 * rows in `entity_memories` to find what was already handled - an O(pages)
 * fan-out of marker-lookup queries per run. `entity_memories.source_marker`
 * rows are gone (a Supabase migration now forbids them), so that cross-check
 * is no longer possible even in principle.
 *
 * KNOWN GAP (reported, not silently worked around): `PipelineStore` gives the
 * entity manager no cursor of its own over research rows. `PipelineResearchRow`
 * has exactly one status column, and it is owned end-to-end by the editor
 * stage (`pending_editor` -> `editing` -> `edited`/`rejected`/`needs_more_research`
 * -> `published`), which runs as an independent consumer of the SAME rows on
 * its own schedule. There is no second flag/timestamp/lease field the entity
 * manager could use to mark "I have already turned this into entity_memories"
 * without colliding with the editor's own claim. `claimWithLease` and friends
 * are candidate-only (see `pipeline_candidates.lease_owner` /
 * `lease_expires_at` / `attempt_count` in sqlite-store.ts) - there is no
 * research-row equivalent.
 *
 * Given that gap, this reads `status = 'pending_editor'` (the same "not yet
 * claimed" signal the editor uses) WITHOUT writing back to it, and leans on
 * `writeExtraction`'s existing idempotent-by-key dedup (see
 * entity-manager/resolver.ts) to make re-processing the same row safe. The
 * tradeoff: until the editor stage claims a row and moves it off
 * `pending_editor`, every entity-manager run re-fetches and re-attempts it,
 * doing a no-op write instead of skipping outright. That is wasted work, not
 * a correctness bug - `writeExtraction`'s memory dedup keys already prevent
 * duplicate memories, and the destructive alternative (writing a second
 * status onto the shared column) would risk starving the editor of its own
 * queue. Fixing the waste needs a real interface change (a second status/lease
 * column scoped to this stage), which is out of scope here and reported back
 * as a `PipelineStore` gap.
 */
async function fetchUnprocessedPolymarketResearchRows(
  store: PipelineStore,
  limit: number
): Promise<PolymarketResearchRow[]> {
  const rows = await store.fetchResearchByStatus({
    source: SOURCE,
    area: AREA,
    status: 'pending_editor',
    limit,
  })
  return rows.map(toPolymarketResearchRow)
}

export async function fetchUnprocessedPolymarketPackets(
  store: PipelineStore,
  batchSize: number
): Promise<ResearchPacket[]> {
  const rows = await fetchUnprocessedPolymarketResearchRows(store, batchSize)
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
  const extractionProvider = options.extractionProvider ?? new HermesEntityExtractionProvider()
  const entityStore = new SupabaseEntityMemoryStore(db)
  const entityService = new EntityService(entityStore)
  const packets = await fetchUnprocessedPolymarketPackets(store, batchSize)
  const results: WriteExtractionResult[] = []
  const failures: Array<{ sourceResearchId: string, error: string }> = []

  for (const packet of packets) {
    try {
      results.push(await entityService.writeExtraction(packet, extractionProvider))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push({ sourceResearchId: packet.sourceResearchId, error: message })
      await entityService.markExtractionFailed(packet, message)
    }
  }

  return {
    fetched: packets.length,
    processed: results.length,
    failed: failures.length,
    results,
    failures,
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function envFlag(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true'
}

export function polymarketEntityManagerCliConfig(env: NodeJS.ProcessEnv = process.env): PolymarketEntityManagerCliConfig {
  return {
    batchSize: positiveInteger(env.ENTITY_MANAGER_POLYMARKET_BATCH_SIZE, DEFAULT_BATCH_SIZE),
    intervalMs: positiveInteger(env.ENTITY_MANAGER_POLYMARKET_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    runOnce: envFlag(env.ENTITY_MANAGER_POLYMARKET_RUN_ONCE),
    hermesTimeoutMs: positiveInteger(env.ENTITY_MANAGER_HERMES_TIMEOUT_MS, 60_000),
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
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
      extractionProvider: new HermesEntityExtractionProvider({ timeoutMs: config.hermesTimeoutMs }),
    })
  )
  console.log(JSON.stringify(result, null, 2))
}

async function main(): Promise<void> {
  loadEnv({ path: '.env' })
  loadEnv({ path: '../../.env' })
  loadEnv()

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

if (require.main === module) {
  main().catch((err) => {
    console.error('[entity-manager:polymarket] fatal:', err)
    process.exit(1)
  })
}
