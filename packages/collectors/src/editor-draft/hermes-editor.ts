import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HermesService } from '../hermes'
import { parseAgentEditorDraftResponse } from './normalizer'
import type { AgentEditorDraftDecision, EditorDraftProvider, EntityDraftBundle } from './types'

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

export interface HermesEditorDraftProviderOptions {
  command?: string
  toolsets?: string
  timeoutMs?: number
  /** Injectable central Hermes service; built from `command` when omitted. */
  service?: HermesService
}

function memoryPayload(memory: EntityDraftBundle['memoryLane'][number]): Record<string, unknown> {
  return {
    id: memory.id,
    source: memory.source,
    source_area: memory.source_area,
    source_type: memory.source_type,
    source_ref_id: memory.source_ref_id,
    source_research_id: memory.source_research_id,
    memory_type: memory.memory_type,
    title: memory.title,
    summary: memory.summary,
    body: memory.body,
    event_at: memory.event_at,
    observed_at: memory.observed_at,
    confidence: memory.confidence,
    evidence: memory.evidence,
    mentions: memory.mentions,
    metrics: memory.metrics,
    context: memory.context,
  }
}

export async function buildHermesEditorDraftPrompt(bundle: EntityDraftBundle): Promise<string> {
  const stablePrompt = await readFile(join(__dirname, 'editor-prompt.md'), 'utf8')
  const newMemoryIds = new Set(bundle.newMemories.map((memory) => memory.id))
  const payload = {
    entity: {
      id: bundle.entity.id,
      slug: bundle.entity.slug,
      name: bundle.entity.name,
      type: bundle.entity.type,
      aliases: bundle.entity.aliases,
      summary: bundle.entity.summary,
      metadata: bundle.entity.metadata,
    },
    new_memories: bundle.newMemories.map(memoryPayload),
    prior_memory_lane: bundle.memoryLane
      .filter((memory) => !newMemoryIds.has(memory.id))
      .map(memoryPayload),
    prior_editor_drafts: bundle.priorDrafts.map((draft) => ({
      id: draft.id,
      source_memory_ids: draft.source_memory_ids,
      action: draft.action,
      status: draft.status,
      title: draft.title,
      angle: draft.angle,
      summary: draft.summary,
      reasoning: draft.reasoning,
      reason_codes: draft.reason_codes,
      created_at: draft.created_at,
    })),
    published_history: bundle.publishedHistory,
  }

  return [
    stablePrompt,
    '',
    '## Entity Bundle',
    JSON.stringify(payload, null, 2),
  ].join('\n')
}

export class HermesEditorDraftProvider implements EditorDraftProvider {
  private readonly toolsets: string
  private readonly timeoutMs: number
  private readonly service: HermesService

  constructor(options: HermesEditorDraftProviderOptions = {}) {
    this.toolsets = options.toolsets ?? process.env.EDITOR_DRAFT_HERMES_TOOLSETS ?? ''
    const envTimeout = Number(process.env.EDITOR_DRAFT_HERMES_TIMEOUT_MS)
    this.timeoutMs = options.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS)
    this.service = options.service ?? new HermesService({
      command: options.command
        ?? process.env.EDITOR_DRAFT_HERMES_COMMAND
        ?? process.env.HERMES_COMMAND
        ?? 'hermes',
    })
  }

  async decide(bundle: EntityDraftBundle): Promise<AgentEditorDraftDecision> {
    const prompt = await buildHermesEditorDraftPrompt(bundle)
    const { stdout, stderr } = await this.service.oneshot({
      purpose: 'editor-draft.decide',
      prompt,
      timeoutMs: this.timeoutMs,
      toolsets: this.toolsets || undefined,
    })

    const parsed = parseAgentEditorDraftResponse(stdout)
    const decision = parsed.decisions[0]
    if (!decision) {
      throw new Error(`Editor draft agent returned no decisions. stderr=${stderr.slice(0, 500)}`)
    }
    return decision
  }
}
