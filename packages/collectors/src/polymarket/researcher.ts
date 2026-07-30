import type { SupabaseClient } from '@supabase/supabase-js'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { HermesService, extractJson } from '../hermes'
import { gateSignal, type EntityMemoryReader, type GateDecision, type GateEntityContext } from '../research-gate'
import type { ResearchConclusion, ResearchTask } from '../research-engine'
import type {
  PipelineCandidateRow,
  PipelineResearchRow,
  PipelineResearchUpsertInput,
  PipelineStore,
} from '../pipeline-store/store'
import { fetchPolymarketNativeContext, type PolymarketNativeContext } from './market-context'

const execFileAsync = promisify(execFile)

const SOURCE = 'polymarket'
const AREA = 'markets'
const RESEARCH_STAGE = 'research'
const ONE_HOUR_MS = 60 * 60 * 1000
const DEFAULT_BATCH_SIZE = 20
const DEFAULT_SLUG_COOLDOWN_MINUTES = 60
const DEFAULT_RETRY_WINDOW_MINUTES = 4 * 60
const DEFAULT_MAX_RETRY_COUNT = 2
const DEFAULT_STRUCTURE_ONLY_SCORE_MAX = 55
const DEFAULT_THIN_VOLUME_24H_MAX = 1_000
const DEFAULT_THIN_LIQUIDITY_MAX = 1_000
const DEFAULT_HERMES_COMMAND = 'hermes'
const DEFAULT_RESEARCH_MODEL = 'hermes_cli'
const DEFAULT_HERMES_TIMEOUT_MS = 60_000
const DEFAULT_LAST30DAYS_PYTHON = 'python3.12'
const DEFAULT_LAST30DAYS_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_LAST30DAYS_WEB_BACKEND = 'auto'
const DEFAULT_MAX_CANDIDATE_AGE_HOURS = 48
// A single deep_web candidate can take ~11 minutes worst case (hermes planner
// + up to MAX_RETRIEVAL_PASSES last30days retrieval calls). Candidates in a
// batch are researched SEQUENTIALLY (see researchCandidatesWithFallback /
// researchDeepWebCandidates), so an earlier claim in the same batch must not
// expire while later items in the batch are still being worked. Rather than
// sizing one lease for the whole batch's worst case (batchSize * 11min, which
// would make crash recovery unacceptably slow), the lease is sized generously
// for ONE candidate (20 minutes - ~2x the worst single-candidate case) and
// renewed after each candidate finishes (see renewOutstandingLeases below),
// so the remaining, not-yet-processed claims in the batch keep a fresh
// window right up until they are actually worked.
const DEFAULT_LEASE_SECONDS = 20 * 60
const VPS_LAST30DAYS_SCRIPT = '/root/.agents/skills/last30days/scripts/last30days.py'
const LAST30DAYS_ALLOWED_SOURCES = new Set(['reddit', 'grounding', 'polymarket', 'jobs'])
const LAST30DAYS_DEFAULT_SOURCES = ['reddit', 'grounding', 'polymarket']
const LAST30DAYS_DISABLED_SOURCE_ALIASES = new Set(['x', 'x_search', 'twitter', 'twitter_search'])
const MAX_RETRIEVAL_PASSES = 2

export interface PolymarketResearcherOptions {
  now?: string
  batchSize?: number
  slugCooldownMinutes?: number
  retryWindowMinutes?: number
  maxRetryCount?: number
  structureOnlyScoreMax?: number
  thinVolume24hMax?: number
  thinLiquidityMax?: number
  backend?: ResearchBackend
  researchModel?: string
  hermesCommand?: string
  researchPlannerHermesToolsets?: string
  researchPlannerHermesIgnoreRules?: boolean
  researchPlannerHermesTimeoutMs?: number
  last30DaysPython?: string
  last30DaysScript?: string
  last30DaysTimeoutMs?: number
  last30DaysWebBackend?: string
  maxCandidateAgeHours?: number
  leaseOwner?: string
  leaseSeconds?: number
  /** Central Hermes service (see src/hermes/). Defaults to an instance built
   * from hermesCommand; injectable for tests and shared observability. */
  hermes?: HermesService
  /**
   * Pre-research entity gate (see src/research-gate/). When configured,
   * deep_web candidates are checked against entity memory BEFORE any research
   * is paid for: signals the timeline already covers are terminally skipped
   * ('skipped_recently_researched') and never reach the editor; everything
   * else proceeds carrying the entity timeline as research context. null
   * (the default) disables the gate entirely - the pre-gate behavior.
   * Wired in run-researcher.ts, where the Supabase-backed reader lives.
   */
  gate?: PolymarketResearchGateConfig | null
  /**
   * Read-and-conclude research engine (see src/research-engine/). When
   * configured, deep_web candidates run one engine task - an agent with
   * browser/web tools that actually reads sources and is allowed to conclude
   * 'nothing_found' - instead of the legacy planner->last30days->reflection
   * retrieval pipeline. null (the default) keeps the legacy path. Structural
   * contract (just `research(task)`) so tests can inject a stub.
   * Wired in run-researcher.ts; RESEARCH_ENGINE_DISABLED=1 is the kill switch.
   */
  engine?: PolymarketResearchEngineLike | null
}

export interface PolymarketResearchGateConfig {
  reader: EntityMemoryReader
  memoryLimit?: number
  timeoutMs?: number
}

export interface PolymarketResearchEngineLike {
  research(task: ResearchTask): Promise<ResearchConclusion>
}

type ResearchBackend = 'hermes_cli'
type ResearchDepth = 'market_structure_only' | 'reuse_prior' | 'deep_web'
type EvidenceQuality = 'strong' | 'medium' | 'weak'
type RecommendedEditorAction = 'publish_candidate' | 'reject_thin' | 'needs_more_research'

type CandidateStatus =
  | 'pending_research'
  | 'researching'
  | 'researched'
  | 'skipped_recently_researched'
  | 'research_failed'
  | 'rejected'
  | 'published'

interface PendingCandidate {
  id: string
  source: string
  area: string
  candidate_type: string
  market_id: string
  slug: string
  title: string
  tag_slug: string
  tag_label: string | null
  observed_at: string
  what_changed: string
  why_flagged: string
  score: number | string
  score_breakdown: unknown
  metrics: unknown
  evidence_refs: unknown
  status: CandidateStatus
  research_retry_count: number | string | null
  research_next_retry_at: string | null
  research_last_error_kind: string | null
  /**
   * SQL-side counter incremented atomically by claimWithLease (see its doc
   * comment in store.ts: "attemptCount must be incremented in the database,
   * never read-modify-write"). This is the source of truth for retry
   * limiting going forward - see retryCount() below - because
   * research_retry_count is still a read-modify-write field on
   * setCandidateStatus's `extra` (a known, reported interface gap; see
   * updateFailedCandidate).
   */
  attempt_count: number
}

interface PriorResearch {
  id: string
  candidate_id: string
  slug: string
  research_mode: string
  summary: string
  notes: string
  key_findings: unknown
  evidence_links: unknown
  uncertainty: string
  editor_notes: string
  researched_at: string
  research_family_key: string | null
  research_cluster_key: string | null
  research_depth: ResearchDepth | null
  evidence_quality: EvidenceQuality | null
  catalyst_found: boolean | null
  recommended_editor_action: RecommendedEditorAction | null
  research_backend: string | null
  research_model: string | null
}

interface HermesResearchResult {
  candidate_id: string
  research_mode: string
  market_about?: unknown
  resolution_rules?: unknown
  polymarket_context?: unknown
  external_research?: unknown
  verified_facts?: unknown
  unverified_claims?: unknown
  entities_mentioned?: unknown
  claims_found?: unknown
  relationships_found?: unknown
  open_questions?: unknown
  research_completeness?: unknown
  summary: string
  notes: string
  key_findings: unknown[]
  evidence_links: unknown[]
  related_context: unknown[]
  uncertainty: string
  editor_notes: string
  evidence_quality?: unknown
  catalyst_found?: unknown
  recommended_editor_action?: unknown
  /** Set only on results produced by the research engine; drives per-outcome
   * research-row status ('nothing_found' rows are written status=rejected so
   * they never enter the editor queue) and backend labeling. */
  engine_outcome?: 'answered' | 'nothing_found' | 'partial'
}

interface ResearchFailure {
  candidate: PendingCandidate
  error: string
}

interface ResearchAttempt {
  results: Map<string, HermesResearchResult>
  failures: ResearchFailure[]
}

interface Last30DaysSubquery {
  label: string
  search_query: string
  ranking_query: string
  sources: string[]
  weight: number
}

interface Last30DaysPlan {
  intent: string
  freshness_mode: string
  cluster_mode: string
  subqueries: Last30DaysSubquery[]
}

interface ResearchReflectionPlan {
  research_goal: string
  known_from_polymarket: string[]
  do_not_research: string[]
  last30days_topic: string
  lookback_days: number
  search_sources: string[]
  subreddits: string[]
  polymarket_keywords: string[]
  last30days_plan: Last30DaysPlan
  evidence_to_collect: string[]
  expected_entities: string[]
  notes: string
}

interface ResearchBrief {
  research_goal: string
  last30days_topic: string
  lookback_days: number
  search_sources: string[]
  subreddits: string[]
  polymarket_keywords: string[]
  last30days_plan: Last30DaysPlan
  evidence_to_collect: string[]
  expected_entities: string[]
  notes: string
}

interface PlannerResult {
  plan: ResearchReflectionPlan
  raw: string
  error: string | null
}

interface RetrievalReflection {
  search_again: boolean
  next_last30days_topic: string
  next_search_sources: string[]
  next_subreddits: string[]
  next_polymarket_keywords: string[]
  next_subqueries: Last30DaysSubquery[]
  notes: string
}

interface TriageDecision {
  candidate: PendingCandidate
  depth: ResearchDepth
  familyKey: string
  clusterKey: string
  prior?: PriorResearch
  reason: string
}

/** A triage decision that survived the pre-research gate; when the gate
 * resolved entities, their timeline rides along as research context. */
interface GatedTriageDecision extends TriageDecision {
  entityContext?: GateEntityContext
}

interface EnrichedTriageDecision extends GatedTriageDecision {
  polymarketNativeContext?: PolymarketNativeContext
  polymarketNativeContextError?: string
}

interface ResearchRowInput {
  candidate_id: string
  source: string
  area: string
  slug: string
  title: string
  candidate_type: string
  research_mode: string
  summary: string
  notes: string
  key_findings: unknown[]
  evidence_links: unknown[]
  related_context: unknown[]
  uncertainty: string
  editor_notes: string
  /** 'rejected' is used for engine 'nothing_found' conclusions: the row is
   * the audit trail (what was checked), but it never reaches the editor and
   * never files entity memories - both consume only 'pending_editor' rows. */
  status: 'pending_editor' | 'rejected'
  researched_at: string
  updated_at: string
  research_family_key: string
  research_cluster_key: string
  research_depth: ResearchDepth
  evidence_quality: EvidenceQuality
  catalyst_found: boolean
  recommended_editor_action: RecommendedEditorAction
  duplicate_of_research_id: string | null
  research_backend: string
  research_model: string | null
}

export interface PolymarketResearcherResult {
  observedAt: string
  backend: string
  pendingFetched: number
  eligibleForResearch: number
  skippedRecentlyResearched: number
  retriedFailedCandidates: number
  reusedPriorResearch: number
  marketStructureOnly: number
  deepWebResearched: number
  /** Engine conclusions of 'nothing_found': researched, audited, and kept
   * away from the editor. Subset of researchRowsWritten. */
  nothingFound: number
  researchRowsWritten: number
  candidatesMarkedResearched: number
  candidatesMarkedFailed: number
  researched: Array<{
    candidateId: string
    slug: string
    researchMode: string
    summary: string
  }>
  skipped: Array<{
    candidateId: string
    slug: string
    reason: string
  }>
  failed: Array<{
    candidateId: string
    slug: string
    error: string
  }>
}

