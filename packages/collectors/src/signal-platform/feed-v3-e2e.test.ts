import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  CANONICAL_ENTITY_PLAN_SCHEMA_VERSION,
  EntityServiceCanonicalPacketProcessor,
  SharedEntityWorker,
  sharedEntityWorkerConfig,
  type EntityPacketWorkPort,
} from '../entity-manager/public'
import { InMemoryEntityMemoryStore } from '../entity-manager/test-helpers'
import type { EntityMemoryRecord } from '../entity-manager/types'
import type {
  GenerateStructuredRequest,
  InferenceResult,
  InferenceTelemetry,
} from '../inference-gateway'
import {
  DeterministicRetriever,
  SharedResearchWorker,
  StructuredResearchSynthesizer,
  type SharedWorkerClock,
  type StructuredSynthesisBody,
  type StructuredSynthesisGateway,
} from '../research-engine'
import { SIGNAL_SCHEMA_VERSION, type Signal } from './contracts'
import { SignalIntakeCoordinator } from './signal-intake'
import { SqliteSignalPlatformStore } from './sqlite-platform-store'
import type {
  HeartbeatCommand,
  LeaseCommand,
  LeasedTransitionCommand,
  ReleaseLeaseCommand,
  SchedulerQuery,
  WorkLease,
} from './store-adapter'
import { createPriorityPolicyV1, RulesFirstTriageEngine } from './triage-engine'
import type { RulesFirstTriageInput } from './triage-contracts'

const INTAKE_NOW = '2026-08-26T12:00:00.000Z'
const RESEARCH_NOW = '2026-08-26T12:10:00.000Z'
const ENTITY_NOW = '2026-08-26T12:20:00.000Z'

class FixedWorkerClock implements SharedWorkerClock {
  constructor(private readonly timestamp: string) {}
  now(): Date { return new Date(this.timestamp) }
  setInterval(): unknown { return 1 }
  clearInterval(): void {}
}

class SqliteEntityWorkPort implements EntityPacketWorkPort {
  readonly sourceType: Signal['sourceType']

  constructor(private readonly store: SqliteSignalPlatformStore) {
    this.sourceType = store.sourceType
  }

  peekSchedulable(query: SchedulerQuery) { return this.store.peekSchedulable(query) }
  claimWithLease(command: LeaseCommand): Promise<WorkLease | null> { return this.store.claimWithLease(command) }
  heartbeatLease(command: HeartbeatCommand): Promise<boolean> { return this.store.heartbeatLease(command) }
  transitionLeased(command: LeasedTransitionCommand): Promise<boolean> { return this.store.transitionLeased(command) }
  releaseLease(command: ReleaseLeaseCommand): Promise<boolean> { return this.store.releaseLease(command) }
  async readResearchPacket(workId: string): Promise<unknown | null> {
    return this.store.listResearchPacketsByWork(workId, 2)[0] ?? null
  }
}

class CountingSynthesisGateway implements StructuredSynthesisGateway {
  calls = 0
  lastBudget: GenerateStructuredRequest<unknown>['budget'] | null = null

  async generateStructured<T>(request: GenerateStructuredRequest<T>): Promise<InferenceResult<T>> {
    this.calls += 1
    this.lastBudget = request.budget
    const evidenceId = request.prompt.match(/evidence_[0-9a-f]{64}/)?.[0]
    assert.ok(evidenceId, 'the bounded synthesis prompt must contain the canonical evidence ID')
    const body: StructuredSynthesisBody = {
      claims: [{
        claim: 'Example Protocol published version 2 launch guidance.',
        attributedTo: 'Example Protocol',
        evidenceRefs: [evidenceId],
      }],
      verifiedFacts: [],
      unresolvedClaims: [],
      entityHints: [{
        name: 'Example Protocol', type: 'organization', role: 'subject', aliases: ['Example'],
        source: 'official announcement', evidenceRefs: [evidenceId],
      }],
      limitations: [],
      openQuestions: [],
      completion: 'complete',
    }
    const validated = request.validate(body)
    if (!validated.valid) throw new Error('fake synthesis body failed the production validator')
    assert.equal(validated.valid, true)
    return {
      value: validated.value,
      telemetry: telemetry(request.promptVersion, request.policyVersion),
    }
  }
}

function telemetry(promptVersion: string, policyVersion: string): InferenceTelemetry {
  return {
    workload: 'research.synthesis', purpose: 'research.structured-synthesis', mode: 'generateStructured',
    promptVersion, policyVersion,
    configuredPrimaryProvider: 'fake-provider', configuredPrimaryModel: 'fake-model',
    actualProvider: 'fake-provider', actualModel: 'fake-model',
    fallbackInvoked: false, fallbackReason: null, schemaValid: true,
    providerCalls: 1, repairCalls: 0, inputTokens: 321, outputTokens: 87,
    toolCalls: 0, durationMs: 25, budgetExceeded: false, failureCategory: null, calls: [],
  }
}

