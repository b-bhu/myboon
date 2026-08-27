import { createHash } from 'node:crypto'
import { InferenceGatewayError } from '../inference-gateway'
import type {
  FailureCategory,
  ResearchPacketV1,
  ResearchWorkItem,
  RetrievedEvidence,
  Signal,
} from '../signal-platform/contracts'
import { adaptRetrievedEvidenceArtifact } from '../signal-platform/retrieved-evidence-adapter'
import type { GlobalSchedulerQuery } from '../signal-platform/shared-scheduler'
import { validateResearchPacket, validateRetrievedEvidence } from '../signal-platform/validation'
import type { RetrievedEvidenceArtifact, RetrievalBatch } from './deterministic-retrieval'
import { DeterministicRetriever } from './deterministic-retrieval'
import type { StandardSearchPlan } from './search-connector'
import {
  buildRetrievalPlan,
  buildStandardSearchQueries,
  type ResearchRetrievalLimits,
  type SharedResearchSchedulerPort,
  type StageReadinessPort,
  type StandardResearchSearchPort,
} from './shared-worker'
import { StructuredResearchSynthesizer } from './structured-synthesizer'

export const SHADOW_RESEARCH_RESULT_SCHEMA_VERSION = 'myboon.research_shadow_result.v1' as const
export const SHADOW_RESEARCH_EVALUATOR_VERSION = 'myboon.research_shadow_evaluator.v1' as const

export type ShadowResearchSkipReason = 'deep_not_supported' | 'circuit_open' | 'not_sampled'

export interface ShadowResearchResult {
  schemaVersion: typeof SHADOW_RESEARCH_RESULT_SCHEMA_VERSION
  evaluationId: string
  evaluatorVersion: typeof SHADOW_RESEARCH_EVALUATOR_VERSION
  workId: string
  signalId: string
  sourceType: Signal['sourceType']
  researchDepth: ResearchWorkItem['researchDepth']
  researchContractVersion: ResearchWorkItem['researchContractVersion']
  policyVersion: string
  traceId: string
  status: 'succeeded' | 'failed' | 'skipped'
  skipReason: ShadowResearchSkipReason | null
  failureCategory: FailureCategory | null
  evidence: RetrievedEvidence[]
  packet: ResearchPacketV1 | null
  providerCalls: number
  repairCalls: number
  inputTokens: number
  outputTokens: number
  toolCalls: number
  wallTimeMs: number
  startedAt: string
  finishedAt: string
}

export interface ShadowResearchResultStore {
  get(evaluationId: string): ShadowResearchResult | null
  append(result: ShadowResearchResult): { inserted: boolean, value: ShadowResearchResult }
}

export interface ShadowResearchSourcePort {
  readonly sourceType: Signal['sourceType']
  getSignal(signalId: string): Signal | null
}

export interface ResearchShadowEvaluatorClock { now(): Date }

export interface ResearchShadowEvaluatorOptions {
  scheduler: Pick<SharedResearchSchedulerPort, 'peekGlobal'>
  stores: ShadowResearchSourcePort[]
  retriever: DeterministicRetriever
  synthesizer: StructuredResearchSynthesizer
  results: ShadowResearchResultStore
  standardSearch?: StandardResearchSearchPort
  readiness?: StageReadinessPort
  sampleBasisPoints?: number
  retrieval?: Partial<ResearchRetrievalLimits>
  clock?: ResearchShadowEvaluatorClock
}

export type ShadowEvaluationOutcome =
  | { kind: 'succeeded' | 'failed' | 'skipped' | 'replayed', result: ShadowResearchResult }
  | { kind: 'idle' }

const DEFAULT_LIMITS: ResearchRetrievalLimits = {
  maxSources: 5,
  maxBytesPerSource: 1_000_000,
  maxTotalBytes: 3_000_000,
  maxTextCharsPerSource: 100_000,
  maxRedirects: 3,
  timeoutMs: 30_000,
}

/**
 * Executes the proposed path without ever receiving a canonical mutation or
 * claim port. Results live behind a separate append-only shadow boundary.
 */
