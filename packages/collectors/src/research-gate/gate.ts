import { HermesService } from '../hermes'
import { createHash } from 'node:crypto'
import {
  ClassificationDoubleFailureError,
  RESEARCH_NOVELTY_VERSION,
  RESEARCH_NOVELTY_WORKLOAD,
  type ClassificationGateway,
  type ResearchNoveltyDecision,
} from '../inference-gateway'
import type {
  EntityMemoryReader,
  GateDecision,
  GateEntityContext,
  GateNoveltyLookup,
  GateSignal,
  GateVerdict,
} from './types'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MEMORY_LIMIT = 12

export interface ResearchGateOptions {
  /** Transitional compatibility. New composition must supply classification. */
  hermes?: HermesService
  classification?: Pick<ClassificationGateway, 'classify' | 'recordPolicyOutcome'>
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
      source_material: signal.sourceMaterial,
      source_material_complete: signal.sourceMaterialComplete,
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

function earliestTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b
  if (b === null) return a
  return a < b ? a : b
}

function latestTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b
  if (b === null) return a
  return a > b ? a : b
}

/**
 * What the novelty comparison consulted, built from the basic timeline
 * lookups and (when the reader offers it) the optional richer evidence
 * lookup: bounded relevant context per PRD v4 stage-3 - identities, refs,
 * time coverage, truncation, failures, digest. The evidence merge never
 * throws and never fails the gate: its errors are recorded in
 * lookupFailures so an incomplete lookup suppresses already_known instead.
 */
export async function buildNoveltyLookup(
  reader: EntityMemoryReader,
  signal: GateSignal,
  entityIds: string[],
  context: GateEntityContext,
  memoryLimit: number,
): Promise<GateNoveltyLookup> {
  const times = context.recentMemories.map((memory) => memory.eventAt)
  const record: GateNoveltyLookup = {
    resolvedCandidateRefs: entityIds,
    itemRefs: [],
    timeCoverage: {
      oldestEventAt: times.reduce(earliestTimestamp, null),
      newestEventAt: times.reduce(latestTimestamp, null),
    },
    // Conservative bound inference: when the timeline lookup returned its
    // full limit there were probably more entries, so the comparison may
    // have seen less than everything and cannot claim it (see
    // lookupIncompleteness).
    truncated: context.recentMemories.length >= memoryLimit,
    unrelated: false,
    evidenceRan: false,
    lookupFailures: [],
    digest: `sha256:${createHash('sha256')
      .update(JSON.stringify([context.entities, context.recentMemories]))
      .digest('hex')}`,
  }
  const evidenceCall = reader.noveltyEvidence
  if (!evidenceCall) return record
  record.evidenceRan = true
  try {
    const evidence = await evidenceCall.call(reader, signal.source, signal.sourceRefId)
    record.itemRefs = evidence.itemRefs
    record.timeCoverage = {
      oldestEventAt: earliestTimestamp(record.timeCoverage.oldestEventAt, evidence.timeCoverage?.oldestEventAt ?? null),
      newestEventAt: latestTimestamp(record.timeCoverage.newestEventAt, evidence.timeCoverage?.newestEventAt ?? null),
    }
    if (evidence.truncated) record.truncated = true
    if (evidence.unrelated) record.unrelated = true
    record.lookupFailures.push(...evidence.failures)
    if (evidence.digest) record.digest = `${record.digest}+evidence:${evidence.digest}`
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    record.lookupFailures.push(`novelty evidence lookup failed: ${message.slice(0, 300)}`)
  }
  return record
}

/**
 * The one PRD v4 stage-3 rule for novelty lookups: an empty, failed,
 * truncated, or unrelated lookup can NEVER justify already_known - the
 * cheap title/summary comparison that did not see everything must
 * proceed, because the unseen body may hold new information.
 */
function lookupIncompleteness(lookup: GateNoveltyLookup): string | null {
  if (lookup.resolvedCandidateRefs.length === 0) {
    return 'no candidate identities were resolved'
  }
  if (lookup.truncated) {
    return 'the consulted set was truncated - unseen entries may already record this signal'
  }
  if (lookup.unrelated) {
    return 'the consulted evidence concerns a different subject'
  }
  if (lookup.lookupFailures.length > 0) {
    return `lookups failed - ${lookup.lookupFailures.join('; ').slice(0, 300)}`
  }
  if (lookup.evidenceRan && lookup.itemRefs.length === 0) {
    return 'the evidence lookup returned no related references - nothing beyond the bounded timeline was consulted'
  }
  return null
}

/**
 * Verdict finalizer: attaches the bounded novelty record to completed
 * comparisons and applies the one suppression rule. Attaching is additive
 * bookkeeping (GateDecision.noveltyContext); suppression only downgrades
 * the skip verdict to a proceed verdict, never the reverse.
 */