function selectedBackend(partial?: ResearchBackend): ResearchBackend {
  const backend = partial ?? 'hermes_cli'
  if (backend !== 'hermes_cli') throw new Error(`Unsupported Polymarket researcher backend: ${backend}`)
  return backend
}

export function defaultLast30DaysScriptPath(home = process.env.HOME ?? ''): string {
  return home === '/root'
    ? VPS_LAST30DAYS_SCRIPT
    : `${home}/.codex/skills/last30days/scripts/last30days.py`
}

function selectedOptions(partial: PolymarketResearcherOptions): Required<PolymarketResearcherOptions> {
  return {
    now: partial.now ?? new Date().toISOString(),
    batchSize: partial.batchSize ?? DEFAULT_BATCH_SIZE,
    slugCooldownMinutes: partial.slugCooldownMinutes ?? DEFAULT_SLUG_COOLDOWN_MINUTES,
    retryWindowMinutes: partial.retryWindowMinutes ?? DEFAULT_RETRY_WINDOW_MINUTES,
    maxRetryCount: partial.maxRetryCount ?? DEFAULT_MAX_RETRY_COUNT,
    structureOnlyScoreMax: partial.structureOnlyScoreMax ?? DEFAULT_STRUCTURE_ONLY_SCORE_MAX,
    thinVolume24hMax: partial.thinVolume24hMax ?? DEFAULT_THIN_VOLUME_24H_MAX,
    thinLiquidityMax: partial.thinLiquidityMax ?? DEFAULT_THIN_LIQUIDITY_MAX,
    backend: selectedBackend(partial.backend),
    researchModel: partial.researchModel ?? DEFAULT_RESEARCH_MODEL,
    hermesCommand: partial.hermesCommand ?? DEFAULT_HERMES_COMMAND,
    researchPlannerHermesToolsets: partial.researchPlannerHermesToolsets ?? '',
    researchPlannerHermesIgnoreRules: partial.researchPlannerHermesIgnoreRules ?? true,
    researchPlannerHermesTimeoutMs: partial.researchPlannerHermesTimeoutMs ?? DEFAULT_HERMES_TIMEOUT_MS,
    last30DaysPython: partial.last30DaysPython ?? DEFAULT_LAST30DAYS_PYTHON,
    last30DaysScript: partial.last30DaysScript ?? defaultLast30DaysScriptPath(),
    last30DaysTimeoutMs: partial.last30DaysTimeoutMs ?? DEFAULT_LAST30DAYS_TIMEOUT_MS,
    last30DaysWebBackend: partial.last30DaysWebBackend ?? DEFAULT_LAST30DAYS_WEB_BACKEND,
    maxCandidateAgeHours: partial.maxCandidateAgeHours ?? DEFAULT_MAX_CANDIDATE_AGE_HOURS,
    leaseOwner: partial.leaseOwner ?? `researcher:${hostname()}:${process.pid}:${randomUUID()}`,
    leaseSeconds: partial.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
    hermes: partial.hermes ?? new HermesService({ command: partial.hermesCommand ?? DEFAULT_HERMES_COMMAND }),
    gate: partial.gate ?? null,
    engine: partial.engine ?? null,
  }
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function normalizeStringOption<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback
}

function normalizeEvidenceQuality(value: unknown): EvidenceQuality {
  return normalizeStringOption(value, ['strong', 'medium', 'weak'] as const, 'medium')
}

function normalizeRecommendedEditorAction(value: unknown): RecommendedEditorAction {
  return normalizeStringOption(value, ['publish_candidate', 'reject_thin', 'needs_more_research'] as const, 'needs_more_research')
}

function compatibilityEvidenceQuality(value: unknown): EvidenceQuality {
  const normalized = asString(value).toLowerCase().trim()
  if (normalized === 'complete') return 'strong'
  if (normalized === 'blocked') return 'weak'
  if (normalized === 'partial') return 'medium'
  return normalizeEvidenceQuality(value)
}

function researchPacketForResult(result: HermesResearchResult): Record<string, unknown> {
  return {
    kind: 'research_packet',
    market_about: result.market_about ?? null,
    resolution_rules: result.resolution_rules ?? null,
    polymarket_context: result.polymarket_context ?? null,
    external_research: result.external_research ?? null,
    verified_facts: asArray(result.verified_facts),
    unverified_claims: asArray(result.unverified_claims),
    entities_mentioned: asArray(result.entities_mentioned),
    claims_found: asArray(result.claims_found),
    relationships_found: asArray(result.relationships_found),
    open_questions: asArray(result.open_questions),
    research_completeness: asString(result.research_completeness, 'partial'),
  }
}

function titleFamilyKey(text: string): string {
  const stopWords = new Set(['will', 'the', 'and', 'for', 'with', 'before', 'after', 'this', 'that', 'what', 'when', 'who', 'how', 'many'])
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopWords.has(word))
    .slice(0, 8)
    .join('-')
}

function candidateFamilyKeys(candidate: Pick<PendingCandidate, 'slug' | 'title'>): string[] {
  const keys = new Set<string>([`slug:${candidate.slug}`])
  const titleKey = titleFamilyKey(candidate.title ?? candidate.slug)
  if (titleKey) keys.add(`title:${titleKey}`)
  return [...keys]
}

function primaryFamilyKey(candidate: Pick<PendingCandidate, 'slug' | 'title'>): string {
  const keys = candidateFamilyKeys(candidate)
  return keys.find((key) => key.startsWith('title:')) ?? keys[0] ?? `slug:${candidate.slug}`
}

function clusterKeyForCandidate(candidate: PendingCandidate): string {
  return `${SOURCE}:${AREA}:${primaryFamilyKey(candidate)}`
}

/**
 * Cutoff used by expireAgedWork (BUG 2 fix). This used to also gate the
 * pending-candidate FETCH via `.gte('observed_at', cutoff)`
 * (`observedAfter` below): candidates older than maxCandidateAgeHours simply
 * never appeared in a query again, with no terminal status, no retry, no
 * visibility - they sat in 'pending_research' forever. That silent filter has
 * been removed from every fetch. This cutoff is now used ONLY to decide what
 * counts as "aged" for expireAgedWork, which WRITES the terminal
 * 'stale_expired' status, so aged-out work becomes a countable, queryable
 * outcome instead of vanishing.
 */
function candidateAgeCutoff(options: Required<PolymarketResearcherOptions>): string | null {
  if (!Number.isFinite(options.maxCandidateAgeHours) || options.maxCandidateAgeHours <= 0) return null
  return new Date(new Date(options.now).getTime() - options.maxCandidateAgeHours * 60 * 60 * 1000).toISOString()
}

function toPendingCandidate(row: PipelineCandidateRow): PendingCandidate {
  return {
    id: row.id,
    source: row.source,
    area: row.area,
    candidate_type: row.candidateType,
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
    status: row.status as CandidateStatus,
    research_retry_count: row.researchRetryCount,
    research_next_retry_at: row.researchNextRetryAt,
    research_last_error_kind: row.researchLastErrorKind,
    attempt_count: row.attemptCount,
  }
}

/**
 * Claims the pending lane AND the retry lane through the SAME lease-backed
 * path (BUG 1 fix).
 *
 * The old flow selected candidates with a plain read (fetchPendingCandidates)
 * and only flipped them to 'researching' afterwards, in a separate step
 * (markCandidatesResearching), with no lease and no expiry. Any crash between
 * those two steps - or during the research itself - stranded the row in
 * 'researching' forever: the fetch queries only look at 'pending_research'
 * and 'research_failed', so a 'researching' row becomes permanently invisible
 * to every future run. That is the exact "researching black hole" that
 * stranded 14 rows in production.
 *
 * claimWithLease closes this by claiming AND leasing atomically: a claimed
 * row's lease_expires_at is set in the same transaction that flips its
 * status, and a lease that is never renewed or released (worker crashed,
 * process killed, box rebooted) becomes reclaimable again once it expires -
 * see recoverExpiredLeases, called once per run in runPolymarketResearcher.
 *
 * The retry lane (status = 'research_failed') is a separate SQL lane that
 * claimWithLease's claimable-set predicate does not cover (it only matches
 * 'pending_research' and expired-lease 'researching' rows - see its doc
 * comment in store.ts). claimRetryableWithLease claims that lane atomically
 * too - selecting retry-eligible rows, flipping them to leased-and-in-flight,
 * and incrementing attempt_count, all in the SAME transaction - so retry-lane
 * work never passes through an intermediate promoted-but-unleased state the
 * way a separate setCandidateStatus-then-claimWithLease call would.
 */
interface ClaimedResearchCandidates {
  candidates: PendingCandidate[]
  /** Ids that came from the retry lane (status was 'research_failed'), for reporting. */
  retriedCandidateIds: string[]
}

async function claimResearchCandidates(
  store: PipelineStore,
  options: Required<PolymarketResearcherOptions>
): Promise<ClaimedResearchCandidates> {
  const claimed = await store.claimWithLease({
    source: SOURCE,
    area: AREA,
    stage: RESEARCH_STAGE,
    limit: options.batchSize,
    leaseOwner: options.leaseOwner,
    leaseSeconds: options.leaseSeconds,
    now: options.now,
  })

  const remaining = options.batchSize - claimed.length
  if (remaining <= 0) return { candidates: claimed.map(toPendingCandidate), retriedCandidateIds: [] }

  // KNOWN INTERFACE GAP (reported, not silently patched): the original
  // pending-lane query ordered by score DESC, observed_at ASC, and the
  // retry-lane query ordered by research_next_retry_at ASC NULLS FIRST,
  // score DESC. claimWithLease/claimRetryableWithLease only order by
  // observed_at ASC (see their doc comments / sqlite-store.ts). Since both
  // queries are limited (batchSize / remaining), a batch that gets truncated
  // will pick different rows than before: the original prioritized
  // highest-score (pending lane) or soonest-due (retry lane) candidates
  // within the batch window, while the store version prioritizes oldest
  // observed_at only.
  const claimedRetries = await store.claimRetryableWithLease({
    source: SOURCE,
    area: AREA,
    stage: RESEARCH_STAGE,
    limit: remaining,
    leaseOwner: options.leaseOwner,
    leaseSeconds: options.leaseSeconds,
    now: options.now,
    maxRetryCount: options.maxRetryCount,
  })

  return {
    candidates: [...claimed, ...claimedRetries].map(toPendingCandidate),
    retriedCandidateIds: claimedRetries.map((row) => row.id),
  }
}