export class ResearchShadowEvaluator {
  private readonly scheduler: Pick<SharedResearchSchedulerPort, 'peekGlobal'>
  private readonly stores: ReadonlyMap<Signal['sourceType'], ShadowResearchSourcePort>
  private readonly retriever: DeterministicRetriever
  private readonly synthesizer: StructuredResearchSynthesizer
  private readonly results: ShadowResearchResultStore
  private readonly standardSearch?: StandardResearchSearchPort
  private readonly readiness?: StageReadinessPort
  private readonly sampleBasisPoints: number
  private readonly retrievalLimits: ResearchRetrievalLimits
  private readonly clock: ResearchShadowEvaluatorClock

  constructor(options: ResearchShadowEvaluatorOptions) {
    if (options.stores.length === 0) throw new Error('At least one shadow research source store is required')
    this.scheduler = options.scheduler
    const stores = new Map<Signal['sourceType'], ShadowResearchSourcePort>()
    for (const store of options.stores) {
      if (stores.has(store.sourceType)) throw new Error(`Duplicate shadow source store ${store.sourceType}`)
      stores.set(store.sourceType, store)
    }
    this.stores = stores
    this.retriever = options.retriever
    this.synthesizer = options.synthesizer
    this.results = options.results
    this.standardSearch = options.standardSearch
    this.readiness = options.readiness
    this.sampleBasisPoints = boundedInteger(options.sampleBasisPoints ?? 10_000, 'sampleBasisPoints', 1, 10_000)
    this.retrievalLimits = validateLimits({ ...DEFAULT_LIMITS, ...options.retrieval })
    this.clock = options.clock ?? { now: () => new Date() }
  }

  async runBatch(limit: number): Promise<ShadowEvaluationOutcome[]> {
    const boundedLimit = boundedInteger(limit, 'limit', 1, 250)
    const query: GlobalSchedulerQuery = {
      now: this.nowIso(), limit: boundedLimit, stages: ['retrieval'],
    }
    const work = await this.scheduler.peekGlobal(query)
    if (work.length === 0) return [{ kind: 'idle' }]
    const outcomes: ShadowEvaluationOutcome[] = []
    for (const item of work) outcomes.push(await this.evaluate(item))
    return outcomes
  }