function finalizeVerdict(
  verdict: GateVerdict,
  reason: string,
  entityIds: string[],
  memoriesConsulted: number,
  entityContext: GateEntityContext | null,
  noveltyLookup: GateNoveltyLookup | undefined,
  sourceMaterialComplete = true,
): GateDecision {
  if (verdict === 'already_known' && !sourceMaterialComplete) {
    verdict = 'new_information'
    reason = 'The novelty comparison did not cover the complete source material; unseen information is retained for Research.'
  }
  if (noveltyLookup) {
    if (verdict === 'already_known') {
      const incompleteness = lookupIncompleteness(noveltyLookup)
      if (incompleteness) {
        return {
          ...decision(
            'new_information',
            `Suppressed already_known ("${reason.slice(0, 160)}") - ${incompleteness}.`,
            entityIds,
            memoriesConsulted,
            entityContext,
          ),
          noveltyContext: noveltyLookup,
        }
      }
    }
    return {
      ...decision(verdict, reason, entityIds, memoriesConsulted, entityContext),
      noveltyContext: noveltyLookup,
    }
  }
  return decision(verdict, reason, entityIds, memoriesConsulted, entityContext)
}

/**
 * Run the pre-research novelty gate for one signal. See types.ts for the
 * full design rationale. Invariants:
 *
 *  - Only 'already_known' stops research. Every other verdict - including
 *    every failure mode of the gate itself - proceeds (fail open).
 *  - An empty, failed, truncated, or unrelated novelty lookup can never
 *    justify already_known (PRD v4 stage-3): finalizeVerdict downgrades it
 *    to new_information, so a signal is never dropped on incomplete
 *    comparison evidence.
 *  - The evidence merge records failures inside the record and never fails
 *    the gate; a reader without the optional noveltyEvidence port keeps the
 *    legacy comparison shape.
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
      if (options.reader.noveltyEvidence) {
        const evidence = await options.reader.noveltyEvidence(signal.source, signal.sourceRefId)
        if (evidence.failures.length > 0 || evidence.truncated || evidence.unrelated) {
          return decision('gate_unavailable', `Candidate lookup coverage is incomplete: ${evidence.failures.join('; ').slice(0, 300)}`, [], 0, null)
        }
      }
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
    const noveltyLookup = await buildNoveltyLookup(options.reader, signal, entityIds, context, memoryLimit)
    if (options.classification) {
      return await classifyWithGateway(signal, context, entityIds, options, noveltyLookup)
    }
    if (!options.hermes) throw new Error('Research gate classification gateway is not configured')
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
    return finalizeVerdict(verdict as GateVerdict, reason, entityIds, context.recentMemories.length, context, noveltyLookup,
      signal.sourceMaterialComplete !== false)
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

async function classifyWithGateway(
  signal: GateSignal,
  context: GateEntityContext,
  entityIds: string[],
  options: ResearchGateOptions,
  noveltyLookup: GateNoveltyLookup,
): Promise<GateDecision> {
  const classification = options.classification!
  try {
    const result = await classification.classify<ResearchNoveltyDecision>({
      workload: RESEARCH_NOVELTY_WORKLOAD,
      decisionVersion: RESEARCH_NOVELTY_VERSION,
      state: { signal, context },
      trace: {
        stableDecisionKey: researchNoveltyKey(signal),
        correlationIds: { source: signal.source.slice(0, 200), sourceRefId: signal.sourceRefId.slice(0, 200) },
      },
      ...(options.timeoutMs ? { tighterDeadlineMs: options.timeoutMs } : {}),
    })
    const verdict = result.value.verdict
    const output = finalizeVerdict(verdict, result.value.reason, entityIds, context.recentMemories.length, context, noveltyLookup,
      signal.sourceMaterialComplete !== false)
    await classification.recordPolicyOutcome({
      decisionId: result.decisionId,
      consumer: 'research-gate',
      policyVersion: 'research-gate.novelty-policy.v1',
      outcome: output.proceed ? 'proceed' : 'hold',
      reasonCode: output.verdict,
    })
    return output
  } catch (error) {
    if (error instanceof ClassificationDoubleFailureError) {
      try {
        await classification.recordPolicyOutcome({
          decisionId: error.decisionId,
          consumer: 'research-gate',
          policyVersion: 'research-gate.novelty-policy.v1',
          outcome: 'proceed',
          reasonCode: 'classification_double_failure_fail_open',
        })
      } catch { /* failure audit must not turn fail-open into signal loss */ }
    }
    throw error
  }
}

function researchNoveltyKey(signal: GateSignal): string {
  return `research-novelty:${createHash('sha256')
    .update(JSON.stringify([signal.source, signal.sourceRefId, signal.observedAt]))
    .digest('hex')}`
}

export const __testing = {
  buildGatePrompt,
}