function toPriorResearch(row: PipelineResearchRow): PriorResearch {
  return {
    id: row.id,
    candidate_id: row.candidateId,
    slug: row.slug,
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

async function fetchRecentResearch(store: PipelineStore, slugs: string[], familyKeys: string[]): Promise<{
  bySlug: Map<string, PriorResearch[]>
  byFamilyKey: Map<string, PriorResearch[]>
}> {
  const bySlug = new Map<string, PriorResearch[]>()
  const byFamilyKey = new Map<string, PriorResearch[]>()
  if (slugs.length === 0 && familyKeys.length === 0) return { bySlug, byFamilyKey }
  const uniqueRows = new Map<string, PriorResearch>()

  // NOTE (tenancy filter): this lookup has no source/area filter, matching
  // the PRE-EXISTING behavior of the direct Supabase queries it replaces
  // (neither `.in('slug', slugs)` nor `.in('research_family_key', ...)` here
  // filtered on source/area either), even though every sibling query in this
  // file does filter on both. Preserved as-is during this migration rather
  // than silently made consistent with the other queries.
  if (slugs.length > 0) {
    const rows = await store.findPriorResearch({ keyType: 'slug', keys: slugs, limit: 100 })
    for (const row of rows) uniqueRows.set(row.id, toPriorResearch(row))
  }

  if (familyKeys.length > 0) {
    const rows = await store.findPriorResearch({ keyType: 'family', keys: familyKeys, limit: 200 })
    for (const row of rows) uniqueRows.set(row.id, toPriorResearch(row))
  }

  for (const research of uniqueRows.values()) {
    const rows = bySlug.get(research.slug) ?? []
    rows.push(research)
    bySlug.set(research.slug, rows)
    if (research.research_family_key) {
      const familyRows = byFamilyKey.get(research.research_family_key) ?? []
      familyRows.push(research)
      byFamilyKey.set(research.research_family_key, familyRows)
    }
  }

  for (const rows of bySlug.values()) rows.sort((a, b) => new Date(b.researched_at).getTime() - new Date(a.researched_at).getTime())
  for (const rows of byFamilyKey.values()) rows.sort((a, b) => new Date(b.researched_at).getTime() - new Date(a.researched_at).getTime())
  return { bySlug, byFamilyKey }
}

function recentPrior(prior: PriorResearch[] | undefined, nowMs: number, cooldownMinutes: number): PriorResearch | null {
  const latest = prior?.[0]
  if (!latest) return null
  const ageMs = nowMs - new Date(latest.researched_at).getTime()
  return ageMs >= 0 && ageMs < cooldownMinutes * 60 * 1000 ? latest : null
}

interface CandidateStatusExtra {
  researchRetryCount?: number
  researchNextRetryAt?: string | null
  researchLastErrorKind?: string | null
}

async function updateCandidateStatus(
  store: PipelineStore,
  ids: string[],
  status: CandidateStatus,
  observedAt: string,
  researchError?: string | null,
  extraPayload: CandidateStatusExtra = {}
): Promise<void> {
  if (ids.length === 0) return

  // KNOWN GAP (minor, reported): the original write also set
  // updated_at = observedAt. PipelineSetCandidateStatusInput has no
  // updatedAt field - setCandidateStatus stamps its own updated_at with
  // CURRENT_TIMESTAMP server-side instead of the caller-supplied observedAt.
  // Nothing in this file reads updated_at back for filtering, so this is
  // bookkeeping-only, not a behavior change to any decision logic.
  await store.setCandidateStatus({
    ids,
    status,
    observedAt,
    researchError,
    extra: {
      ...extraPayload,
      researchAttemptedAt: observedAt,
    },
  })
}

function errorKind(error: string): string {
  const normalized = error.toLowerCase()
  if (normalized.includes('timeout') || normalized.includes('timed out')) return 'timeout'
  if (normalized.includes('invalid json') || normalized.includes('valid research result')) return 'invalid_response'
  if (normalized.includes('enoent') || normalized.includes('not found')) return 'backend_unavailable'
  return 'backend_error'
}

/**
 * Retry count for cap-enforcement and reporting purposes.
 *
 * Prefers attempt_count - the SQL-side counter claimWithLease increments
 * atomically in the same transaction that claims the row (`attempt_count =
 * attempt_count + 1`, see sqlite-store.ts and store.ts's doc comment: "must
 * be incremented in the database, never read-modify-write"). Every candidate
 * this function sees has been through claimWithLease (see
 * claimResearchCandidates), so attempt_count is always populated and always
 * reflects the true number of claims - including claims from workers that
 * crashed mid-research and never wrote research_retry_count at all, which a
 * research_retry_count-only read would silently miss.
 *
 * Falls back to research_retry_count only for callers/tests constructing a
 * PendingCandidate by hand without an attempt_count.
 */
function retryCount(candidate: PendingCandidate): number {
  const attempts = numberOrNull(candidate.attempt_count)
  if (attempts != null) return attempts
  return numberOrNull(candidate.research_retry_count) ?? 0
}

async function updateSuccessfulCandidates(
  store: PipelineStore,
  ids: string[],
  observedAt: string
): Promise<void> {
  await updateCandidateStatus(store, ids, 'researched', observedAt, null, {
    researchNextRetryAt: null,
    researchLastErrorKind: null,
  })
}

async function updateFailedCandidate(
  store: PipelineStore,
  failure: ResearchFailure,
  observedAt: string,
  options: Required<PolymarketResearcherOptions>
): Promise<void> {
  const nextRetryAt = new Date(new Date(observedAt).getTime() + options.retryWindowMinutes * 60 * 1000).toISOString()
  // research_retry_count is written here purely to mirror attempt_count into
  // a column kept for reporting/back-compat (claimRetryableWithLease, like
  // claimWithLease, gates on attempt_count - see its doc comment in
  // store.ts - not on research_retry_count; see the interface-gap note on
  // retryCount above). Writing retryCount(candidate) directly (attempt_count,
  // already incremented atomically and race-free by claimWithLease at claim
  // time) is NOT a read-modify-write: unlike the prior
  // `retryCount(candidate) + 1`, this does not add to a value read at an
  // earlier point in time, it copies a count that was already correct and
  // atomic the moment the candidate was claimed.
  await updateCandidateStatus(store, [failure.candidate.id], 'research_failed', observedAt, failure.error.slice(0, 2000), {
    researchRetryCount: retryCount(failure.candidate),
    researchNextRetryAt: nextRetryAt,
    researchLastErrorKind: errorKind(failure.error),
  })
}

function metricValue(candidate: PendingCandidate, keys: string[]): number | null {
  if (!candidate.metrics || typeof candidate.metrics !== 'object') return null
  const metrics = candidate.metrics as Record<string, unknown>
  for (const key of keys) {
    const value = numberOrNull(metrics[key])
    if (value != null) return value
  }
  return null
}

function evidenceUrls(candidate: PendingCandidate): string[] {
  return asArray(candidate.evidence_refs)
    .flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const record = item as Record<string, unknown>
      return asString(record.source_url || record.url)
    })
    .filter(Boolean)
}

function hasCurrentContextCue(candidate: PendingCandidate): boolean {
  return /\b(election|fed|cpi|tariff|war|ceasefire|sec|etf|earnings|court|rate|inflation|crypto|bitcoin|ethereum|oil|gold)\b/i.test([
    candidate.slug,
    candidate.title,
    candidate.tag_slug,
    candidate.tag_label,
    candidate.what_changed,
    candidate.why_flagged,
  ].filter(Boolean).join(' '))
}

function classifyResearchDepth(
  candidate: PendingCandidate,
  priorResearch: { bySlug: Map<string, PriorResearch[]>, byFamilyKey: Map<string, PriorResearch[]> },
  nowMs: number,
  options: Required<PolymarketResearcherOptions>
): TriageDecision {
  const familyKey = primaryFamilyKey(candidate)
  const clusterKey = clusterKeyForCandidate(candidate)
  const exactPrior = recentPrior(priorResearch.bySlug.get(candidate.slug), nowMs, options.slugCooldownMinutes)
  if (exactPrior) {
    return { candidate, depth: 'reuse_prior', familyKey, clusterKey, prior: exactPrior, reason: 'recent_exact_slug_research' }
  }

  const familyPrior = recentPrior(priorResearch.byFamilyKey.get(familyKey), nowMs, options.slugCooldownMinutes)
  const score = numberOrNull(candidate.score) ?? 0
  if (familyPrior && score <= Math.max(70, options.structureOnlyScoreMax)) {
    return { candidate, depth: 'reuse_prior', familyKey, clusterKey, prior: familyPrior, reason: 'recent_family_research' }
  }

  const volume24h = metricValue(candidate, ['currentVolume24h', 'volume24h'])
  const volume = metricValue(candidate, ['currentVolume', 'volume'])
  const liquidity = metricValue(candidate, ['liquidity'])
  const thinLiquidity = liquidity == null || liquidity <= options.thinLiquidityMax
  const thinVolume = (volume24h ?? volume ?? 0) <= options.thinVolume24hMax
  if (score <= options.structureOnlyScoreMax && thinVolume && thinLiquidity && !hasCurrentContextCue(candidate)) {
    return { candidate, depth: 'market_structure_only', familyKey, clusterKey, reason: 'low_score_thin_market_structure' }
  }

  return { candidate, depth: 'deep_web', familyKey, clusterKey, reason: 'needs_current_context' }
}

function triageCandidates(
  candidates: PendingCandidate[],
  priorResearch: { bySlug: Map<string, PriorResearch[]>, byFamilyKey: Map<string, PriorResearch[]> },
  nowMs: number,
  options: Required<PolymarketResearcherOptions>
): TriageDecision[] {
  return candidates.map((candidate) => classifyResearchDepth(candidate, priorResearch, nowMs, options))
}

function buildReusePriorRow(decision: TriageDecision, observedAt: string, options: Required<PolymarketResearcherOptions>): ResearchRowInput {
  const candidate = decision.candidate
  const prior = decision.prior
  if (!prior) throw new Error(`reuse_prior triage missing prior research for candidate ${candidate.id}`)
  return {
    candidate_id: candidate.id,
    source: candidate.source,
    area: candidate.area,
    slug: candidate.slug,
    title: candidate.title,
    candidate_type: candidate.candidate_type,
    research_mode: prior.research_mode,
    summary: `Reused recent research from ${prior.slug}: ${prior.summary}`,
    notes: [
      `Reuse reason: ${decision.reason}.`,
      `Current signal: ${candidate.what_changed}`,
      prior.notes,
    ].filter(Boolean).join('\n'),
    key_findings: asArray(prior.key_findings),
    evidence_links: asArray(prior.evidence_links),
    related_context: [{ kind: 'reused_prior_research', research_id: prior.id, slug: prior.slug, researched_at: prior.researched_at }],
    uncertainty: prior.uncertainty || 'Prior research was reused; verify whether the market moved because of a new catalyst.',
    editor_notes: `This row reused recent ${decision.reason === 'recent_exact_slug_research' ? 'exact-slug' : 'family'} research. Compare the current candidate metrics before publishing. ${prior.editor_notes}`.trim(),
    status: 'pending_editor',
    researched_at: observedAt,
    updated_at: observedAt,
    research_family_key: decision.familyKey,
    research_cluster_key: decision.clusterKey,
    research_depth: 'reuse_prior',
    evidence_quality: prior.evidence_quality ?? 'medium',
    catalyst_found: prior.catalyst_found ?? false,
    recommended_editor_action: prior.recommended_editor_action ?? 'needs_more_research',
    duplicate_of_research_id: prior.id,
    research_backend: options.backend,
    research_model: options.researchModel,
  }
}

function buildMarketStructureRow(decision: TriageDecision, observedAt: string, options: Required<PolymarketResearcherOptions>): ResearchRowInput {
  const candidate = decision.candidate
  const score = numberOrNull(candidate.score) ?? 0
  const urls = evidenceUrls(candidate)
  const priceDelta = metricValue(candidate, ['oddsDelta'])
  const volumeDeltaPct = metricValue(candidate, ['volumeDeltaPct', 'activityDeltaPct'])
  const volume = metricValue(candidate, ['currentVolume', 'currentVolume24h', 'volume'])
  const keyFindings = [
    `${candidate.candidate_type} signal scored ${round(score, 1)} and was routed as market-structure-only.`,
    candidate.what_changed,
    candidate.why_flagged,
    priceDelta != null ? `Observed odds delta: ${round(priceDelta * 100, 2)} percentage points.` : '',
    volumeDeltaPct != null ? `Observed volume/activity delta: ${round(volumeDeltaPct * 100, 1)}%.` : '',
  ].filter(Boolean)

  return {
    candidate_id: candidate.id,
    source: candidate.source,
    area: candidate.area,
    slug: candidate.slug,
    title: candidate.title,
    candidate_type: candidate.candidate_type,
    research_mode: 'market_structure',
    summary: `${candidate.title} was captured as a market-structure-only research packet. ${candidate.what_changed}`,
    notes: [
      `Triage reason: ${decision.reason}.`,
      `Score: ${round(score, 1)}.`,
      volume != null ? `Reported market volume/activity metric: ${round(volume, 2)}.` : '',
      `Polymarket evidence refs: ${urls.length > 0 ? urls.join(', ') : 'none supplied'}.`,
    ].filter(Boolean).join('\n'),
    key_findings: keyFindings,
    evidence_links: urls.map((url) => ({ title: 'Polymarket market evidence', url, note: 'Candidate-supplied market reference' })),
    related_context: [{ kind: 'research_triage', depth: 'market_structure_only', family_key: decision.familyKey, cluster_key: decision.clusterKey }],
    uncertainty: 'Market-structure-only packet. Entity Manager should interpret the supplied market context.',
    editor_notes: 'Research packet only. Entity Manager should extract entities/evidence before any feed/editor decision.',
    status: 'pending_editor',
    researched_at: observedAt,
    updated_at: observedAt,
    research_family_key: decision.familyKey,
    research_cluster_key: decision.clusterKey,
    research_depth: 'market_structure_only',
    evidence_quality: 'medium',
    catalyst_found: false,
    recommended_editor_action: 'needs_more_research',
    duplicate_of_research_id: null,
    research_backend: 'local_triage',
    research_model: 'deterministic_market_structure',
  }
}

