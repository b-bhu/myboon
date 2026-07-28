import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type {
  PipelineEditorDecision as EditorDecisionValue,
  PipelineEditorDecisionInsertInput,
  PipelineEditorDecisionInsertResult,
  PipelineEditorDecisionStatus as EditorDecisionStatus,
  PipelineEvidenceQuality as EvidenceQuality,
  PipelineResearchRow,
  PipelineResearchStatus as ResearchStatus,
  PipelineStore,
  PipelineTopicConfidence as TopicConfidence,
} from '../pipeline-store/store'

const execFileAsync = promisify(execFile)

const SOURCE = 'polymarket'
const AREA = 'markets'
const DEFAULT_EDITOR_TIMEOUT_MS = 10 * 60 * 1000

export interface PolymarketEditorOptions {
  now?: string
  batchSize?: number
  recentDecisionLimit?: number
  backend?: 'cli_agent'
  editorCommand?: string
  editorToolsets?: string
  editorTimeoutMs?: number
}

interface AgentEditorDecision {
  research_ids: unknown
  decision: string
  angle?: unknown
  why_this_matters?: unknown
  reasoning?: unknown
  reason_codes?: unknown
  evidence_quality?: unknown
  primary_topic?: unknown
  related_topics?: unknown
  topic_confidence?: unknown
  publisher_notes?: unknown
  follow_up_questions?: unknown
  research_instructions?: unknown
}

interface AgentEditorResponse {
  decisions: AgentEditorDecision[]
}

interface NormalizedEditorDecision {
  research_ids: string[]
  decision: EditorDecisionValue
  status: EditorDecisionStatus
  angle: string | null
  why_this_matters: string | null
  reasoning: string
  reason_codes: string[]
  evidence_quality: EvidenceQuality
  primary_topic: string | null
  related_topics: string[]
  topic_confidence: TopicConfidence | null
  publisher_notes: string | null
  follow_up_questions: string[]
  research_instructions: string | null
}

export interface PolymarketEditorResult {
  observedAt: string
  backend: string
  pendingFetched: number
  decisionsWritten: number
  researchRowsEdited: number
  researchRowsRejected: number
  researchRowsNeedsMoreResearch: number
  decisions: Array<{
    id: string
    decision: EditorDecisionValue
    status: EditorDecisionStatus
    researchIds: string[]
    angle: string | null
  }>
}

function envNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) ? parsed : fallback
}

function envString(name: string, fallback: string): string {
  const value = process.env[name]?.trim()
  return value ? value : fallback
}

function selectedBackend(partial?: 'cli_agent'): 'cli_agent' {
  const envBackend = process.env.POLYMARKET_EDITOR_BACKEND
  const backend = partial ?? envBackend ?? 'cli_agent'
  if (backend !== 'cli_agent') throw new Error(`Unsupported Polymarket editor backend: ${backend}`)
  return backend
}

function selectedOptions(partial: PolymarketEditorOptions): Required<PolymarketEditorOptions> {
  return {
    now: partial.now ?? new Date().toISOString(),
    batchSize: partial.batchSize ?? envNumber('POLYMARKET_EDITOR_BATCH_SIZE', 20),
    recentDecisionLimit: partial.recentDecisionLimit ?? envNumber('POLYMARKET_EDITOR_RECENT_DECISION_LIMIT', 30),
    backend: selectedBackend(partial.backend),
    editorCommand: partial.editorCommand ?? envString('POLYMARKET_EDITOR_COMMAND', 'hermes'),
    editorToolsets: partial.editorToolsets ?? envString('POLYMARKET_EDITOR_TOOLSETS', 'web'),
    editorTimeoutMs: partial.editorTimeoutMs ?? envNumber('POLYMARKET_EDITOR_TIMEOUT_MS', DEFAULT_EDITOR_TIMEOUT_MS),
  }
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNullableString(value: unknown): string | null {
  const text = asString(value).trim()
  return text ? text : null
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => asString(item).trim())
    .filter(Boolean)
}

function normalizeEvidenceQuality(value: unknown): EvidenceQuality {
  const normalized = asString(value).toLowerCase().trim()
  if (normalized === 'strong' || normalized === 'medium' || normalized === 'weak') return normalized
  return 'weak'
}

function normalizeTopicConfidence(value: unknown): TopicConfidence | null {
  const normalized = asString(value).toLowerCase().trim()
  if (normalized === 'high' || normalized === 'medium' || normalized === 'low') return normalized
  return null
}

