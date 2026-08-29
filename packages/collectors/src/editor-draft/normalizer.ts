import { createHash } from 'node:crypto'
import { extractJson } from '../hermes'
import type {
  AgentEditorDraftDecision,
  AgentEditorDraftResponse,
  EditorDraftAction,
  EditorDraftInput,
  EditorDraftStatus,
  EntityDraftBundle,
  EvidenceQuality,
  NormalizedEditorDraftDecision,
} from './types'

const ACTIONS = new Set<EditorDraftAction>([
  'draft_post',
  'watch',
  'skip_repetitive',
  'needs_more_research',
  'merge_with_existing_draft',
])

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

function unique(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const text = value.trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

function normalizeAction(value: unknown): EditorDraftAction {
  const action = asString(value).trim()
  return ACTIONS.has(action as EditorDraftAction) ? action as EditorDraftAction : 'needs_more_research'
}

export function statusForAction(action: EditorDraftAction): EditorDraftStatus {
  if (action === 'draft_post') return 'drafted'
  if (action === 'watch') return 'watching'
  if (action === 'skip_repetitive') return 'skipped'
  if (action === 'merge_with_existing_draft') return 'merged'
  return 'needs_more_research'
}

function normalizeEvidenceQuality(value: unknown): EvidenceQuality | null {
  const text = asString(value).toLowerCase().trim()
  if (text === 'strong' || text === 'medium' || text === 'weak') return text
  return null
}

function boundedNumber(value: unknown, min: number, max: number): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(parsed)) return null
  return Math.max(min, Math.min(max, parsed))
}

function boundedInteger(value: unknown, min: number, max: number): number | null {
  const bounded = boundedNumber(value, min, max)
  return bounded === null ? null : Math.round(bounded)
}

export function sourceMemoryHash(sourceMemoryIds: string[]): string {
  return createHash('sha256')
    .update(unique(sourceMemoryIds).sort().join('\n'))
    .digest('hex')
}

export function bundleKey(entityId: string, sourceMemoryIds: string[]): string {
  return `${entityId}:${sourceMemoryHash(sourceMemoryIds)}`
}

// Re-exported so existing importers keep working; the implementation now
// lives with the central Hermes service (src/hermes/json.ts).
export { extractJson }

export function parseAgentEditorDraftResponse(text: string): AgentEditorDraftResponse {
  const parsed = extractJson<AgentEditorDraftResponse>(text)
  if (!parsed || !Array.isArray(parsed.decisions)) {
    throw new Error('Editor draft agent returned invalid JSON.')
  }
  return parsed
}

export function normalizeEditorDraftDecision(
  decision: AgentEditorDraftDecision,
  bundle: EntityDraftBundle
): NormalizedEditorDraftDecision {
  const laneMemoryIds = new Set(bundle.memoryLane.map((memory) => memory.id))
  const newMemoryIds = bundle.newMemories.map((memory) => memory.id)
  const requestedIds = asStringArray(decision.source_memory_ids)
    .filter((id) => laneMemoryIds.has(id))
  const sourceMemoryIds = unique([...requestedIds, ...newMemoryIds])
  const hash = sourceMemoryHash(sourceMemoryIds)
  const action = normalizeAction(decision.action)
  const priorDraftIds = new Set(bundle.priorDrafts.map((draft) => draft.id))
  const mergeTargetDraftId = asNullableString(decision.merge_target_draft_id)
  const relatedDraftIds = asStringArray(decision.related_draft_ids)
    .filter((id) => priorDraftIds.has(id))

  return {
    action,
    status: statusForAction(action),
    sourceMemoryIds,
    sourceMemoryHash: hash,
    bundleKey: `${bundle.entity.id}:${hash}`,
    title: asNullableString(decision.title),
    angle: asNullableString(decision.angle),
    summary: asNullableString(decision.summary),
    body: asNullableString(decision.body),
    reasoning: asNullableString(decision.reasoning) ?? 'Editor draft agent did not provide reasoning.',
    reasonCodes: asStringArray(decision.reason_codes),
    evidenceQuality: normalizeEvidenceQuality(decision.evidence_quality),
    priority: boundedInteger(decision.priority, 0, 100),
    confidence: boundedNumber(decision.confidence, 0, 1),
    mergeTargetDraftId: mergeTargetDraftId && priorDraftIds.has(mergeTargetDraftId) ? mergeTargetDraftId : null,
    relatedDraftIds,
    followUpQuestions: asStringArray(decision.follow_up_questions),
    researchInstructions: asNullableString(decision.research_instructions),
  }
}

export function draftInputFromDecision(
  bundle: EntityDraftBundle,
  decision: NormalizedEditorDraftDecision,
  observedAt: string,
  backend: string,
  model: string | null
): EditorDraftInput {
  const sources = unique(bundle.newMemories.map((memory) => memory.source))
  const sourceAreas = unique(bundle.newMemories.map((memory) => memory.source_area))

  return {
    entity_id: bundle.entity.id,
    entity_slug: bundle.entity.slug,
    entity_name: bundle.entity.name,
    entity_type: bundle.entity.type,
    bundle_key: decision.bundleKey,
    source_memory_ids: decision.sourceMemoryIds,
    source_memory_hash: decision.sourceMemoryHash,
    source: sources.length === 1 ? sources[0] : null,
    source_area: sourceAreas.length === 1 ? sourceAreas[0] : null,
    action: decision.action,
    status: decision.status,
    title: decision.title,
    angle: decision.angle,
    summary: decision.summary,
    body: decision.body,
    reasoning: decision.reasoning,
    reason_codes: decision.reasonCodes,
    evidence_quality: decision.evidenceQuality,
    priority: decision.priority,
    confidence: decision.confidence,
    merge_target_draft_id: decision.mergeTargetDraftId,
    related_draft_ids: decision.relatedDraftIds,
    follow_up_questions: decision.followUpQuestions,
    research_instructions: decision.researchInstructions,
    backend,
    model,
    created_at: observedAt,
    updated_at: observedAt,
  }
}
