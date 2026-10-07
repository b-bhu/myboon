import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClassificationGateway, ClassificationRequest, ClassificationResult } from '../inference-gateway'
import {
  SIGNAL_SCHEMA_VERSION, RESEARCH_PACKET_SCHEMA_VERSION, RESEARCH_WORK_SCHEMA_VERSION,
  RETRIEVED_EVIDENCE_SCHEMA_VERSION,
  type Signal, type ResearchWorkItem, type RetrievedEvidence, type ResearchPacketV1,
} from '../signal-platform/contracts'
import { SqliteSignalPlatformStore } from '../signal-platform/sqlite-platform-store'
import { StructuredResearchSynthesizer, deterministicPacketId, type StructuredSynthesisInput } from './structured-synthesizer'
import type { SharedResearchV4Options, SharedWorkerClock } from './shared-worker'
import type { EntityMemoryReader } from '../research-gate/types'

export const V4_NOW = '2026-10-03T08:00:00.000Z'
export const V4_SOURCE_URL = 'https://issuer.example/release'
export const V4_FOLLOWUP_URL = 'https://regulator.example/correction'
export const V4_POLICY: SharedResearchV4Options = {
  policyVersion: 'offline-test.v4',
  assignmentPolicy: { policyVersion: 'offline-test.assignment.v1', maxProviderCalls: 8,
    maxInputTokens: 100_000, maxOutputTokens: 20_000, maxIncrementalCostUsdMicros: null },
  synthesisPolicy: { policyVersion: 'offline-test.synthesis.v1', maxInputTokens: 20_000,
    maxOutputTokens: 4_000, maxIncrementalCostUsdMicros: null },
}
export const V4_FOLLOWUP_POLICY = { policyVersion: 'offline-test.followup.v1', maxProviderCalls: 1,
  maxInputTokens: 20_000, maxOutputTokens: 4_000, maxIncrementalCostUsdMicros: null,
  maxSources: 2, maxTotalBytes: 20_000, maxBytesPerSource: 10_000, maxWallTimeMs: 5_000 }

export function v4Signal(source: 'news' | 'polymarket' = 'news', id: string = source): Signal {
  return {
    schemaVersion: SIGNAL_SCHEMA_VERSION, signalId: `signal-${id}`, sourceType: source, sourceId: `${source}:${id}`,
    contentKind: source === 'news' ? 'article' : 'market_event',
    content: { schemaVersion: source === 'news' ? 'myboon.signal_content.article.v1' : 'myboon.signal_content.market_event.v1' },
    title: 'Atlas says a product launches Friday', visibleSummary: 'Atlas says Friday is its launch date.',
    canonicalUrl: V4_SOURCE_URL, observedAt: V4_NOW, publishedAt: V4_NOW,
    provenance: { provider: 'offline-fixture', upstreamSource: 'Atlas', rawPayloadRef: `raw-${id}` },
    media: { imageUrl: null, attribution: null },
    sourceHints: { entities: ['Atlas'], assets: [], eventId: null, deadline: null }, idempotencyKey: `fixture-${id}`,
  } as Signal
}

export function v4Work(signal = v4Signal(), overrides: Partial<ResearchWorkItem> = {}): ResearchWorkItem {
  return { schemaVersion: RESEARCH_WORK_SCHEMA_VERSION, workId: `work-${signal.signalId}`, signalId: signal.signalId,
    sourceType: signal.sourceType, researchDepth: 'light', deepReason: null, priorityClass: 'P1', priorityScore: 0.8,
    freshnessDeadline: '2026-10-03T10:00:00.000Z', policyVersion: 'offline-test.work.v1',
    researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION,
    retrievalPlan: { sourceUrl: V4_SOURCE_URL, allowedDomains: ['issuer.example', 'regulator.example'], maxExternalSources: 1,
      followupUrls: [V4_FOLLOWUP_URL] },
    budget: { maxProviderCalls: 2, maxRepairCalls: 1, maxToolCalls: 0, maxWallTimeMs: 30_000 },
    status: 'synthesis_pending', attemptCount: 0, nextAttemptAt: null, leaseOwner: null, leaseId: null, leaseExpiresAt: null,
    failureCategory: null, failureDetail: null, traceId: `trace-${signal.signalId}`, createdAt: V4_NOW, updatedAt: V4_NOW,
    ...overrides,
  }
}

export function v4Evidence(work: ResearchWorkItem,
  overrides: Partial<RetrievedEvidence & { retrievalMethod: 'safe_http' }> = {}): RetrievedEvidence & { retrievalMethod: 'safe_http' } {
  return { schemaVersion: RETRIEVED_EVIDENCE_SCHEMA_VERSION, evidenceId: `evidence-${work.workId}`,
    workId: work.workId, requestedUrl: V4_SOURCE_URL, finalUrl: V4_SOURCE_URL, authority: 'source_url', authorityId: 'fixture-source',
    contentHash: 'offline-source-hash', contentType: 'text/plain', httpStatus: 200, retrievalMethod: 'safe_http',
    retrievedAt: V4_NOW, text: 'Atlas says a product launches Friday.', byteLength: 35, truncated: false, ...overrides }
}