function signal(): Signal {
  return {
    schemaVersion: SIGNAL_SCHEMA_VERSION,
    signalId: 'signal-feed-v3-e2e',
    sourceId: 'news:example-protocol:v2',
    sourceType: 'news',
    contentKind: 'article',
    content: { schemaVersion: 'myboon.signal_content.article.v1' },
    observedAt: INTAKE_NOW,
    publishedAt: '2026-08-26T11:55:00.000Z',
    canonicalUrl: 'https://news.example/protocol-v2',
    title: 'Example Protocol publishes version 2 guidance',
    visibleSummary: 'The official project site published launch guidance.',
    media: { imageUrl: null, attribution: 'Example Protocol' },
    sourceHints: { entities: ['Example Protocol'], assets: ['EX'], eventId: null, deadline: null },
    provenance: { provider: 'fake-news-feed', upstreamSource: 'Example Protocol', rawPayloadRef: 'news-row-1' },
    idempotencyKey: 'news:example-protocol:v2:2026-08-26',
  }
}

function triageInput(item: Signal): RulesFirstTriageInput {
  const bucket = { available: 10, reservedAvailable: 2, utilization: 0 }
  return {
    signal: item,
    dedupeOutcome: 'new_observation',
    sourceAuthorityScore: 0.4,
    officialSource: false,
    entityCanonOverlap: false,
    novelty: 'none',
    materialityTags: ['social'],
    eventDeadline: null,
    capacity: {
      byPriority: { P0: { ...bucket }, P1: { ...bucket }, P2: { ...bucket }, P3: { ...bucket } },
      byDepth: { light: { ...bucket }, standard: { ...bucket }, deep: { ...bucket } },
    },
    providerHealth: 'healthy',
    ambiguity: { isAmbiguous: false, reasons: [] },
    deepEscalation: null,
    now: INTAKE_NOW,
  }
}