function sourceNativeFallbackQuestions(candidate: PendingCandidate): string[] {
  return [
    `What is the market "${candidate.title}" about in plain terms?`,
    'What are the exact resolution rules and resolution source from Polymarket?',
    'Are there deadline/date inconsistencies between title, rule text, end date, and event group?',
    'What sibling markets exist in the same parent event, and do they form a date ladder or related outcome set?',
    'What does Polymarket-native structure show: price, liquidity, volume, 24h activity, and freshness?',
    'Based only on Polymarket-native data, what is known, what is unknown, and what external research is needed?',
  ]
}

function compactContext(context: PolymarketNativeContext): Record<string, unknown> {
  return {
    source_url: context.source_url,
    market: context.market,
    market_structure: context.market_structure,
    parent_event: context.parent_event,
    sibling_markets: context.sibling_markets,
  }
}

/**
 * Partition deep_web triage decisions through the pre-research entity gate.
 *
 * Sequential on purpose: gate calls are cheap structured hermes calls, and
 * the hermes CLI is one local subprocess - fanning out buys nothing. With no
 * gate configured (options.gate === null) every decision proceeds untouched,
 * which is the exact pre-gate behavior.
 *
 * Only 'already_known' stops a candidate. All other verdicts - including
 * every gate-infrastructure failure (fail open, see research-gate/gate.ts) -
 * proceed, carrying the resolved entity timeline when one exists so the
 * planner can ask a diff question instead of researching from scratch.
 */
async function gateDeepWebDecisions(
  decisions: TriageDecision[],
  options: Required<PolymarketResearcherOptions>
): Promise<{
  proceed: GatedTriageDecision[]
  known: Array<{ decision: TriageDecision, gate: GateDecision }>
}> {
  if (!options.gate || decisions.length === 0) {
    return { proceed: decisions, known: [] }
  }

  const proceed: GatedTriageDecision[] = []
  const known: Array<{ decision: TriageDecision, gate: GateDecision }> = []
  for (const decision of decisions) {
    const candidate = decision.candidate
    const gate = await gateSignal({
      source: candidate.source,
      sourceRefId: candidate.slug,
      title: candidate.title,
      whatChanged: candidate.what_changed,
      observedAt: candidate.observed_at,
    }, {
      hermes: options.hermes,
      reader: options.gate.reader,
      memoryLimit: options.gate.memoryLimit,
      timeoutMs: options.gate.timeoutMs,
    })
    if (!gate.proceed) {
      known.push({ decision, gate })
    } else {
      proceed.push({ ...decision, entityContext: gate.entityContext ?? undefined })
    }
  }
  return { proceed, known }
}

function buildPlannerPrompt(
  context: PolymarketNativeContext,
  candidate: PendingCandidate,
  entityContext?: GateEntityContext
): string {
  return [
    'You are the myboon Polymarket Research Planner.',
    '',
    'Your job is not to do research. Your job is to create the best focused research brief for the next worker.',
    '',
    'You receive source-native Polymarket context and the candidate observation that triggered research.',
    'Do not ask the next worker to research facts already present in Polymarket-native context.',
    'Ask only for missing external context that could explain why traders may have repriced this market.',
    'The next worker will only receive your research brief, not the full Polymarket context.',
    '',
    'Return strict JSON only. No markdown.',
    '',
    'JSON shape:',
    JSON.stringify({
      research_goal: 'What changed in the last 30 days that could explain the market sentiment or price move?',
      known_from_polymarket: ['facts already known from source-native context'],
      do_not_research: ['Polymarket rules already supplied', 'current odds already supplied'],
      last30days_topic: 'short topic string for last30days.py',
      lookback_days: 30,
      search_sources: ['reddit', 'grounding', 'polymarket'],
      subreddits: ['relevant', 'subreddits'],
      polymarket_keywords: ['keywords'],
      last30days_plan: {
        intent: 'prediction | breaking_news | concept',
        freshness_mode: 'strict_recent | balanced_recent | evergreen_ok',
        cluster_mode: 'story | market | none',
        subqueries: [
          {
            label: 'short_label',
            search_query: 'keyword-heavy query, no temporal phrases',
            ranking_query: 'natural-language question the research should answer',
            sources: ['reddit', 'grounding', 'polymarket'],
            weight: 1,
          },
        ],
      },
      evidence_to_collect: ['specific evidence types to collect'],
      expected_entities: ['entities likely relevant for Entity Memory'],
      notes: 'short instruction to the researcher',
    }, null, 2),
    '',
    'Candidate observation:',
    JSON.stringify({
      id: candidate.id,
      candidate_type: candidate.candidate_type,
      slug: candidate.slug,
      title: candidate.title,
      tag_slug: candidate.tag_slug,
      tag_label: candidate.tag_label,
      observed_at: candidate.observed_at,
      what_changed: candidate.what_changed,
      why_flagged: candidate.why_flagged,
      score: candidate.score,
      score_breakdown: candidate.score_breakdown,
      metrics: candidate.metrics,
    }, null, 2),
    '',
    'Polymarket-native context:',
    JSON.stringify(compactContext(context), null, 2),
    ...(entityContext ? [
      '',
      'Entity memory timeline - what we already know about this subject (newest first):',
      JSON.stringify({
        entities: entityContext.entities.map((entity) => ({
          slug: entity.slug,
          name: entity.name,
          summary: entity.summary,
        })),
        recent_memories: entityContext.recentMemories.map((memory) => ({
          event_at: memory.eventAt,
          memory_type: memory.memoryType,
          title: memory.title,
          summary: memory.summary,
        })),
      }, null, 2),
      '',
      'The research goal MUST target what changed AFTER the newest timeline entry above.',
      'Do not ask the worker to re-research facts the timeline already records.',
    ] : []),
  ].join('\n')
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  const items = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  return items.length > 0 ? items : fallback
}

function sanitizeLast30DaysSources(value: unknown, fallback = LAST30DAYS_DEFAULT_SOURCES): string[] {
  const input = Array.isArray(value) ? value : fallback
  const sources = input
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => !LAST30DAYS_DISABLED_SOURCE_ALIASES.has(item))
    .filter((item) => LAST30DAYS_ALLOWED_SOURCES.has(item))
  const unique = [...new Set(sources)]
  return unique.length > 0 ? unique : fallback.filter((item) => LAST30DAYS_ALLOWED_SOURCES.has(item))
}

function fallbackReflectionPlan(context: PolymarketNativeContext, candidate: PendingCandidate): ResearchReflectionPlan {
  const title = context.market.title || candidate.title
  const text = [context.market.slug, title, context.parent_event?.title, candidate.tag_slug, candidate.tag_label].join(' ').toLowerCase()
  const isFed = /\bfed\b|\bfomc\b|federal reserve|interest rate|rates?|bps|basis point|inflation|cpi|jobs|powell/.test(text)
  const isPolitics = /\bstarmer\b|\blabou?r\b|\buk\b|\bprime minister\b|\belection\b|\bresign|\bgovernment\b|\bparliament\b/.test(text)

  if (isFed) {
    return {
      research_goal: 'Find what changed in the last 30 days that could explain higher Fed hike, cut, or no-change sentiment for this market.',
      known_from_polymarket: [
        title,
        `Current Yes price: ${context.market_structure.yes_price ?? 'unknown'}`,
        `Parent event: ${context.parent_event?.title ?? 'unknown'}`,
      ],
      do_not_research: ['Market title/rules/resolution mechanics', 'Current Polymarket odds already supplied'],
      last30days_topic: 'Fed rate decision sentiment change',
      lookback_days: 30,
      search_sources: ['reddit', 'grounding', 'polymarket'],
      subreddits: ['FedWatch', 'Economics', 'finance', 'investing', 'wallstreetbets', 'Bogleheads', 'macro', 'stocks'],
      polymarket_keywords: ['fed', 'fomc', 'hike', 'cut', 'inflation', 'rates'],
      last30days_plan: {
        intent: 'prediction',
        freshness_mode: 'strict_recent',
        cluster_mode: 'story',
        subqueries: [
          {
            label: 'market_sentiment_change',
            search_query: 'Fed rate decision odds inflation yields labor market pricing',
            ranking_query: 'What changed in markets or macro data over the last 30 days that could explain the current Fed decision sentiment?',
            sources: ['reddit', 'grounding', 'polymarket'],
            weight: 1,
          },
          {
            label: 'inflation_repricing',
            search_query: 'inflation expectations Treasury yields Fed funds pricing',
            ranking_query: 'Did inflation expectations, Treasury yields, or Fed funds pricing shift in a way that explains the market move?',
            sources: ['reddit', 'grounding'],
            weight: 0.9,
          },
        ],
      },
      evidence_to_collect: ['Fed/FOMC communication', 'inflation data', 'Treasury yield or rate-pricing repricing', 'related Polymarket rate markets'],
      expected_entities: ['Federal Reserve', 'FOMC', 'Fed funds rate', 'US inflation', 'Treasury yields'],
      notes: 'Research the cause of sentiment change, not whether Polymarket is correct.',
    }
  }

  if (isPolitics) {
    return {
      research_goal: 'Find what changed in the last 30 days in verified political reporting or official activity that could explain this market sentiment.',
      known_from_polymarket: [title],
      do_not_research: ['Market title/rules/resolution mechanics', 'Current Polymarket odds already supplied'],
      last30days_topic: `${title} political context`,
      lookback_days: 30,
      search_sources: ['reddit', 'grounding', 'polymarket'],
      subreddits: ['ukpolitics', 'worldnews', 'politics', 'unitedkingdom'],
      polymarket_keywords: title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, 8),
      last30days_plan: {
        intent: 'prediction',
        freshness_mode: 'strict_recent',
        cluster_mode: 'story',
        subqueries: [
          {
            label: 'political_catalyst',
            search_query: `${title} resignation leadership challenge polling scandal parliament`,
            ranking_query: 'What recent verified political events or reporting could explain this market sentiment?',
            sources: ['reddit', 'grounding', 'polymarket'],
            weight: 1,
          },
        ],
      },
      evidence_to_collect: ['official statements', 'credible reporting', 'polling', 'parliamentary or party mechanism evidence', 'related market moves'],
      expected_entities: [],
      notes: 'Separate verified political facts from trader speculation.',
    }
  }

  return {
    research_goal: 'Find what changed in the last 30 days that could explain this market sentiment or price move.',
    known_from_polymarket: [title],
    do_not_research: ['Market title/rules/resolution mechanics', 'Current Polymarket odds already supplied'],
    last30days_topic: title,
    lookback_days: 30,
    search_sources: ['reddit', 'grounding', 'polymarket'],
    subreddits: ['Polymarket', 'news', 'worldnews'],
    polymarket_keywords: title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, 6),
    last30days_plan: {
      intent: 'prediction',
      freshness_mode: 'strict_recent',
      cluster_mode: 'story',
      subqueries: [
        {
          label: 'sentiment_change',
          search_query: title,
          ranking_query: 'What changed in the last 30 days that could explain this market sentiment or price move?',
          sources: ['reddit', 'grounding', 'polymarket'],
          weight: 1,
        },
      ],
    },
    evidence_to_collect: ['current reporting', 'related market moves', 'credible source links'],
    expected_entities: [],
    notes: 'Research the external cause of sentiment change.',
  }
}