export function v4Packet(input: StructuredSynthesisInput, overrides: Partial<ResearchPacketV1> = {}): ResearchPacketV1 {
  const artifact = input.evidence[0]
  const packetId = deterministicPacketId(input.workItem.workId, input.workItem.researchContractVersion)
  return { schemaVersion: RESEARCH_PACKET_SCHEMA_VERSION, packetId, workId: input.workItem.workId, signalId: input.signal.signalId,
    sourceType: input.signal.sourceType, sourceSignal: { ...input.signal }, observedAt: input.signal.observedAt,
    claims: [{ claimId: `claim-${packetId}`, claim: 'Atlas says a product launches Friday.', attributedTo: 'Atlas', evidenceRefs: [artifact.evidenceId] }],
    verifiedFacts: [], unresolvedClaims: [], entityHints: [], limitations: ['Independent launch confirmation unavailable.'],
    openQuestions: ['Which launch date does the regulator record?'], completion: 'partial',
    evidence: input.evidence.map((entry) => ({ evidenceId: entry.evidenceId, title: 'Source', url: entry.finalUrl,
      sourceType: entry.authority, observedAt: entry.retrievedAt, note: null })),
    budgetUsed: { providerCalls: 1, repairCalls: 0, inputTokens: 500, outputTokens: 80, toolCalls: 0,
      wallTimeMs: 100, budgetExceeded: false, costUsdMicros: null },
    execution: { provider: 'offline', model: 'offline', fallbackUsed: false, fallbackProvider: null, fallbackModel: null,
      promptVersion: 'offline-test.prompt.v1', policyVersion: input.workItem.policyVersion,
      traceId: input.workItem.traceId, attempt: input.workItem.attemptCount },
    researchContractVersion: input.workItem.researchContractVersion, createdAt: V4_NOW, ...overrides }
}

export class V4Synthesizer extends StructuredResearchSynthesizer {
  readonly inputs: StructuredSynthesisInput[] = []
  constructor(private readonly result: (input: StructuredSynthesisInput) => ResearchPacketV1 | Promise<ResearchPacketV1> = v4Packet) {
    super({ promptVersion: 'offline-test.prompt.v1', gateway: { async generateStructured() { throw new Error('Offline fixture cannot invoke a provider') } } })
  }
  override async synthesize(input: StructuredSynthesisInput & { articlePreparation: NonNullable<StructuredSynthesisInput['articlePreparation']> }): Promise<import('../signal-platform/contracts').ArticleResearchPacketV1>
  override async synthesize(input: StructuredSynthesisInput & { articlePreparation?: undefined }): Promise<ResearchPacketV1>
  override async synthesize(input: StructuredSynthesisInput): Promise<import('../signal-platform/contracts').ResearchPacket>
  override async synthesize(input: StructuredSynthesisInput): Promise<import('../signal-platform/contracts').ResearchPacket> {
    if (input.articlePreparation) throw new Error('Legacy fixture cannot synthesize article packets')
    this.inputs.push(input); return this.result(input)
  }
}

export function v4ClassificationResult<Value>(value: Value): ClassificationResult<Value> {
  return { decisionId: 'offline-classification-id', workload: 'offline', decisionVersion: 'offline.v1', value,
    configuredPrimary: { provider: 'typesafe', model: 'jev-1.13.0' }, configuredFallback: null,
    actualProvider: 'offline', actualModel: 'offline', fallbackUsed: false, fallbackReason: null,
    answers: null, usage: { inputTokens: 100, outputTokens: 20 }, durationMs: 5 }
}

interface V4ClassifierFixture {
  port: Pick<ClassificationGateway, 'classify' | 'recordPolicyOutcome'>
  requests: ClassificationRequest[]
}
export function v4Classifier(value: (request: ClassificationRequest) => unknown): V4ClassifierFixture
export function v4Classifier(value: unknown): V4ClassifierFixture
export function v4Classifier(value: unknown): V4ClassifierFixture {
  const requests: ClassificationRequest[] = []
  const port: Pick<ClassificationGateway, 'classify' | 'recordPolicyOutcome'> = {
    async classify<Value>(request: ClassificationRequest) {
      requests.push(request)
      return v4ClassificationResult((typeof value === 'function' ? value(request) : value) as Value)
    },
    async recordPolicyOutcome() {},
  }
  return { port, requests }
}

export function v4ContextReader(digest = 'knowledge-digest-v1'): EntityMemoryReader {
  return { entityIdsForSourceRef: async () => ['entity-atlas'],
    entitiesByIds: async () => [{ id: 'entity-atlas', slug: 'atlas', name: 'Atlas', summary: null }],
    recentMemories: async () => [{ entityId: 'entity-atlas', title: 'Launch announced', memoryType: 'managed_knowledge',
      summary: 'Atlas claimed Friday as a launch date.', eventAt: V4_NOW }],
    noveltyEvidence: async () => ({ itemRefs: ['item-atlas'], failures: [], truncated: false, digest }),
  }
}

export function v4Clock(instant = V4_NOW): SharedWorkerClock {
  return { now: () => new Date(instant), setInterval: () => 1, clearInterval: () => undefined }
}

export function v4Database(source: 'news' | 'polymarket' = 'news') {
  const dir = mkdtempSync(join(tmpdir(), 'myboon-v4-research-'))
  const path = join(dir, 'source.sqlite')
  const store = new SqliteSignalPlatformStore(path, source)
  return { dir, path, store, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

export function seedV4(store: SqliteSignalPlatformStore, signal = v4Signal(store.sourceType as 'news' | 'polymarket'), overrides: Partial<ResearchWorkItem> = {}) {
  const work = v4Work(signal, overrides)
  const evidence = v4Evidence(work)
  store.appendSignal(signal); store.admitResearchWork(work); store.appendEvidence(evidence)
  return { signal, work, evidence }
}