test('active Signal intake reaches stable entity memory and full replay is idempotent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-v3-e2e-'))
  const store = new SqliteSignalPlatformStore(join(dir, 'news.sqlite'), 'news')
  try {
    const item = signal()
    const policy = createPriorityPolicyV1({
      policyVersion: 'feed-v3-e2e-policy.v1', budgetPolicyVersion: 'feed-v3-e2e-budget.v1',
    })
    const intake = new SignalIntakeCoordinator({
      store,
      triage: new RulesFirstTriageEngine({ policy }),
      retrievalPolicy: {
        policyVersion: 'feed-v3-e2e-retrieval.v1',
        allowedDomains: ['news.example'],
        maxExternalSourcesByDepth: { light: 0, standard: 2, deep: 5 },
      },
      mode: 'active',
    })
    const admitted = await intake.process(triageInput(item))
    assert.equal(admitted.decision.outcome, 'light')
    assert.deepEqual(admitted.persisted, {
      signalInserted: true, decisionInserted: true, workInserted: true,
    })
    assert.ok(admitted.work)
    assert.equal(store.getResearchWork(admitted.work.workId)?.status, 'research_pending')

    let networkCalls = 0
    const retriever = new DeterministicRetriever({
      now: () => new Date(RESEARCH_NOW),
      async fetchDocument(url) {
        networkCalls += 1
        return {
          body: Buffer.from('<article>Example Protocol published version 2 launch guidance.</article>'),
          finalUrl: url, contentType: 'text/html', status: 200, visitedHosts: ['news.example'],
        }
      },
    })
    const synthesisGateway = new CountingSynthesisGateway()
    const synthesizer = new StructuredResearchSynthesizer({
      gateway: synthesisGateway,
      promptVersion: 'feed-v3-e2e-synthesis.v1',
      now: () => new Date(RESEARCH_NOW),
    })
    const researchWorker = new SharedResearchWorker({
      workerId: 'feed-v3-e2e-research-worker', stores: [store], retriever, synthesizer,
      mode: 'active', ownership: 'shared', legacyClaimersActive: false,
      clock: new FixedWorkerClock(RESEARCH_NOW),
    })

    const retrieval = await researchWorker.runOnce()
    assert.deepEqual(retrieval, {
      kind: 'succeeded', stage: 'retrieval', sourceType: 'news', workId: admitted.work.workId,
    })
    assert.equal(store.getResearchWork(admitted.work.workId)?.status, 'synthesis_pending')
    assert.equal(store.getResearchWork(admitted.work.workId)?.attemptCount, 1)

    const synthesis = await researchWorker.runOnce()
    assert.deepEqual(synthesis, {
      kind: 'succeeded', stage: 'synthesis', sourceType: 'news', workId: admitted.work.workId,
    })
    const packet = store.listResearchPacketsByWork(admitted.work.workId, 10)[0]
    assert.ok(packet)
    assert.equal(store.getResearchWork(admitted.work.workId)?.status, 'entity_pending')
    assert.equal(store.getResearchWork(admitted.work.workId)?.attemptCount, 2)
    assert.equal(packet.execution.traceId, admitted.work.traceId)
    assert.equal(packet.execution.provider, 'fake-provider')
    assert.deepEqual(packet.budgetUsed, {
      providerCalls: 1, repairCalls: 0, inputTokens: 321, outputTokens: 87,
      toolCalls: 0, wallTimeMs: 25, budgetExceeded: false,
    })
    assert.equal(synthesisGateway.lastBudget?.maxProviderCalls, admitted.work.budget.maxProviderCalls)
    assert.equal(synthesisGateway.lastBudget?.maxToolCalls, 0)

    const memoryStore = new InMemoryEntityMemoryStore()
    let entityPlannerCalls = 0
    const processor = new EntityServiceCanonicalPacketProcessor({
      store: memoryStore,
      planner: {
        async plan({ admission }) {
          entityPlannerCalls += 1
          const claimId = admission.packet.claims[0]?.claimId
          const evidenceId = admission.packet.evidence[0]?.evidenceId
          assert.ok(claimId && evidenceId)
          return {
            schemaVersion: CANONICAL_ENTITY_PLAN_SCHEMA_VERSION,
            decision: {
              action: 'create_new',
              proposal: {
                slug: 'example-protocol', name: 'Example Protocol', type: 'organization', aliases: ['Example'],
              },
              supportingClaimIds: [claimId], supportingEvidenceIds: [evidenceId],
            },
            memories: [{
              memoryType: 'news_event', memoryRole: 'primary_event',
              representedClaimIds: [claimId], representedEvidenceIds: [evidenceId],
              title: 'Example Protocol version 2 guidance',
              summary: 'Example Protocol published version 2 launch guidance.',
              body: 'The canonical source announcement describes the launch guidance.',
              eventAt: item.publishedAt, confidence: 0.9, mentions: ['Example Protocol'],
            }],
          }
        },
      },
    })
    const entityWorker = new SharedEntityWorker({
      config: sharedEntityWorkerConfig({
        ownership: { news: 'shared' },
        runtimeTopology: { news: { legacyActiveClaimers: 0, sharedActiveClaimers: 1 } },
      }),
      ports: [new SqliteEntityWorkPort(store)],
      processor,
      shadowObservations: { async observe() {} },
      workerId: 'feed-v3-e2e-entity-worker',
      now: () => new Date(ENTITY_NOW),
      leaseId: () => 'feed-v3-e2e-entity-lease',
      heartbeatScheduler: { schedule: () => () => {} },
    })
    const entityResult = await entityWorker.runActiveCycle()
    assert.equal(entityResult.completed, 1)
    assert.equal(store.getResearchWork(admitted.work.workId)?.status, 'complete')
    assert.equal(store.getResearchWork(admitted.work.workId)?.attemptCount, 3)
    assert.equal(memoryStore.entities.length, 1)
    assert.equal(memoryStore.memories.length, 1)
    const memory = memoryStore.memories[0] as EntityMemoryRecord
    assert.match(memory.memory_identity_key ?? '', /^myboon\.memory_identity\.v1:[0-9a-f]{64}$/)
    assert.equal(memory.context.canonical_trace_id, admitted.work.traceId)
    assert.equal(memory.context.canonical_packet_id, packet.packetId)
    const stableMemoryIdentity = memory.memory_identity_key

    const replayed = await intake.process(triageInput(item))
    assert.deepEqual(replayed.persisted, {
      signalInserted: false, decisionInserted: false, workInserted: false,
    })
    assert.deepEqual(await researchWorker.runOnce(), { kind: 'idle' })
    const entityReplay = await entityWorker.runActiveCycle()
    assert.equal(entityReplay.claimed, 0)
    assert.equal(store.listResearchPacketsByWork(admitted.work.workId, 10).length, 1)
    assert.equal(memoryStore.memories.length, 1)
    assert.equal(memoryStore.memories[0]?.memory_identity_key, stableMemoryIdentity)
    assert.equal(networkCalls, 1)
    assert.equal(synthesisGateway.calls, 1)
    assert.equal(entityPlannerCalls, 1)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