  async evaluate(workItem: ResearchWorkItem): Promise<ShadowEvaluationOutcome> {
    const evaluationId = shadowResearchEvaluationId(workItem)
    const existing = this.results.get(evaluationId)
    if (existing !== null) return { kind: 'replayed', result: existing }
    const startedAt = this.nowIso()
    if (!sampled(workItem.workId, this.sampleBasisPoints)) {
      return this.persist(baseResult(workItem, evaluationId, startedAt, this.nowIso(), {
        status: 'skipped', skipReason: 'not_sampled', failureCategory: null,
      }))
    }
    if (workItem.researchDepth === 'deep') {
      return this.persist(baseResult(workItem, evaluationId, startedAt, this.nowIso(), {
        status: 'skipped', skipReason: 'deep_not_supported', failureCategory: null,
      }))
    }
    if (workItem.researchDepth !== 'light' && workItem.researchDepth !== 'standard') {
      return this.persist(baseResult(workItem, evaluationId, startedAt, this.nowIso(), {
        status: 'failed', skipReason: null, failureCategory: 'schema_version_mismatch',
      }))
    }
    const store = this.stores.get(workItem.sourceType)
    const signal = store?.getSignal(workItem.signalId) ?? null
    if (store === undefined || signal === null || signal.sourceType !== workItem.sourceType) {
      return this.persist(baseResult(workItem, evaluationId, startedAt, this.nowIso(), {
        status: 'failed', skipReason: null, failureCategory: 'permanent_source_error',
      }))
    }
    if (Date.parse(workItem.freshnessDeadline) <= this.clock.now().getTime()) {
      return this.persist(baseResult(workItem, evaluationId, startedAt, this.nowIso(), {
        status: 'failed', skipReason: null, failureCategory: 'budget_exceeded',
      }))
    }
    if (this.readiness !== undefined) {
      const readiness = await this.readiness.check({ stage: 'synthesis', workItem })
      if (!readiness.ready) {
        return this.persist(baseResult(workItem, evaluationId, startedAt, this.nowIso(), {
          status: 'skipped', skipReason: 'circuit_open', failureCategory: 'circuit_open',
        }))
      }
    }
    if (workItem.researchDepth === 'standard' && this.standardSearch === undefined) {
      return this.persist(baseResult(workItem, evaluationId, startedAt, this.nowIso(), {
        status: 'failed', skipReason: null, failureCategory: 'retrieval_blocked',
      }))
    }

    try {
      let plan = buildRetrievalPlan(workItem, this.retrievalLimits)
      if (workItem.researchDepth === 'standard') {
        const discovery = await this.standardSearch!.discover({
          signal, work: workItem, queries: buildStandardSearchQueries(signal),
        })
        plan = mergeSearchPlan(plan, discovery)
      }
      const batch = await this.retriever.retrieve(plan)
      if (batch.artifacts.length === 0) {
        return this.persist(baseResult(workItem, evaluationId, startedAt, this.nowIso(), {
          status: 'failed', skipReason: null, failureCategory: retrievalFailure(batch),
        }))
      }
      const packet = await this.synthesizer.synthesize({
        signal, workItem, evidence: batch.artifacts,
      })
      const evidence = batch.artifacts.map(adaptRetrievedEvidenceArtifact)
      return this.persist({
        ...baseResult(workItem, evaluationId, startedAt, this.nowIso(), {
          status: 'succeeded', skipReason: null, failureCategory: null,
        }),
        evidence,
        packet,
        providerCalls: packet.budgetUsed.providerCalls,
        repairCalls: packet.budgetUsed.repairCalls,
        inputTokens: packet.budgetUsed.inputTokens,
        outputTokens: packet.budgetUsed.outputTokens,
        toolCalls: packet.budgetUsed.toolCalls,
        wallTimeMs: elapsedMs(startedAt, this.nowIso()),
      })
    } catch (error) {
      return this.persist(baseResult(workItem, evaluationId, startedAt, this.nowIso(), {
        status: 'failed', skipReason: null, failureCategory: typedFailure(error),
      }))
    }
  }

  private persist(result: ShadowResearchResult): ShadowEvaluationOutcome {
    const stored = this.results.append(validateShadowResearchResult(result)).value
    return { kind: stored.status, result: stored }
  }

  private nowIso(): string { return this.clock.now().toISOString() }
}

export function shadowResearchEvaluationId(
  work: Pick<ResearchWorkItem, 'workId' | 'researchContractVersion'>,
): string {
  const digest = createHash('sha256')
    .update(`${work.workId.length}:${work.workId}|${work.researchContractVersion.length}:${work.researchContractVersion}|${SHADOW_RESEARCH_EVALUATOR_VERSION}`)
    .digest('hex')
  return `shadow_research_${digest}`
}