function normalizeReflectionPlan(value: Partial<ResearchReflectionPlan> | null, context: PolymarketNativeContext, candidate: PendingCandidate): ResearchReflectionPlan {
  const fallback = fallbackReflectionPlan(context, candidate)
  const rawPlan = value?.last30days_plan
  const rawSubqueries = Array.isArray(rawPlan?.subqueries) && rawPlan.subqueries.length > 0
    ? rawPlan.subqueries
    : fallback.last30days_plan.subqueries
  const subqueries = rawSubqueries
    .map((item, index) => ({
      label: typeof item.label === 'string' && item.label ? item.label : `query_${index + 1}`,
      search_query: typeof item.search_query === 'string' && item.search_query ? item.search_query : fallback.last30days_topic,
      ranking_query: typeof item.ranking_query === 'string' && item.ranking_query ? item.ranking_query : fallback.research_goal,
      sources: sanitizeLast30DaysSources(item.sources, fallback.search_sources),
      weight: typeof item.weight === 'number' && Number.isFinite(item.weight) ? item.weight : 1,
    }))
    .slice(0, 4)

  return {
    research_goal: typeof value?.research_goal === 'string' && value.research_goal ? value.research_goal : fallback.research_goal,
    known_from_polymarket: asStringArray(value?.known_from_polymarket, fallback.known_from_polymarket),
    do_not_research: asStringArray(value?.do_not_research, fallback.do_not_research),
    last30days_topic: typeof value?.last30days_topic === 'string' && value.last30days_topic ? value.last30days_topic : fallback.last30days_topic,
    lookback_days: typeof value?.lookback_days === 'number' && Number.isFinite(value.lookback_days) ? Math.max(1, Math.min(90, Math.round(value.lookback_days))) : fallback.lookback_days,
    search_sources: sanitizeLast30DaysSources(value?.search_sources, fallback.search_sources),
    subreddits: asStringArray(value?.subreddits, fallback.subreddits),
    polymarket_keywords: asStringArray(value?.polymarket_keywords, fallback.polymarket_keywords),
    last30days_plan: {
      intent: typeof rawPlan?.intent === 'string' && rawPlan.intent ? rawPlan.intent : fallback.last30days_plan.intent,
      freshness_mode: typeof rawPlan?.freshness_mode === 'string' && rawPlan.freshness_mode ? rawPlan.freshness_mode : fallback.last30days_plan.freshness_mode,
      cluster_mode: typeof rawPlan?.cluster_mode === 'string' && rawPlan.cluster_mode ? rawPlan.cluster_mode : fallback.last30days_plan.cluster_mode,
      subqueries,
    },
    evidence_to_collect: asStringArray(value?.evidence_to_collect, fallback.evidence_to_collect),
    expected_entities: asStringArray(value?.expected_entities, fallback.expected_entities),
    notes: typeof value?.notes === 'string' ? value.notes : fallback.notes,
  }
}

function buildResearchBrief(plan: ResearchReflectionPlan): ResearchBrief {
  const searchSources = sanitizeLast30DaysSources(plan.search_sources)
  return {
    research_goal: plan.research_goal,
    last30days_topic: plan.last30days_topic,
    lookback_days: plan.lookback_days,
    search_sources: searchSources,
    subreddits: plan.subreddits,
    polymarket_keywords: plan.polymarket_keywords,
    last30days_plan: {
      ...plan.last30days_plan,
      subqueries: plan.last30days_plan.subqueries.map((query) => ({
        ...query,
        sources: sanitizeLast30DaysSources(query.sources, searchSources),
      })),
    },
    evidence_to_collect: plan.evidence_to_collect,
    expected_entities: plan.expected_entities,
    notes: plan.notes,
  }
}

async function runHermesPlanner(
  context: PolymarketNativeContext,
  candidate: PendingCandidate,
  options: Required<PolymarketResearcherOptions>,
  entityContext?: GateEntityContext
): Promise<PlannerResult> {
  const prompt = buildPlannerPrompt(context, candidate, entityContext)
  try {
    const { value, stdout } = await options.hermes.structured<Partial<ResearchReflectionPlan>>({
      purpose: 'polymarket.researcher.planner',
      prompt,
      timeoutMs: options.researchPlannerHermesTimeoutMs,
      toolsets: options.researchPlannerHermesToolsets || undefined,
      ignoreRules: options.researchPlannerHermesIgnoreRules,
      commandOverride: options.hermesCommand,
    })
    return {
      plan: normalizeReflectionPlan(value, context, candidate),
      raw: stdout.trim(),
      error: value ? null : 'Hermes planner returned non-JSON output; normalized with fallback fields.',
    }
  } catch (error) {
    return {
      plan: fallbackReflectionPlan(context, candidate),
      raw: '',
      error: error instanceof Error ? error.message.replace(/\s+/g, ' ').slice(0, 800) : String(error).slice(0, 800),
    }
  }
}

function last30DaysArgs(brief: ResearchBrief, planPath: string, options: Required<PolymarketResearcherOptions>): string[] {
  const searchSources = sanitizeLast30DaysSources(brief.search_sources)
  const args = [
    options.last30DaysScript,
    brief.last30days_topic,
    '--emit=json',
    `--days=${brief.lookback_days}`,
    `--search=${searchSources.join(',')}`,
    '--plan',
    planPath,
    `--subreddits=${brief.subreddits.join(',')}`,
    `--web-backend=${options.last30DaysWebBackend}`,
  ]
  if (brief.polymarket_keywords.length > 0) args.push(`--polymarket-keywords=${brief.polymarket_keywords.join(',')}`)
  return args
}

function last30DaysPlanPayload(brief: ResearchBrief): Record<string, unknown> {
  const evidenceInstruction = brief.evidence_to_collect.length > 0
    ? `Prioritize evidence types: ${brief.evidence_to_collect.join('; ')}.`
    : ''
  const entityInstruction = brief.expected_entities.length > 0
    ? `Planner entity hints for retrieval only, not observed mentions: ${brief.expected_entities.join(', ')}.`
    : ''
  const notes = [
    `Research goal: ${brief.research_goal}`,
    brief.notes,
    evidenceInstruction,
    entityInstruction,
  ].filter(Boolean)

  return {
    ...brief.last30days_plan,
    notes,
    subqueries: brief.last30days_plan.subqueries.map((query) => ({
      ...query,
      sources: sanitizeLast30DaysSources(query.sources, brief.search_sources),
      ranking_query: [
        query.ranking_query,
        `Research goal: ${brief.research_goal}`,
        evidenceInstruction,
      ].filter(Boolean).join(' '),
    })),
  }
}

function normalizeSubqueries(value: unknown, fallback: Last30DaysSubquery[], fallbackSources = LAST30DAYS_DEFAULT_SOURCES): Last30DaysSubquery[] {
  const rows = asArray(value)
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .map((item, index) => ({
      label: asString(item.label, `search_${index + 1}`),
      search_query: asString(item.search_query),
      ranking_query: asString(item.ranking_query),
      sources: sanitizeLast30DaysSources(item.sources, fallbackSources),
      weight: typeof item.weight === 'number' && Number.isFinite(item.weight) ? item.weight : 1,
    }))
    .filter((item) => item.search_query && item.ranking_query)
    .slice(0, 4)
  return rows.length > 0 ? rows : fallback
}

async function runLast30Days(brief: ResearchBrief, options: Required<PolymarketResearcherOptions>): Promise<{ report: Record<string, unknown>, stderr: string, args: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'myboon-last30days-'))
  const planPath = join(dir, 'plan.json')
  try {
    await writeFile(planPath, JSON.stringify(last30DaysPlanPayload(brief), null, 2))
    const args = last30DaysArgs(brief, planPath, options)
    const { stdout, stderr } = await execFileAsync(options.last30DaysPython, args, {
      timeout: options.last30DaysTimeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        LAST30DAYS_PYTHON: options.last30DaysPython,
      },
    })
    const parsed = extractJson<Record<string, unknown>>(stdout)
    if (!parsed) throw new Error(`last30days returned invalid JSON. stderr=${stderr.slice(0, 500)} stdout=${stdout.slice(0, 1000)}`)
    return { report: parsed, stderr: stderr.trim(), args }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function normalizeRetrievalReflection(value: Partial<RetrievalReflection> | null, prior: ResearchBrief): RetrievalReflection {
  const nextSources = sanitizeLast30DaysSources(value?.next_search_sources, prior.search_sources)
  const fallbackSubqueries = prior.last30days_plan.subqueries
  const nextSubqueries = normalizeSubqueries(value?.next_subqueries, fallbackSubqueries, nextSources)
  const hasNewTopic = typeof value?.next_last30days_topic === 'string' && value.next_last30days_topic.trim().length > 0
  const searchAgain = asBoolean(value?.search_again)
    && (hasNewTopic || JSON.stringify(nextSubqueries) !== JSON.stringify(fallbackSubqueries))
  return {
    search_again: searchAgain,
    next_last30days_topic: hasNewTopic ? value.next_last30days_topic!.trim() : prior.last30days_topic,
    next_search_sources: nextSources,
    next_subreddits: asStringArray(value?.next_subreddits, prior.subreddits),
    next_polymarket_keywords: asStringArray(value?.next_polymarket_keywords, prior.polymarket_keywords),
    next_subqueries: nextSubqueries,
    notes: asString(value?.notes),
  }
}

function buildRetrievalReflectionPrompt(
  context: PolymarketNativeContext,
  candidate: PendingCandidate,
  brief: ResearchBrief,
  report: Record<string, unknown>,
  stderr: string
): string {
  return [
    'You are the myboon Polymarket Researcher controlling one more retrieval pass.',
    '',
    'Your only job is to decide whether the next retrieval query should be changed and run once more.',
    'Do not judge the evidence. Do not classify quality. Do not decide whether a catalyst exists. Do not accept or reject links.',
    'If the current retrieval is clearly off-topic, too generic, or missed the specific research goal, set search_again=true and provide a sharper next search plan.',
    'If another query is unlikely to collect materially different context, set search_again=false.',
    '',
    'Return strict JSON only. No markdown.',
    '',
    'JSON shape:',
    JSON.stringify({
      search_again: false,
      next_last30days_topic: 'better topic only if search_again is true',
      next_search_sources: ['reddit', 'grounding', 'polymarket'],
      next_subreddits: ['relevant_subreddit'],
      next_polymarket_keywords: ['keyword'],
      next_subqueries: [{
        label: 'short_label',
        search_query: 'precise keyword query',
        ranking_query: 'what the retrieval should collect',
        sources: ['reddit', 'grounding'],
        weight: 1,
      }],
      notes: 'why the next query is different, or why no more retrieval is needed',
    }, null, 2),
    '',
    'Candidate observation:',
    JSON.stringify({
      id: candidate.id,
      candidate_type: candidate.candidate_type,
      slug: candidate.slug,
      title: candidate.title,
      what_changed: candidate.what_changed,
      why_flagged: candidate.why_flagged,
      metrics: candidate.metrics,
    }, null, 2),
    '',
    'Polymarket-native context:',
    JSON.stringify(compactContext(context), null, 2),
    '',
    'Current research brief:',
    JSON.stringify(brief, null, 2),
    '',
    'Current retrieval report excerpt:',
    JSON.stringify({
      ...last30DaysReportExcerpt(report),
      diagnostics: { stderr: stderr.slice(0, 1200) },
    }, null, 2),
  ].join('\n')
}

