import { HermesService } from '../hermes'
import type {
  EntityMemoryReader,
  GateDecision,
  GateEntityContext,
  GateSignal,
  GateVerdict,
} from './types'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MEMORY_LIMIT = 12

export interface ResearchGateOptions {
  hermes: HermesService
  reader: EntityMemoryReader
  /** The gate is a cheap structured call - default 30s, far below research timeouts. */
  timeoutMs?: number
  /** How many timeline entries (across all resolved entities) the model sees. */
  memoryLimit?: number
}

interface GateModelAnswer {
  verdict?: unknown
  reason?: unknown
}

const MODEL_VERDICTS: ReadonlySet<string> = new Set(['already_known', 'new_information', 'contradicts_prior'])

function decision(
  verdict: GateVerdict,
  reason: string,
  entityIds: string[],
  memoriesConsulted: number,
  entityContext: GateEntityContext | null
): GateDecision {
  return {
    verdict,
    proceed: verdict !== 'already_known',
    reason,
    entityIds,
    memoriesConsulted,
    entityContext,
  }
}

function buildGatePrompt(signal: GateSignal, context: GateEntityContext): string {
  return [
    'You are the myboon Research Gate.',
    '',
    'A new signal arrived about a subject we already track as one or more durable entities.',
    'Decide ONLY whether the entity memory timeline below already records what this signal reports.',
    '',
    'Do NOT judge importance, newsworthiness, or whether this deserves publishing - that is the editor\'s job.',
    'Do NOT judge evidence quality - that is not your job either.',
    'Answer only the knowledge question: does the timeline already contain this?',
    '',
    'Verdicts:',
    '- already_known: the timeline already records this same fact, move, or state. There is nothing new to research.',
    '- new_information: the signal reports something the timeline does not yet contain.',
    '- contradicts_prior: the signal conflicts with what the timeline currently says.',
    '',
    'When uncertain between already_known and new_information, prefer new_information - a wasted research pass is recoverable, a silently dropped story is not.',
    '',
    'Return strict JSON only: {"verdict": "already_known | new_information | contradicts_prior", "reason": "one short sentence"}',
    '',
    'New signal:',
    JSON.stringify({
      source: signal.source,
      subject: signal.sourceRefId,
      title: signal.title,
      what_changed: signal.whatChanged,
      observed_at: signal.observedAt,
    }, null, 2),
    '',
    'Entities this subject files under:',
    JSON.stringify(context.entities.map((entity) => ({
      slug: entity.slug,
      name: entity.name,
      summary: entity.summary,
    })), null, 2),
    '',
    'Entity memory timeline (newest first):',
    JSON.stringify(context.recentMemories.map((memory) => ({
      event_at: memory.eventAt,
      memory_type: memory.memoryType,
      title: memory.title,
      summary: memory.summary,
    })), null, 2),
  ].join('\n')
}

/**
 * Run the pre-research novelty gate for one signal. See types.ts for the
 * full design rationale. Invariants:
 *
 *  - Only 'already_known' stops research. Every other verdict - including
 *    every failure mode of the gate itself - proceeds (fail open).
 *  - The hermes call is only paid when there is an actual timeline to
 *    compare against: unknown subjects and empty timelines short-circuit.
 *  - The resolved timeline is returned to the caller on every proceed
 *    verdict so research can ask a diff question ("what changed since the
 *    latest entry?") instead of re-researching from scratch.
 */
export async function gateSignal(signal: GateSignal, options: ResearchGateOptions): Promise<GateDecision> {
  const memoryLimit = options.memoryLimit ?? DEFAULT_MEMORY_LIMIT

  let entityIds: string[]
  let context: GateEntityContext
  try {
    entityIds = [...new Set(await options.reader.entityIdsForSourceRef(signal.source, signal.sourceRefId))]
    if (entityIds.length === 0) {
      return decision('no_prior_entity', 'No entity has filed a memory under this subject before.', [], 0, null)
    }
    const [entities, recentMemories] = await Promise.all([
      options.reader.entitiesByIds(entityIds),
      options.reader.recentMemories(entityIds, memoryLimit),
    ])
    context = { entities, recentMemories }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return decision('gate_unavailable', `Entity reader failed: ${message.slice(0, 300)}`, [], 0, null)
  }

  if (context.recentMemories.length === 0) {
    return decision(
      'new_information',
      'Subject resolves to known entities but the timeline holds no memories to compare against.',
      entityIds,
      0,
      context
    )
  }

  try {
    const { value } = await options.hermes.structured<GateModelAnswer>({
      purpose: 'research-gate.novelty',
      prompt: buildGatePrompt(signal, context),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ignoreRules: true,
    })
    const verdict = typeof value?.verdict === 'string' ? value.verdict : ''
    if (!MODEL_VERDICTS.has(verdict)) {
      return decision(
        'gate_unavailable',
        `Gate model returned no usable verdict${verdict ? ` ('${verdict.slice(0, 60)}')` : ''}; proceeding with research.`,
        entityIds,
        context.recentMemories.length,
        context
      )
    }
    const reason = typeof value?.reason === 'string' && value.reason.trim()
      ? value.reason.trim().slice(0, 500)
      : `Gate verdict ${verdict} with no stated reason.`
    return decision(verdict as GateVerdict, reason, entityIds, context.recentMemories.length, context)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return decision(
      'gate_unavailable',
      `Gate model call failed: ${message.slice(0, 300)}`,
      entityIds,
      context.recentMemories.length,
      context
    )
  }
}

export const __testing = {
  buildGatePrompt,
}