export function validateShadowResearchResult(value: ShadowResearchResult): ShadowResearchResult {
  if (value.schemaVersion !== SHADOW_RESEARCH_RESULT_SCHEMA_VERSION
    || value.evaluatorVersion !== SHADOW_RESEARCH_EVALUATOR_VERSION
    || value.evaluationId !== shadowResearchEvaluationId({
      workId: value.workId,
      researchContractVersion: value.researchContractVersion,
    })) throw new Error('Shadow research result identity or schema is invalid')
  for (const field of [
    'providerCalls', 'repairCalls', 'inputTokens', 'outputTokens', 'toolCalls', 'wallTimeMs',
  ] as const) {
    if (!Number.isInteger(value[field]) || value[field] < 0) throw new Error(`Shadow result ${field} is invalid`)
  }
  if (!Number.isFinite(Date.parse(value.startedAt)) || !Number.isFinite(Date.parse(value.finishedAt))
    || Date.parse(value.finishedAt) < Date.parse(value.startedAt)) {
    throw new Error('Shadow result timestamps are invalid')
  }
  if (value.toolCalls !== 0) throw new Error('Shadow light/standard research must record zero tool calls')
  if ((value.status === 'succeeded' && (value.skipReason !== null || value.failureCategory !== null))
    || (value.status === 'failed' && (value.skipReason !== null || value.failureCategory === null))
    || (value.status === 'skipped' && value.skipReason === null)) {
    throw new Error('Shadow result status metadata is inconsistent')
  }
  for (const artifact of value.evidence) {
    const validated = validateRetrievedEvidence(artifact)
    if (validated.workId !== value.workId) throw new Error('Shadow evidence linkage is invalid')
  }
  if (value.status === 'succeeded' && (value.packet === null || value.evidence.length === 0)) {
    throw new Error('Successful shadow research requires evidence and a packet')
  }
  if (value.packet !== null) {
    const packet = validateResearchPacket(value.packet)
    if (packet.workId !== value.workId || packet.signalId !== value.signalId
      || packet.budgetUsed.providerCalls !== value.providerCalls
      || packet.budgetUsed.repairCalls !== value.repairCalls
      || packet.budgetUsed.inputTokens !== value.inputTokens
      || packet.budgetUsed.outputTokens !== value.outputTokens
      || packet.budgetUsed.toolCalls !== value.toolCalls) {
      throw new Error('Shadow packet linkage or usage is invalid')
    }
  }
  return value
}

function baseResult(
  work: ResearchWorkItem,
  evaluationId: string,
  startedAt: string,
  finishedAt: string,
  status: Pick<ShadowResearchResult, 'status' | 'skipReason' | 'failureCategory'>,
): ShadowResearchResult {
  return {
    schemaVersion: SHADOW_RESEARCH_RESULT_SCHEMA_VERSION,
    evaluationId,
    evaluatorVersion: SHADOW_RESEARCH_EVALUATOR_VERSION,
    workId: work.workId,
    signalId: work.signalId,
    sourceType: work.sourceType,
    researchDepth: work.researchDepth,
    researchContractVersion: work.researchContractVersion,
    policyVersion: work.policyVersion,
    traceId: work.traceId,
    ...status,
    evidence: [], packet: null,
    providerCalls: 0, repairCalls: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0,
    wallTimeMs: elapsedMs(startedAt, finishedAt), startedAt, finishedAt,
  }
}

function mergeSearchPlan(
  retrieval: ReturnType<typeof buildRetrievalPlan>,
  discovery: StandardSearchPlan,
): ReturnType<typeof buildRetrievalPlan> {
  const seen = new Set<string>()
  const urls = [...retrieval.urls, ...discovery.urls].filter((item) => {
    const normalized = new URL(item.url).toString()
    if (seen.has(normalized)) return false
    seen.add(normalized)
    return true
  }).slice(0, retrieval.maxSources)
  return { ...retrieval, urls }
}

function retrievalFailure(batch: RetrievalBatch): FailureCategory {
  return batch.failures[0]?.category ?? 'permanent_source_error'
}

function typedFailure(error: unknown): FailureCategory {
  if (error instanceof InferenceGatewayError) return error.category
  if (typeof error === 'object' && error !== null && typeof (error as { category?: unknown }).category === 'string') {
    return (error as { category: FailureCategory }).category
  }
  return 'provider_unavailable'
}

function sampled(workId: string, basisPoints: number): boolean {
  const bucket = Number.parseInt(createHash('sha256').update(workId).digest('hex').slice(0, 8), 16) % 10_000
  return bucket < basisPoints
}

function elapsedMs(startedAt: string, finishedAt: string): number {
  return Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt))
}

function validateLimits(value: ResearchRetrievalLimits): ResearchRetrievalLimits {
  for (const [name, limit] of Object.entries(value)) boundedInteger(limit, `retrieval.${name}`, name === 'maxRedirects' ? 0 : 1, 500_000_000)
  if (value.maxTotalBytes < value.maxBytesPerSource) throw new Error('maxTotalBytes must cover maxBytesPerSource')
  return value
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}