async function runHermesRetrievalReflection(
  context: PolymarketNativeContext,
  candidate: PendingCandidate,
  brief: ResearchBrief,
  report: Record<string, unknown>,
  stderr: string,
  options: Required<PolymarketResearcherOptions>
): Promise<RetrievalReflection> {
  const prompt = buildRetrievalReflectionPrompt(context, candidate, brief, report, stderr)
  try {
    const { value } = await options.hermes.structured<Partial<RetrievalReflection>>({
      purpose: 'polymarket.researcher.reflection',
      prompt,
      timeoutMs: options.researchPlannerHermesTimeoutMs,
      toolsets: options.researchPlannerHermesToolsets || undefined,
      ignoreRules: options.researchPlannerHermesIgnoreRules,
      commandOverride: options.hermesCommand,
    })
    return normalizeRetrievalReflection(value, brief)
  } catch {
    return normalizeRetrievalReflection(null, brief)
  }
}

function briefFromRetrievalReflection(prior: ResearchBrief, reflection: RetrievalReflection): ResearchBrief {
  return {
    research_goal: prior.research_goal,
    last30days_topic: reflection.next_last30days_topic,
    lookback_days: prior.lookback_days,
    search_sources: reflection.next_search_sources,
    subreddits: reflection.next_subreddits,
    polymarket_keywords: reflection.next_polymarket_keywords,
    last30days_plan: {
      intent: prior.last30days_plan.intent,
      freshness_mode: prior.last30days_plan.freshness_mode,
      cluster_mode: prior.last30days_plan.cluster_mode,
      subqueries: reflection.next_subqueries,
    },
    evidence_to_collect: prior.evidence_to_collect,
    expected_entities: prior.expected_entities,
    notes: [prior.notes, reflection.notes].filter(Boolean).join(' Retrieval adjustment: '),
  }
}

function researchModeForCandidate(candidate: PendingCandidate): string {
  const text = [candidate.slug, candidate.title, candidate.tag_slug, candidate.tag_label].filter(Boolean).join(' ').toLowerCase()
  if (/\bfed\b|\bfomc\b|federal reserve|interest rate|rates?|bps|basis point|inflation|cpi|jobs|powell|bitcoin|ethereum|crypto/.test(text)) return 'macro_crypto'
  if (/\belection\b|\bresign|\bprime minister\b|\bparliament\b|\bgovernment\b|\bstarmer\b|\blabou?r\b/.test(text)) return 'political_churn'
  if (/\boil\b|\bgold\b|\benergy\b|\bwar\b|\bceasefire\b|\bgeopolitical\b/.test(text)) return 'geopolitical_risk'
  if (/\bearnings\b|\bcompany\b|\bceo\b|\bbusiness\b/.test(text)) return 'business_event'
  return 'other'
}

function rankedCandidates(report: Record<string, unknown>, limit: number): Record<string, unknown>[] {
  return asArray(report.ranked_candidates)
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .slice(0, limit)
}

function evidenceLinksFromLast30Days(report: Record<string, unknown>): Array<{ title: string, url: string, note: string, source?: string }> {
  const seen = new Set<string>()
  return rankedCandidates(report, 12).flatMap((item) => {
    const title = asString(item.title, 'Research evidence')
    const url = asString(item.url)
    if (!url || seen.has(url)) return []
    seen.add(url)
    return [{
      title,
      url,
      note: [asString(item.source), asString(item.snippet), asString(item.explanation)].filter(Boolean).join(' - '),
      source: asString(item.source) || undefined,
    }]
  })
}

function sourceCounts(report: Record<string, unknown>): Record<string, number> {
  if (!report.items_by_source || typeof report.items_by_source !== 'object') return {}
  return Object.fromEntries(
    Object.entries(report.items_by_source as Record<string, unknown>)
      .map(([source, rows]) => [source, Array.isArray(rows) ? rows.length : 0])
  )
}

function boundedMetadata(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  const metadata = value as Record<string, unknown>
  const allowed = [
    'author',
    'comment_count',
    'comments',
    'end_date',
    'num_comments',
    'outcome_prices',
    'outcomes_remaining',
    'published_at',
    'provenance',
    'question',
    'score',
    'subreddit',
  ]
  return Object.fromEntries(
    allowed
      .filter((key) => key in metadata)
      .map((key) => [key, metadata[key]])
  )
}

function boundedSourceItems(item: Record<string, unknown>, limit = 3): unknown[] {
  return asArray(item.source_items)
    .filter((sourceItem): sourceItem is Record<string, unknown> => Boolean(sourceItem && typeof sourceItem === 'object'))
    .slice(0, limit)
    .map((sourceItem) => ({
      title: sourceItem.title,
      url: sourceItem.url,
      source: sourceItem.source,
      container: sourceItem.container,
      published_at: sourceItem.published_at,
      engagement: sourceItem.engagement,
      snippet: sourceItem.snippet,
      metadata: boundedMetadata(sourceItem.metadata),
      why_relevant: sourceItem.why_relevant,
    }))
}

function boundedRankedCandidate(item: Record<string, unknown>): Record<string, unknown> {
  return {
    title: item.title,
    url: item.url,
    source: item.source,
    snippet: item.snippet,
    explanation: item.explanation,
    final_score: item.final_score,
    freshness: item.freshness,
    engagement: item.engagement,
    local_relevance: item.local_relevance,
    subquery_labels: item.subquery_labels,
    metadata: item.metadata,
    source_items: boundedSourceItems(item),
  }
}

function boundedClusters(report: Record<string, unknown>, limit = 5): unknown[] {
  return asArray(report.clusters)
    .filter((cluster): cluster is Record<string, unknown> => Boolean(cluster && typeof cluster === 'object'))
    .slice(0, limit)
    .map((cluster) => ({
      cluster_id: cluster.cluster_id,
      title: cluster.title,
      score: cluster.score,
      sources: cluster.sources,
      uncertainty: cluster.uncertainty,
      candidate_ids: cluster.candidate_ids,
      representative_ids: cluster.representative_ids,
    }))
}

function last30DaysReportExcerpt(report: Record<string, unknown>): Record<string, unknown> {
  return {
    topic: report.topic,
    generated_at: report.generated_at,
    range_from: report.range_from,
    range_to: report.range_to,
    query_plan: report.query_plan,
    provider_runtime: report.provider_runtime,
    source_counts: sourceCounts(report),
    warnings: report.warnings,
    errors_by_source: report.errors_by_source,
    artifacts: report.artifacts,
    clusters: boundedClusters(report),
    ranked_candidates: rankedCandidates(report, 8).map(boundedRankedCandidate),
  }
}

function last30DaysToResearchResult(
  decision: EnrichedTriageDecision,
  planner: PlannerResult,
  brief: ResearchBrief,
  report: Record<string, unknown>,
  stderr: string,
  args: string[]
): HermesResearchResult {
  const candidate = decision.candidate
  const context = decision.polymarketNativeContext
  const evidenceLinks = evidenceLinksFromLast30Days(report)
  const ranked = rankedCandidates(report, 12)
  const findings = ranked.map((item, index) => [
    `${index + 1}. ${asString(item.title, 'Retrieved item')}`,
    asString(item.source) ? `source=${asString(item.source)}` : '',
    asString(item.url) ? `url=${asString(item.url)}` : '',
    asString(item.snippet) ? `snippet=${asString(item.snippet).slice(0, 240)}` : '',
  ].filter(Boolean).join(' | '))
  const warnings = asArray(report.warnings).map(String)
  const errorsBySource = report.errors_by_source && typeof report.errors_by_source === 'object'
    ? Object.entries(report.errors_by_source as Record<string, unknown>).map(([source, error]) => `${source}: ${String(error)}`)
    : []
  const retrievalDiagnostics = [...warnings, ...errorsBySource].filter(Boolean)

  return {
    candidate_id: candidate.id,
    research_mode: researchModeForCandidate(candidate),
    market_about: context?.market.title ?? candidate.title,
    resolution_rules: {
      condition: context?.market.description ?? null,
      deadline: context?.market.end_date ?? null,
      resolution_source: context?.market.resolution_source ?? null,
      rule_notes: context?.source_native_questions ?? sourceNativeFallbackQuestions(candidate),
    },
    polymarket_context: context ? {
      source_native_context: compactContext(context),
      market_structure_summary: context.market_structure,
      parent_event_summary: context.parent_event,
      source_native_findings: planner.plan.known_from_polymarket,
      source_native_do_not_research: planner.plan.do_not_research,
    } : null,
    external_research: {
      needed: true,
      why: brief.research_goal,
      questions: brief.last30days_plan.subqueries.map((query) => query.ranking_query),
      sources_checked: evidenceLinks,
      retrieval_diagnostics: retrievalDiagnostics,
      last30days_topic: brief.last30days_topic,
      last30days_sources: brief.search_sources,
      source_counts: sourceCounts(report),
      ranked_candidate_count: ranked.length,
      command_args: args,
      diagnostics: {
        stderr: stderr ? stderr.slice(0, 2000) : null,
      },
      planner_error: planner.error,
      planner_expected_entities: brief.expected_entities,
    },
    verified_facts: [],
    unverified_claims: [],
    entities_mentioned: [],
    claims_found: findings,
    relationships_found: [],
    open_questions: [],
    research_completeness: 'not_assessed',
    summary: `Collected ${evidenceLinks.length} link(s) and ${ranked.length} ranked item(s) for: ${brief.research_goal}`,
    notes: [
      `Research brief: ${brief.research_goal}`,
      `Planner notes: ${brief.notes}`,
      `Evidence to collect: ${brief.evidence_to_collect.join('; ')}`,
      `Subqueries: ${brief.last30days_plan.subqueries.map((query) => `${query.label}: ${query.search_query}`).join(' | ')}`,
      planner.error ? `Planner fallback/error: ${planner.error}` : '',
    ].filter(Boolean).join('\n'),
    key_findings: findings,
    evidence_links: evidenceLinks,
    related_context: [
      { kind: 'reflection_research_brief', ...brief },
      { kind: 'polymarket_source_native_context', context: context ? compactContext(context) : null },
      { kind: 'last30days_report_excerpt', ...last30DaysReportExcerpt(report) },
      {
        kind: 'schema_compatibility_placeholders',
        evidence_quality: 'medium',
        catalyst_found: false,
        recommended_editor_action: 'needs_more_research',
        note: 'These values satisfy the current research table schema and are not researcher judgments.',
      },
    ],
    uncertainty: 'Retrieval-only packet. Entity Manager should interpret the collected context and links.',
    editor_notes: 'Research packet only. Entity Manager should extract entities/evidence before any feed/editor decision.',
    evidence_quality: 'medium',
    catalyst_found: false,
    recommended_editor_action: 'needs_more_research',
  }
}

function normalizeResearchResult(result: HermesResearchResult): HermesResearchResult {
  const verifiedFacts = asArray(result.verified_facts)
  const openQuestions = asArray(result.open_questions)
  const keyFindings = asArray(result.key_findings)
  const relatedContext = asArray(result.related_context)
  const packet = researchPacketForResult(result)
  return {
    candidate_id: asString(result.candidate_id),
    research_mode: asString(result.research_mode, 'market_structure'),
    market_about: result.market_about,
    resolution_rules: result.resolution_rules,
    polymarket_context: result.polymarket_context,
    external_research: result.external_research,
    verified_facts: verifiedFacts,
    unverified_claims: asArray(result.unverified_claims),
    entities_mentioned: asArray(result.entities_mentioned),
    claims_found: asArray(result.claims_found),
    relationships_found: asArray(result.relationships_found),
    open_questions: openQuestions,
    research_completeness: asString(result.research_completeness, 'partial'),
    summary: asString(result.summary),
    notes: asString(result.notes),
    key_findings: keyFindings.length > 0 ? keyFindings : verifiedFacts,
    evidence_links: asArray(result.evidence_links),
    related_context: [packet, ...relatedContext],
    uncertainty: asString(result.uncertainty),
    editor_notes: asString(result.editor_notes) || [
      openQuestions.length > 0 ? `Open questions: ${openQuestions.map(String).join('; ')}` : '',
      asString(result.uncertainty),
    ].filter(Boolean).join('\n'),
    evidence_quality: compatibilityEvidenceQuality(result.evidence_quality ?? result.research_completeness),
    catalyst_found: asBoolean(result.catalyst_found),
    recommended_editor_action: normalizeRecommendedEditorAction(result.recommended_editor_action),
  }
}