function normalizeDecision(value: unknown): EditorDecisionValue {
  const normalized = asString(value).toLowerCase().trim()
  if (normalized === 'publish' || normalized === 'reject' || normalized === 'needs_more_research') return normalized
  return 'reject'
}

function statusForDecision(decision: EditorDecisionValue): EditorDecisionStatus {
  if (decision === 'publish') return 'pending_publisher'
  if (decision === 'needs_more_research') return 'needs_more_research'
  return 'rejected'
}

function researchStatusForDecision(decision: EditorDecisionValue): ResearchStatus {
  if (decision === 'publish') return 'edited'
  if (decision === 'needs_more_research') return 'needs_more_research'
  return 'rejected'
}

function extractJson<T>(text: string): T | null {
  const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  try {
    return JSON.parse(cleaned) as T
  } catch {
    // Continue into fragment extraction.
  }

  const start = cleaned.search(/[{[]/)
  if (start === -1) return null
  const opener = cleaned[start]
  const closer = opener === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escape = false
  for (let index = start; index < cleaned.length; index += 1) {
    const ch = cleaned[index]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\' && inString) {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === opener) depth += 1
    else if (ch === closer) depth -= 1
    if (depth === 0) {
      try {
        return JSON.parse(cleaned.slice(start, index + 1)) as T
      } catch {
        return null
      }
    }
  }
  return null
}

async function loadStablePrompt(): Promise<string> {
  return readFile(join(__dirname, 'editor-prompt.md'), 'utf8')
}

function buildEditorPrompt(researchRows: PipelineResearchRow[], recentDecisions: PipelineEditorDecisionRowLite[]): string {
  const payload = {
    research_rows: researchRows.map((row) => ({
      id: row.id,
      candidate_id: row.candidateId,
      slug: row.slug,
      title: row.title,
      candidate_type: row.candidateType,
      research_mode: row.researchMode,
      summary: row.summary,
      notes: row.notes,
      key_findings: row.keyFindings,
      evidence_links: row.evidenceLinks,
      uncertainty: row.uncertainty,
      researcher_editor_notes: row.editorNotes,
      researcher_metadata: {
        research_depth: row.researchDepth,
        evidence_quality: row.evidenceQuality,
        catalyst_found: row.catalystFound,
        recommended_editor_action: row.recommendedEditorAction,
        duplicate_of_research_id: row.duplicateOfResearchId,
        research_backend: row.researchBackend,
        research_model: row.researchModel,
      },
      researched_at: row.researchedAt,
    })),
    recent_editor_decisions: recentDecisions.map((decision) => ({
      id: decision.id,
      decision: decision.decision,
      status: decision.status,
      angle: decision.angle,
      why_this_matters: decision.whyThisMatters,
      reasoning: decision.reasoning,
      reason_codes: decision.reasonCodes,
      evidence_quality: decision.evidenceQuality,
      primary_topic: decision.primaryTopic,
      related_topics: decision.relatedTopics,
      research_ids: decision.researchIds,
      created_at: decision.createdAt,
    })),
  }

  return [
    '## Stable Instructions',
    '{{STABLE_PROMPT}}',
    '',
    '## Dynamic Editor Batch',
    'Review the following Polymarket research rows.',
    '',
    'Group rows when that produces a better editorial decision. Return one decision per group or standalone row.',
    '',
    'Return strict JSON in this exact shape:',
    JSON.stringify({
      decisions: [
        {
          research_ids: ['research uuid'],
          decision: 'publish | reject | needs_more_research',
          angle: 'editorial thesis for publisher, not final copy',
          why_this_matters: 'why this is useful now',
          reasoning: 'plain-language decision reasoning',
          reason_codes: ['open_ended_code'],
          evidence_quality: 'strong | medium | weak',
          primary_topic: 'topic or null',
          related_topics: ['topic'],
          topic_confidence: 'high | medium | low',
          publisher_notes: 'what publisher should preserve or avoid',
          follow_up_questions: [],
          research_instructions: '',
        },
      ],
    }, null, 2),
    '',
    'Batch payload:',
    JSON.stringify(payload, null, 2),
  ].join('\n')
}

async function runEditorAgent(prompt: string, options: Required<PolymarketEditorOptions>): Promise<AgentEditorResponse> {
  const stablePrompt = await loadStablePrompt()
  const fullPrompt = prompt.replace('{{STABLE_PROMPT}}', stablePrompt)
  const args = options.editorToolsets
    ? ['-t', options.editorToolsets, '-z', fullPrompt]
    : ['-z', fullPrompt]
  const { stdout, stderr } = await execFileAsync(
    options.editorCommand,
    args,
    {
      timeout: options.editorTimeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
    }
  )

  const parsed = extractJson<AgentEditorResponse>(stdout)
  if (!parsed || !Array.isArray(parsed.decisions)) {
    throw new Error(`Editor returned invalid JSON. stderr=${stderr.slice(0, 500)} stdout=${stdout.slice(0, 1000)}`)
  }

  return parsed
}

function normalizeEditorDecision(decision: AgentEditorDecision, validResearchIds: Set<string>): NormalizedEditorDecision | null {
  const researchIds = asStringArray(decision.research_ids)
    .filter((id, index, ids) => validResearchIds.has(id) && ids.indexOf(id) === index)
  if (researchIds.length === 0) return null

  const normalizedDecision = normalizeDecision(decision.decision)
  const reasoning = asString(decision.reasoning).trim()

  return {
    research_ids: researchIds,
    decision: normalizedDecision,
    status: statusForDecision(normalizedDecision),
    angle: asNullableString(decision.angle),
    why_this_matters: asNullableString(decision.why_this_matters),
    reasoning: reasoning || 'Editor did not provide detailed reasoning.',
    reason_codes: asStringArray(decision.reason_codes),
    evidence_quality: normalizeEvidenceQuality(decision.evidence_quality),
    primary_topic: asNullableString(decision.primary_topic),
    related_topics: asStringArray(decision.related_topics),
    topic_confidence: normalizeTopicConfidence(decision.topic_confidence),
    publisher_notes: asNullableString(decision.publisher_notes),
    follow_up_questions: asStringArray(decision.follow_up_questions),
    research_instructions: asNullableString(decision.research_instructions),
  }
}

function addFallbackDecisions(
  decisions: NormalizedEditorDecision[],
  pendingRows: PipelineResearchRow[]
): NormalizedEditorDecision[] {
  const covered = new Set(decisions.flatMap((decision) => decision.research_ids))
  const fallback = pendingRows
    .filter((row) => !covered.has(row.id))
    .map((row): NormalizedEditorDecision => ({
      research_ids: [row.id],
      decision: 'needs_more_research',
      status: 'needs_more_research',
      angle: null,
      why_this_matters: null,
      reasoning: 'Editor did not return a decision for this research row.',
      reason_codes: ['missing_editor_decision'],
      evidence_quality: 'weak',
      primary_topic: null,
      related_topics: [],
      topic_confidence: null,
      publisher_notes: null,
      follow_up_questions: ['Why was this row omitted from the editor decision batch?'],
      research_instructions: 'Review the omitted row and provide enough context for an editor decision.',
    }))

  return [...decisions, ...fallback]
}

function assignResearchRowsOnce(
  decisions: NormalizedEditorDecision[],
  pendingRows: PipelineResearchRow[]
): NormalizedEditorDecision[] {
  const assigned = new Set<string>()
  const unique = decisions.flatMap((decision) => {
    const researchIds = decision.research_ids.filter((id) => {
      if (assigned.has(id)) return false
      assigned.add(id)
      return true
    })
    if (researchIds.length === 0) return []
    return [{ ...decision, research_ids: researchIds }]
  })

  return addFallbackDecisions(unique, pendingRows)
}

interface PipelineEditorDecisionRowLite {
  id: string
  decision: EditorDecisionValue
  status: string
  angle: string | null
  whyThisMatters: string | null
  reasoning: string
  reasonCodes: unknown
  evidenceQuality: EvidenceQuality
  primaryTopic: string | null
  relatedTopics: unknown
  researchIds: string[]
  createdAt: string
}

async function insertEditorDecisions(
  store: PipelineStore,
  decisions: NormalizedEditorDecision[]
): Promise<PipelineEditorDecisionInsertResult[]> {
  if (decisions.length === 0) return []
  const rows: PipelineEditorDecisionInsertInput[] = decisions.map((decision) => ({
    source: SOURCE,
    area: AREA,
    researchIds: decision.research_ids,
    decision: decision.decision,
    status: decision.status,
    angle: decision.angle,
    whyThisMatters: decision.why_this_matters,
    reasoning: decision.reasoning,
    reasonCodes: decision.reason_codes,
    evidenceQuality: decision.evidence_quality,
    primaryTopic: decision.primary_topic,
    relatedTopics: decision.related_topics,
    topicConfidence: decision.topic_confidence,
    publisherNotes: decision.publisher_notes,
    followUpQuestions: decision.follow_up_questions,
    researchInstructions: decision.research_instructions,
  }))

  return store.insertEditorDecisions(rows)
}

/**
 * Batch-updates research row statuses for a batch of editor decisions in one
 * call per distinct target status, instead of one UPDATE per decision. Most
 * batches collapse to at most 3 statuses (edited/rejected/needs_more_research),
 * so this turns what used to be O(decisions) round trips into O(distinct
 * statuses) round trips.
 */
async function updateResearchRowsForDecisions(
  store: PipelineStore,
  decisions: NormalizedEditorDecision[],
  observedAt: string
): Promise<void> {
  const idsByStatus = new Map<ResearchStatus, string[]>()
  for (const decision of decisions) {
    const status = researchStatusForDecision(decision.decision)
    const ids = idsByStatus.get(status) ?? []
    ids.push(...decision.research_ids)
    idsByStatus.set(status, ids)
  }

  for (const [status, ids] of idsByStatus.entries()) {
    await store.setResearchStatus(ids, status, observedAt)
  }
}

export async function runPolymarketEditor(
  store: PipelineStore,
  partialOptions: PolymarketEditorOptions = {}
): Promise<PolymarketEditorResult> {
  const options = selectedOptions(partialOptions)
  const observedAt = options.now

  const pendingResearch = await store.fetchResearchByStatus({
    source: SOURCE,
    area: AREA,
    status: 'pending_editor',
    limit: options.batchSize,
  })
  if (pendingResearch.length === 0) {
    return {
      observedAt,
      backend: options.backend,
      pendingFetched: 0,
      decisionsWritten: 0,
      researchRowsEdited: 0,
      researchRowsRejected: 0,
      researchRowsNeedsMoreResearch: 0,
      decisions: [],
    }
  }

  const pendingIds = pendingResearch.map((row) => row.id)
  await store.setResearchStatus(pendingIds, 'editing', observedAt)

  let decisions: NormalizedEditorDecision[]
  let inserted: PipelineEditorDecisionInsertResult[]
  try {
    const recentDecisionRows = await store.findEditorDecisions({
      source: SOURCE,
      area: AREA,
      orderBy: 'desc',
      limit: options.recentDecisionLimit,
    })
    const recentDecisions: PipelineEditorDecisionRowLite[] = recentDecisionRows.map((row) => ({
      id: row.id,
      decision: row.decision,
      status: row.status,
      angle: row.angle,
      whyThisMatters: row.whyThisMatters,
      reasoning: row.reasoning,
      reasonCodes: row.reasonCodes,
      evidenceQuality: row.evidenceQuality,
      primaryTopic: row.primaryTopic,
      relatedTopics: row.relatedTopics,
      researchIds: row.researchIds,
      createdAt: row.createdAt,
    }))

    const response = await runEditorAgent(buildEditorPrompt(pendingResearch, recentDecisions), options)
    const validResearchIds = new Set(pendingResearch.map((row) => row.id))
    const normalized = response.decisions
      .map((decision) => normalizeEditorDecision(decision, validResearchIds))
      .filter((decision): decision is NormalizedEditorDecision => Boolean(decision))
    decisions = assignResearchRowsOnce(normalized, pendingResearch)
    inserted = await insertEditorDecisions(store, decisions)
    await updateResearchRowsForDecisions(store, decisions, observedAt)
  } catch (error) {
    // Non-atomic claim: `pendingIds` is exactly what this run fetched above,
    // so resetting them all to 'pending_editor' can clobber another run's
    // work only if a row here was independently re-claimed elsewhere between
    // our fetch and this catch, which the current fetch/claim design does not
    // prevent. Tracked as a known race - see PipelineStore's claimWithLease,
    // which does not yet cover research rows (candidates only).
    await store.setResearchStatus(pendingIds, 'pending_editor', observedAt)
    throw error
  }

  return {
    observedAt,
    backend: options.backend,
    pendingFetched: pendingResearch.length,
    decisionsWritten: inserted.length,
    researchRowsEdited: decisions
      .filter((decision) => decision.decision === 'publish')
      .reduce((total, decision) => total + decision.research_ids.length, 0),
    researchRowsRejected: decisions
      .filter((decision) => decision.decision === 'reject')
      .reduce((total, decision) => total + decision.research_ids.length, 0),
    researchRowsNeedsMoreResearch: decisions
      .filter((decision) => decision.decision === 'needs_more_research')
      .reduce((total, decision) => total + decision.research_ids.length, 0),
    decisions: inserted.map((decision) => ({
      id: decision.id,
      decision: decision.decision,
      status: decision.status,
      researchIds: decision.researchIds,
      angle: decision.angle,
    })),
  }
}
