import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HermesService } from '../hermes'
import { createConfiguredInferenceGateway, type InferenceGateway } from '../inference-gateway'
import type { AgentEditorDraftDecision, AgentEditorDraftResponse, EditorDraftProvider, EntityDraftBundle } from './types'

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

export interface HermesEditorDraftProviderOptions {
  command?: string
  toolsets?: string
  timeoutMs?: number
  /** Injectable central Hermes service; built from `command` when omitted. */
  service?: HermesService
  /** Test/composition seam; production uses the centrally configured gateway. */
  gateway?: Pick<InferenceGateway, 'generateStructured'>
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
  private readonly timeoutMs: number
  private readonly gateway: Pick<InferenceGateway, 'generateStructured'>

  constructor(options: HermesEditorDraftProviderOptions = {}) {
    const toolsets = options.toolsets ?? process.env.EDITOR_DRAFT_HERMES_TOOLSETS ?? ''
    if (toolsets.trim()) throw new Error('Editor draft inference is tool-less; Hermes toolsets are forbidden')
    const envTimeout = Number(process.env.EDITOR_DRAFT_HERMES_TIMEOUT_MS)
    this.timeoutMs = options.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS)
    const service = options.service ?? new HermesService({
      command: options.command
        ?? process.env.EDITOR_DRAFT_HERMES_COMMAND
        ?? process.env.HERMES_COMMAND
        ?? 'hermes',
    })
    this.gateway = options.gateway ?? createConfiguredInferenceGateway({ serviceFactory: () => service }).gateway
  }

  async decide(bundle: EntityDraftBundle): Promise<AgentEditorDraftDecision> {
    const prompt = await buildHermesEditorDraftPrompt(bundle)
    const result = await this.gateway.generateStructured<AgentEditorDraftResponse>({
      workload: 'editor.draft', purpose: 'editor-draft.decide', prompt,
      promptVersion: 'editor.draft.prompt.v1', policyVersion: 'editor.draft.policy.v1',
      budget: {
        maxProviderCalls: 2, maxRepairCalls: 1, maxInputTokens: 100_000,
        maxOutputTokens: 20_000, maxWallTimeMs: this.timeoutMs, maxToolCalls: 0,
      },
      validate(value) {
        if (typeof value === 'object' && value !== null && Array.isArray((value as AgentEditorDraftResponse).decisions)) {
          return { valid: true, value: value as AgentEditorDraftResponse }
        }
        return { valid: false, issues: ['decisions must be an array'] }
      },
    })
    const decision = result.value.decisions[0]
    if (!decision) {
      throw new Error('Editor draft agent returned no decisions')
    }
    return decision
  }
}