function buildEngineTask(decision: EnrichedTriageDecision): ResearchTask {
  const candidate = decision.candidate
  const entityContext = decision.entityContext ?? null
  const newest = entityContext?.recentMemories[0]
  // Diff question when the gate resolved a timeline: research targets what
  // happened AFTER our newest entry, not the story from scratch. This is the
  // entire point of consulting entity memory before researching.
  const question = newest
    ? `Our knowledge timeline for this subject ends at ${newest.eventAt} with: "${newest.summary}". Since then this market signal arrived: ${candidate.what_changed} What happened after ${newest.eventAt} that explains it?`
    : `${candidate.what_changed} What concrete recent development could explain this for the market "${candidate.title}"?`

  return {
    taskId: `polymarket:markets:${candidate.id}`,
    source: 'polymarket',
    subject: entityContext && entityContext.entities.length > 0
      ? entityContext.entities.map((entity) => entity.slug).join(', ')
      : candidate.slug,
    title: candidate.title,
    question,
    signal: candidate.what_changed,
    observedAt: candidate.observed_at,
    known: entityContext,
    sourceContext: decision.polymarketNativeContext ? compactContext(decision.polymarketNativeContext) : null,
    answerSpec: {
      kind: 'catalyst',
      instruction: 'An answer is a concrete, dated, verifiable catalyst - an event, data release, official statement, filing, or credible report - that plausibly explains why traders repriced this market. Polymarket odds movement itself is not a catalyst.',
    },
  }
}

function engineConclusionToResearchResult(
  decision: EnrichedTriageDecision,
  conclusion: ResearchConclusion
): HermesResearchResult {
  const candidate = decision.candidate
  const context = decision.polymarketNativeContext
  const outcome = conclusion.outcome as 'answered' | 'nothing_found' | 'partial'
  // Outcome-derived, mechanical mappings - not researcher judgment calls:
  // 'answered' means a verified catalyst exists (catalyst_found is factual),
  // and the editor recommendation follows the outcome one-to-one.
  const recommendedEditorAction: RecommendedEditorAction = outcome === 'answered'
    ? 'publish_candidate'
    : outcome === 'nothing_found' ? 'reject_thin' : 'needs_more_research'

  const result: HermesResearchResult = {
    candidate_id: candidate.id,
    research_mode: researchModeForCandidate(candidate),
    market_about: context?.market.title ?? candidate.title,
    resolution_rules: {
      condition: context?.market.description ?? null,
      deadline: context?.market.end_date ?? null,
      resolution_source: context?.market.resolution_source ?? null,
      rule_notes: context?.source_native_questions ?? sourceNativeFallbackQuestions(candidate),
    },
    polymarket_context: context ? { source_native_context: compactContext(context) } : null,
    external_research: {
      needed: true,
      why: conclusion.whatChanged || conclusion.summary,
      sources_checked: conclusion.checked,
      engine_outcome: outcome,
      engine_duration_ms: conclusion.durationMs,
    },
    verified_facts: conclusion.verifiedFacts.map((fact) => fact.fact),
    unverified_claims: conclusion.unverifiedClaims,
    entities_mentioned: [],
    claims_found: [],
    relationships_found: [],
    open_questions: conclusion.openQuestions,
    research_completeness: outcome === 'answered' ? 'complete' : 'partial',
    summary: conclusion.summary,
    notes: [
      `Research engine outcome: ${outcome}.`,
      conclusion.whatChanged ? `What changed: ${conclusion.whatChanged}` : '',
      conclusion.checked.length > 0 ? `Checked: ${conclusion.checked.join('; ')}` : '',
      conclusion.unverifiedClaims.length > 0 ? `Unverified claims: ${conclusion.unverifiedClaims.join('; ')}` : '',
    ].filter(Boolean).join('\n'),
    key_findings: conclusion.verifiedFacts.map((fact) => fact.fact),
    evidence_links: conclusion.evidenceLinks,
    related_context: [
      {
        kind: 'research_engine_conclusion',
        outcome,
        what_changed: conclusion.whatChanged,
        checked: conclusion.checked,
        duration_ms: conclusion.durationMs,
        verified_facts: conclusion.verifiedFacts,
      },
      { kind: 'polymarket_source_native_context', context: context ? compactContext(context) : null },
    ],
    uncertainty: conclusion.openQuestions.length > 0
      ? `Open questions: ${conclusion.openQuestions.join('; ')}`
      : (outcome === 'partial' ? 'Partial conclusion - see unverified claims.' : ''),
    editor_notes: outcome === 'answered'
      ? `Verified catalyst research. ${conclusion.whatChanged}`.trim()
      : `Engine outcome ${outcome}. ${conclusion.summary}`.trim(),
    evidence_quality: outcome === 'answered' ? 'medium' : 'weak',
    catalyst_found: outcome === 'answered',
    recommended_editor_action: recommendedEditorAction,
    engine_outcome: outcome,
  }
  return { ...result, related_context: [researchPacketForResult(result), ...result.related_context] }
}

async function researchSingleCandidate(
  decision: EnrichedTriageDecision,
  options: Required<PolymarketResearcherOptions>,
  reason: string
): Promise<{ result?: HermesResearchResult, failure?: ResearchFailure }> {
  try {
    if (!decision.polymarketNativeContext) {
      return {
        failure: {
          candidate: decision.candidate,
          error: `Polymarket native context unavailable before ${reason}: ${decision.polymarketNativeContextError ?? 'unknown error'}`,
        },
      }
    }

    // Engine path: one read-and-conclude agent run replaces the legacy
    // planner -> last30days -> reflection retrieval pipeline entirely.
    // engine_failed routes to the existing failure/retry lane.
    if (options.engine) {
      const conclusion = await options.engine.research(buildEngineTask(decision))
      if (conclusion.outcome === 'engine_failed') {
        return {
          failure: {
            candidate: decision.candidate,
            error: conclusion.summary || 'Research engine run failed.',
          },
        }
      }
      return { result: engineConclusionToResearchResult(decision, conclusion) }
    }

    const planner = await runHermesPlanner(decision.polymarketNativeContext, decision.candidate, options, decision.entityContext)
    let brief = buildResearchBrief(planner.plan)
    let research = await runLast30Days(brief, options)

    for (let pass = 1; pass < MAX_RETRIEVAL_PASSES; pass += 1) {
      const reflection = await runHermesRetrievalReflection(
        decision.polymarketNativeContext,
        decision.candidate,
        brief,
        research.report,
        research.stderr,
        options
      )
      if (!reflection.search_again) break
      brief = briefFromRetrievalReflection(brief, reflection)
      research = await runLast30Days(brief, options)
    }

    const result = normalizeResearchResult(last30DaysToResearchResult(
      decision,
      planner,
      brief,
      research.report,
      research.stderr,
      research.args
    ))
    return { result }
  } catch (error) {
    return {
      failure: {
        candidate: decision.candidate,
        error: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

async function researchCandidatesWithFallback(
  decisions: EnrichedTriageDecision[],
  options: Required<PolymarketResearcherOptions>,
  store: PipelineStore,
  outstandingLeaseIds: Set<string>
): Promise<ResearchAttempt> {
  const results = new Map<string, HermesResearchResult>()
  const failures: ResearchFailure[] = []

  for (const decision of decisions) {
    const attempt = await researchSingleCandidate(decision, options, 'reflection research')
    if (attempt.result) results.set(decision.candidate.id, attempt.result)
    if (attempt.failure) failures.push(attempt.failure)

    // Lease renewal for long work (see DEFAULT_LEASE_SECONDS): this candidate
    // is about to get a terminal status written outside this loop, so it no
    // longer needs its lease renewed. Everything else still outstanding in
    // the batch does, since a single deep_web candidate can take ~11 minutes
    // and their individual leases must not expire while this loop is still
    // working through the rest of the batch.
    outstandingLeaseIds.delete(decision.candidate.id)
    await renewOutstandingLeases(store, [...outstandingLeaseIds], options)
  }

  return { results, failures }
}

function toResearchUpsertInput(row: ResearchRowInput): PipelineResearchUpsertInput {
  return {
    candidateId: row.candidate_id,
    source: row.source,
    area: row.area,
    slug: row.slug,
    title: row.title,
    candidateType: row.candidate_type,
    researchMode: row.research_mode,
    summary: row.summary,
    notes: row.notes,
    keyFindings: row.key_findings,
    evidenceLinks: row.evidence_links,
    relatedContext: row.related_context,
    uncertainty: row.uncertainty,
    editorNotes: row.editor_notes,
    status: row.status,
    researchedAt: row.researched_at,
    researchFamilyKey: row.research_family_key,
    researchClusterKey: row.research_cluster_key,
    researchDepth: row.research_depth,
    evidenceQuality: row.evidence_quality,
    catalystFound: row.catalyst_found,
    recommendedEditorAction: row.recommended_editor_action,
    duplicateOfResearchId: row.duplicate_of_research_id,
    researchBackend: row.research_backend,
    researchModel: row.research_model,
  }
}

/**
 * Upserts research rows and returns the CANDIDATE ids that were actually
 * persisted (not research row ids - callers of this function historically
 * treat its return value as candidate ids, e.g. to feed
 * updateSuccessfulCandidates and the failure-classification filter below).
 *
 * This used to fake success by echoing `rows.map(r => r.candidate_id)`
 * regardless of what was actually written (the exact bug the migration brief
 * flagged). store.upsertResearchRows returns the REAL persisted research row
 * ids, so this reads those rows back via getResearchByIds and reports the
 * candidateId of each one that truly exists - a row that silently failed to
 * persist no longer shows up here as a false success.
 */
async function insertResearchRows(
  store: PipelineStore,
  rows: ResearchRowInput[]
): Promise<string[]> {
  if (rows.length === 0) return []

  const persistedResearchIds = await store.upsertResearchRows(rows.map(toResearchUpsertInput))
  if (persistedResearchIds.length === 0) return []

  const persistedRows = await store.getResearchByIds(persistedResearchIds)
  return persistedRows.map((row) => row.candidateId)
}

function buildHermesResearchRows(
  decisions: TriageDecision[],
  results: Map<string, HermesResearchResult>,
  observedAt: string,
  options: Required<PolymarketResearcherOptions>
): ResearchRowInput[] {
  return decisions.flatMap((decision) => {
    const candidate = decision.candidate
    const result = results.get(candidate.id)
    if (!result) return []
    return [{
      candidate_id: candidate.id,
      source: candidate.source,
      area: candidate.area,
      slug: candidate.slug,
      title: candidate.title,
      candidate_type: candidate.candidate_type,
      research_mode: result.research_mode,
      summary: result.summary,
      notes: result.notes,
      key_findings: result.key_findings,
      evidence_links: result.evidence_links,
      related_context: result.related_context,
      uncertainty: result.uncertainty,
      editor_notes: result.editor_notes,
      status: result.engine_outcome === 'nothing_found' ? 'rejected' : 'pending_editor',
      researched_at: observedAt,
      updated_at: observedAt,
      research_family_key: decision.familyKey,
      research_cluster_key: decision.clusterKey,
      research_depth: 'deep_web',
      evidence_quality: normalizeEvidenceQuality(result.evidence_quality),
      catalyst_found: asBoolean(result.catalyst_found),
      recommended_editor_action: normalizeRecommendedEditorAction(result.recommended_editor_action),
      duplicate_of_research_id: null,
      research_backend: result.engine_outcome ? 'research_engine' : options.backend,
      research_model: options.researchModel,
    }]
  })
}

async function enrichTriageWithPolymarketContext(decisions: TriageDecision[]): Promise<EnrichedTriageDecision[]> {
  return Promise.all(decisions.map(async (decision) => {
    try {
      return {
        ...decision,
        polymarketNativeContext: await fetchPolymarketNativeContext(decision.candidate.slug),
      }
    } catch (error) {
      return {
        ...decision,
        polymarketNativeContextError: error instanceof Error ? error.message : String(error),
      }
    }
  }))
}

async function researchDeepWebCandidates(
  decisions: TriageDecision[],
  _priorResearch: { bySlug: Map<string, PriorResearch[]> },
  options: Required<PolymarketResearcherOptions>,
  store: PipelineStore
): Promise<ResearchAttempt> {
  const results = new Map<string, HermesResearchResult>()
  const failures: ResearchFailure[] = []
  const enrichedDecisions = await enrichTriageWithPolymarketContext(decisions)
  const byCluster = new Map<string, EnrichedTriageDecision[]>()
  for (const decision of enrichedDecisions) {
    const cluster = byCluster.get(decision.clusterKey) ?? []
    cluster.push(decision)
    byCluster.set(decision.clusterKey, cluster)
  }

  // All deep_web candidates' leases start outstanding; researchCandidatesWithFallback
  // removes each one as its research finishes and renews everything still left,
  // across cluster group boundaries too (a single shared set, not reset per group).
  const outstandingLeaseIds = new Set(decisions.map((decision) => decision.candidate.id))
  const grouped = [...byCluster.values()].sort((a, b) => b.length - a.length)
  for (const group of grouped) {
    const attempt = await researchCandidatesWithFallback(group, options, store, outstandingLeaseIds)
    for (const [id, result] of attempt.results) results.set(id, result)
    failures.push(...attempt.failures)
  }
  return { results, failures }
}

// N+1 elimination: this used to issue one Supabase UPDATE per decision in a
// sequential loop. updateCandidateThreads takes the whole batch and writes it
// in a single store transaction.
//
// This no longer flips status (BUG 1 fix): the status='researching' flip and
// its lease now happen earlier, atomically, inside claimResearchCandidates'
// claimWithLease call - before triage even runs. This function only attaches
// the triage OUTCOME (family/cluster/depth) to rows that are already safely
// claimed and leased. If this step never runs because of a crash, the row is
// still safely 'researching' with a live lease that will either get renewed
// (see renewOutstandingLeases) or expire and become reclaimable
// (recoverExpiredLeases) - it is never stranded, unlike the old
// claimCandidatesForResearch flip this replaced (that store method has since
// been removed as dead code - nothing called it once this landed).
async function recordTriageOutcome(
  store: PipelineStore,
  decisions: TriageDecision[]
): Promise<void> {
  await store.updateCandidateThreads(
    decisions.map((decision) => ({
      id: decision.candidate.id,
      payload: {
        researchFamilyKey: decision.familyKey,
        researchClusterKey: decision.clusterKey,
        researchDepth: decision.depth,
      },
    }))
  )
}

/**
 * Keeps the leases of not-yet-finished candidates in this batch fresh while
 * a long sequential research run is in progress (lease-renewal decision -
 * see DEFAULT_LEASE_SECONDS above).
 *
 * Candidates are researched sequentially within a batch
 * (researchCandidatesWithFallback's `for` loop), and a deep_web candidate can
 * take ~11 minutes. Rather than sizing one lease for the whole batch's
 * worst-case sequential runtime, each claim gets a lease sized for ONE
 * candidate and this function pushes every STILL-OUTSTANDING claim's expiry
 * back out after each candidate finishes, so items later in the batch don't
 * have their lease expire - and get silently reclaimed and double-researched
 * by another worker - just because earlier items in the same batch took a
 * while.
 */
async function renewOutstandingLeases(
  store: PipelineStore,
  ids: string[],
  options: Required<PolymarketResearcherOptions>
): Promise<void> {
  if (ids.length === 0) return
  await store.renewLease(ids, options.leaseOwner, options.leaseSeconds, new Date().toISOString())
}

export async function runPolymarketResearcher(
  store: PipelineStore,
  db: SupabaseClient,
  partialOptions: PolymarketResearcherOptions = {}
): Promise<PolymarketResearcherResult> {
  const options = selectedOptions(partialOptions)
  const observedAt = options.now
  const nowMs = new Date(observedAt).getTime()

  // Recovery pass (BUG 1 fix): reclaim any 'researching' row whose lease
  // expired since the last run - a worker that crashed, was killed, or a box
  // that rebooted mid-research. Run first, before this run claims anything
  // new, so recovered rows are immediately eligible for THIS run's claim.
  await store.recoverExpiredLeases({ stage: RESEARCH_STAGE, now: observedAt })

  // Aging pass (BUG 2 fix): candidates older than maxCandidateAgeHours used
  // to be silently excluded from every fetch by an `observed_at` filter and
  // sit in 'pending_research' forever - not failed, not retried, invisible.
  // expireAgedWork WRITES the terminal 'stale_expired' status instead, so
  // aged-out work becomes a countable, queryable outcome. The fetch itself
  // (claimResearchCandidates) no longer filters on age at all.
  const ageCutoff = candidateAgeCutoff(options)
  if (ageCutoff) {
    await store.expireAgedWork({ stage: RESEARCH_STAGE, olderThan: ageCutoff, now: observedAt })
  }

  const { candidates, retriedCandidateIds } = await claimResearchCandidates(store, options)
  const familyKeys = [...new Set(candidates.map(primaryFamilyKey))]
  const priorResearch = await fetchRecentResearch(store, [...new Set(candidates.map((candidate) => candidate.slug))], familyKeys)
  const triage = triageCandidates(candidates, priorResearch, nowMs, options)

  if (triage.length === 0) {
    return {
      observedAt,
      backend: options.backend,
      pendingFetched: candidates.length,
      eligibleForResearch: 0,
      skippedRecentlyResearched: 0,
      retriedFailedCandidates: retriedCandidateIds.length,
      reusedPriorResearch: 0,
      marketStructureOnly: 0,
      deepWebResearched: 0,
      nothingFound: 0,
      researchRowsWritten: 0,
      candidatesMarkedResearched: 0,
      candidatesMarkedFailed: 0,
      researched: [],
      skipped: [],
      failed: [],
    }
  }

  // No status flip here (BUG 1 fix): claimResearchCandidates already claimed
  // and leased every row above, atomically, before triage even ran. This only
  // attaches the triage outcome (family/cluster/depth) to already-safe rows.
  await recordTriageOutcome(store, triage)

  const reuseRows = triage
    .filter((decision) => decision.depth === 'reuse_prior')
    .map((decision) => buildReusePriorRow(decision, observedAt, options))
  const structureRows = triage
    .filter((decision) => decision.depth === 'market_structure_only')
    .map((decision) => buildMarketStructureRow(decision, observedAt, options))
  const deepDecisions = triage.filter((decision) => decision.depth === 'deep_web')

  // Pre-research entity gate: check deep_web candidates against entity
  // memory BEFORE paying for research. Runs after recordTriageOutcome (the
  // triage record is still true - the candidate WAS classified deep_web) and
  // before native-context enrichment, so gated-out candidates cost zero
  // Polymarket fetches, zero planner calls and zero retrieval passes.
  const gated = await gateDeepWebDecisions(deepDecisions, options)

  // Terminal-skip the already-known ones NOW, before deep research starts:
  // if the process dies mid-batch these are already safely terminal instead
  // of waiting on lease expiry to be re-gated by the next worker.
  // 'skipped_recently_researched' is the store's existing terminal skip
  // status (present in the sqlite CHECK constraint since the store landed,
  // designed for exactly this "we already have this knowledge" outcome).
  if (gated.known.length > 0) {
    await updateCandidateStatus(
      store,
      gated.known.map((entry) => entry.decision.candidate.id),
      'skipped_recently_researched',
      observedAt,
      null,
      { researchNextRetryAt: null, researchLastErrorKind: null }
    )
  }

  // The gate pass itself can take a while on a large batch (one cheap hermes
  // call per candidate with prior entities); push the survivors' lease
  // expiries back out before the long sequential research loop begins.
  await renewOutstandingLeases(store, gated.proceed.map((decision) => decision.candidate.id), options)

  // reuse_prior and market_structure_only decisions never enter the
  // sequential deep_web research loop, so their leases are held for the rest
  // of this (fast) synchronous run and released below once their terminal
  // status is written - they do not need mid-run renewal.
  const attempt = await researchDeepWebCandidates(gated.proceed, priorResearch, options, store)
  const hermesRows = buildHermesResearchRows(gated.proceed, attempt.results, observedAt, options)
  const allRows = [...reuseRows, ...structureRows, ...hermesRows]
  const successfulIds = await insertResearchRows(store, allRows)
  const failed = gated.proceed
    .map((decision) => decision.candidate)
    .filter((candidate) => !successfulIds.includes(candidate.id))
    .map((candidate) => attempt.failures.find((failure) => failure.candidate.id === candidate.id) ?? {
      candidate,
      error: 'Research reflection loop did not return a valid result for this candidate.',
    })

  await updateSuccessfulCandidates(store, successfulIds, observedAt)
  for (const failure of failed) {
    await updateFailedCandidate(store, failure, observedAt, options)
  }

  // Every claimed candidate now has a terminal status (researched or
  // research_failed) written above. Release their leases for hygiene -
  // claimability no longer depends on lease state once status is terminal,
  // but a released lease keeps pipeline_candidates free of stale
  // lease_owner/lease_expires_at values on rows that are done.
  await store.releaseLease(triage.map((decision) => decision.candidate.id), options.leaseOwner)

  return {
    observedAt,
    backend: options.backend,
    pendingFetched: candidates.length,
    eligibleForResearch: triage.length,
    skippedRecentlyResearched: gated.known.length,
    retriedFailedCandidates: retriedCandidateIds.length,
    reusedPriorResearch: reuseRows.length,
    marketStructureOnly: structureRows.length,
    deepWebResearched: hermesRows.length,
    nothingFound: hermesRows.filter((row) => row.status === 'rejected').length,
    researchRowsWritten: successfulIds.length,
    candidatesMarkedResearched: successfulIds.length,
    candidatesMarkedFailed: failed.length,
    researched: triage.flatMap((decision) => {
      const candidate = decision.candidate
      const row = allRows.find((item) => item.candidate_id === candidate.id)
      if (!row || !successfulIds.includes(candidate.id)) return []
      return [{
        candidateId: candidate.id,
        slug: candidate.slug,
        researchMode: row.research_mode,
        summary: row.summary,
      }]
    }),
    skipped: gated.known.map((entry) => ({
      candidateId: entry.decision.candidate.id,
      slug: entry.decision.candidate.slug,
      reason: `gate_already_known: ${entry.gate.reason}`,
    })),
    failed: failed.map((failure) => ({
      candidateId: failure.candidate.id,
      slug: failure.candidate.slug,
      error: failure.error,
    })),
  }
}

export const __testing = {
  buildEngineTask,
  buildHermesResearchRows,
  buildMarketStructureRow,
  buildPlannerPrompt,
  buildReusePriorRow,
  engineConclusionToResearchResult,
  candidateAgeCutoff,
  classifyResearchDepth,
  clusterKeyForCandidate,
  defaultLast30DaysScriptPath,
  errorKind,
  gateDeepWebDecisions,
  briefFromRetrievalReflection,
  last30DaysPlanPayload,
  last30DaysToResearchResult,
  normalizeReflectionPlan,
  normalizeRetrievalReflection,
  primaryFamilyKey,
  recentPrior,
  researchCandidatesWithFallback,
  retryCount,
  sanitizeLast30DaysSources,
  titleFamilyKey,
  triageCandidates,
}
