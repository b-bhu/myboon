import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ManagedCanonicalPacketProcessor } from '../entity-manager/managed-canonical-processor'
import type {
  ArticleCommitInput,
  ManagedArticleContext,
  ManagedEntityBinding,
  PostgresKnowledgeOperationWriter,
} from '../entity-manager/postgres-knowledge-writer'
import { deriveProgressionOperationId } from '../entity-manager/progression-processor'
import { SharedEntityWorker } from '../entity-manager/shared-worker'
import { sharedEntityWorkerConfig } from '../entity-manager/shared-worker-config'
import { SqliteEntityPacketWorkPort } from '../entity-manager/sqlite-entity-work-port'
import type { KnowledgeOperationReceipt } from '../entity-manager/knowledge-operation-store'
import type {
  GenerateStructuredRequest,
  InferenceResult,
  InferenceTelemetry,
} from '../inference-gateway'
import type { ClassificationRequest } from '../inference-gateway/classification-types'
import type { ArticleResearchContext } from '../research-gate/managed-context-reader'
import { article308Gateway } from '../research-engine/article-308-fixtures'
import { DeterministicRetriever } from '../research-engine/deterministic-retrieval'
import { SharedResearchWorker, type SharedWorkerClock } from '../research-engine/shared-worker'
import { StructuredResearchSynthesizer, type StructuredSynthesisGateway } from '../research-engine/structured-synthesizer'
import { V4_POLICY, v4ContextReader } from '../research-engine/v4-test-fixtures'
import { isArticleResearchPacket, SIGNAL_SCHEMA_VERSION, type ArticleResearchPacketV1, type Signal } from './contracts'
import { SignalIntakeCoordinator } from './signal-intake'
import { SqliteSignalPlatformStore } from './sqlite-platform-store'
import { createPriorityPolicyV1, RulesFirstTriageEngine } from './triage-engine'
import type { RulesFirstTriageInput } from './triage-contracts'

// #350 (option 2): the live article path end to end. A news article goes
// through retrieval, the V4 Jev article workflow (fake classification gateway,
// fake article context), article prose synthesis (fake structured gateway) and
// the managed Entity commit (fake private writer). Every provider and the
// private SQL writer are fakes; replay idempotency is proven against the fake
// writer's receipt, not real SQL.

const INTAKE_NOW = '2026-08-26T12:00:00.000Z'
const RESEARCH_NOW = '2026-08-26T12:10:00.000Z'
const ENTITY_NOW = '2026-08-26T12:20:00.000Z'
const ARTICLE_URL = 'https://news.example/protocol-v2'
const ARTICLE_TEXT = 'Example Protocol published version 2 launch guidance on its official project site.'
const ENTITY_ID = '6b1d3c1e-5a43-4b7e-9f0a-2f6c1e8d4a10'

class FixedWorkerClock implements SharedWorkerClock {
  constructor(private readonly timestamp: string) {}
  now(): Date { return new Date(this.timestamp) }
  setInterval(): unknown { return 1 }
  clearInterval(): void {}
}

/** Fake prose gateway: only the article timeline-prose call is expected. */
class CountingArticleProseGateway implements StructuredSynthesisGateway {
  calls = 0
  purposes: string[] = []

  async generateStructured<T>(request: GenerateStructuredRequest<T>): Promise<InferenceResult<T>> {
    this.calls += 1
    this.purposes.push(request.purpose)
    assert.equal(request.purpose, 'research.article-timeline-prose')
    assert.ok(request.prompt.includes(ARTICLE_TEXT), 'the article prompt must carry the captured source text')
    const validated = request.validate({
      title: 'Example Protocol publishes version 2 guidance',
      timelineSummary: 'Example Protocol published version 2 launch guidance.',
      body: 'Example Protocol posted version 2 launch guidance on its official project site.',
      entityUpdates: [{
        entity: 'Example Protocol', priorItemId: null,
        itemSummary: 'Example Protocol published its version 2 launch guidance.',
        updatedEntitySummary: 'Example Protocol is preparing its version 2 launch.',
      }],
      eventAt: null,
      completion: 'complete',
    })
    if (!validated.valid) throw new Error(`fake article body failed the production validator: ${(validated.issues ?? []).join('; ')}`)
    return { value: validated.value, telemetry: telemetry(request.promptVersion, request.policyVersion) }
  }
}

function telemetry(promptVersion: string, policyVersion: string): InferenceTelemetry {
  return {
    workload: 'research.synthesis', purpose: 'research.article-timeline-prose', mode: 'generateStructured',
    promptVersion, policyVersion,
    configuredPrimaryProvider: 'fake-provider', configuredPrimaryModel: 'fake-model',
    actualProvider: 'fake-provider', actualModel: 'fake-model',
    fallbackInvoked: false, fallbackReason: null, schemaValid: true,
    providerCalls: 1, repairCalls: 0, inputTokens: 321, outputTokens: 87,
    toolCalls: 0, durationMs: 25, budgetExceeded: false, failureCategory: null, calls: [],
  }
}

/** Bounded article catalogue the research context reader returns: one exact candidate, no history. */
function articleCatalogue(): ArticleResearchContext {
  return {
    candidates: [{ id: ENTITY_ID, name: 'Example Protocol', aliases: ['Example'], summary: 'Example Protocol project.', scope: { category: 'organization' } }],
    historyByEntity: new Map(),
    coverageFailures: [],
  }
}

function entityBinding(): ManagedEntityBinding {
  return {
    id: ENTITY_ID, slug: 'example-protocol', name: 'Example Protocol', type: 'organization', aliases: ['Example'],
    summary: 'Example Protocol project.', status: 'active', show_in_carousel: false, metadata: {},
    revision: 'entity:1', catalogEntityId: ENTITY_ID, identityKey: `catalog:${ENTITY_ID}`,
  }
}

/**
 * In-file fake of the private Postgres writer, cast like
 * managed-canonical-held-failure.test.ts. It keeps an accepted receipt per
 * operation so replay can be checked against it; nothing here is real SQL.
 */
function fakeWriter() {
  const receipts = new Map<string, KnowledgeOperationReceipt>()
  const commits: ArticleCommitInput[] = []
  const savedSources: unknown[] = []
  const calls: string[] = []
  const writer = {
    async findReceipt(operationId: string) { calls.push('findReceipt'); return receipts.get(operationId) ?? null },
    async findPlanningDispatch() { calls.push('findPlanningDispatch'); return null },
    async saveResearchSource(packet: unknown) { calls.push('saveResearchSource'); savedSources.push(packet) },
    async articleContext(): Promise<ManagedArticleContext> {
      calls.push('articleContext')
      return { entities: [entityBinding()], items: [], articleItems: [], digest: 'fake-context-digest', watermark: 'fake-watermark-1', truncated: false, candidateTruncated: false }
    },
    async savePlanningContext() { calls.push('savePlanningContext') },
    async acquireLease(operationId: string, owner: string) { calls.push('acquireLease'); return { operationId, owner, epoch: 1, expiresAt: ENTITY_NOW } },
    async releaseLease() { calls.push('releaseLease'); return true },
    async commitArticle(input: ArticleCommitInput) {
      calls.push('commitArticle')
      commits.push(input)
      const receipt: KnowledgeOperationReceipt = {
        schemaVersion: 'myboon.knowledge_operation_receipt.v2', status: 'accepted',
        operationId: input.operationId, workId: input.workId, attemptDigest: 'a'.repeat(64), planRevision: 1,
        planDigest: 'b'.repeat(64), reason: null, missingDependency: null, retainedGroups: 0, retainedPayload: null,
        owner: input.owner, ownerEpoch: input.epoch, contentDigest: 'c'.repeat(64), committedAt: ENTITY_NOW,
      }
      receipts.set(input.operationId, receipt)
      return { receipt, alreadyAccepted: false }
    },
    async commitArticleHold(input: { reason: string, missingDependency: string }) {
      calls.push('commitArticleHold')
      throw new Error(`unexpected article hold (${input.missingDependency}): ${input.reason}`)
    },
  }
  return { writer: writer as unknown as PostgresKnowledgeOperationWriter, receipts, commits, savedSources, calls }
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
    canonicalUrl: ARTICLE_URL,
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

test('active news article reaches a managed article commit through the V4 Jev workflow and full replay is a no-op', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-v3-e2e-'))
  const store = new SqliteSignalPlatformStore(join(dir, 'news-lane.sqlite'), 'news')
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
      signalInserted: true, decisionInserted: true, dispositionInserted: true, workInserted: true,
    })
    assert.ok(admitted.work)
    const workId = admitted.work.workId
    assert.equal(store.getResearchWork(workId)?.status, 'research_pending')

    let networkCalls = 0
    const retriever = new DeterministicRetriever({
      now: () => new Date(RESEARCH_NOW),
      async fetchDocument(url) {
        networkCalls += 1
        return {
          body: Buffer.from(`<article>${ARTICLE_TEXT}</article>`),
          finalUrl: url, contentType: 'text/html', status: 200, visitedHosts: ['news.example'],
        }
      },
    })
    const proseGateway = new CountingArticleProseGateway()
    const synthesizer = new StructuredResearchSynthesizer({
      gateway: proseGateway,
      promptVersion: 'feed-v3-e2e-synthesis.v1',
      now: () => new Date(RESEARCH_NOW),
    })
    // Fake Jev: confident (0.95) placement on the one candidate, same-topic
    // relationship (no prior-item link) and new information. Floors untouched.
    const jev = article308Gateway({
      placement: { entityId: ENTITY_ID, disposition: 'selected' },
      relationships: { [ENTITY_ID]: { relationship: 'same_topic_only' } },
      novelty: 'new_information',
    })
    let contextReads = 0
    const researchWorker = new SharedResearchWorker({
      workerId: 'feed-v3-e2e-research-worker', stores: [store], retriever, synthesizer,
      mode: 'active', ownership: 'shared', legacyClaimersActive: false,
      clock: new FixedWorkerClock(RESEARCH_NOW),
      v4: {
        ...V4_POLICY,
        sources: new Set(['news'] as const),
        article: {
          // The #308 mock's recordPolicyOutcome is synchronous; the port wants a promise.
          classification: {
            classify: <Value>(request: ClassificationRequest) => jev.gateway.classify<Value>(request),
            async recordPolicyOutcome() {},
          },
          contextReader: () => ({
            ...v4ContextReader(),
            articleContext: async () => { contextReads += 1; return articleCatalogue() },
          }),
        },
      },
    })

    const retrieval = await researchWorker.runOnce()
    assert.deepEqual(retrieval, { kind: 'succeeded', stage: 'retrieval', sourceType: 'news', workId })
    assert.equal(store.getResearchWork(workId)?.status, 'synthesis_pending')
    assert.equal(store.getResearchWork(workId)?.attemptCount, 1)

    const synthesis = await researchWorker.runOnce()
    assert.deepEqual(synthesis, { kind: 'succeeded', stage: 'synthesis', sourceType: 'news', workId },
      `synthesis did not succeed: ${store.getResearchWork(workId)?.failureCategory} ${store.getResearchWork(workId)?.failureDetail}`)
    assert.equal(store.getResearchWork(workId)?.status, 'entity_pending')
    assert.equal(store.getResearchWork(workId)?.attemptCount, 2)
    assert.equal(store.getResearchReadinessByWork(workId)?.outcome, 'ready_for_entity')
    const packets = store.listResearchPacketsByWork(workId, 10)
    assert.equal(packets.length, 1)
    const packet = packets[0]!
    assert.ok(isArticleResearchPacket(packet))
    const article = packet as ArticleResearchPacketV1
    assert.equal(article.sourceType, 'news')
    assert.equal(article.article.sourceUrl, ARTICLE_URL)
    assert.ok(article.article.capturedText.includes(ARTICLE_TEXT))
    assert.deepEqual(article.memberships.map((membership) => [membership.entityId, membership.role, membership.placementDisposition, membership.relationship]),
      [[ENTITY_ID, 'primary', 'selected', 'same_topic_only']])
    assert.equal(article.memberships[0]!.placement.confidence, 0.95)
    assert.equal(article.novelty.choice, 'new_information')
    assert.equal(proseGateway.calls, 1)
    assert.deepEqual(jev.requests.map((request) => request.workload), [
      'research.article_entity_placement', 'research.article_story_relationship', 'research.article_novelty',
    ])
    const jevCalls = jev.requests.length
    assert.equal(contextReads, 1)

    const fake = fakeWriter()
    const port = new SqliteEntityPacketWorkPort(store)
    const processor = new ManagedCanonicalPacketProcessor({
      writer: fake.writer, ports: [port], policyVersion: 'feed-v3-e2e-entity.v1', owner: 'feed-v3-e2e-entity',
      gatewayFactory() { throw new Error('Article persistence must not construct an Entity planning gateway') },
      assertOwnership: () => undefined,
      executeOwned: (_source, action) => action(),
    })
    const entityWorker = new SharedEntityWorker({
      config: sharedEntityWorkerConfig({
        ownership: { news: 'shared' },
        runtimeTopology: { news: { legacyActiveClaimers: 0, sharedActiveClaimers: 1 } },
      }),
      ports: [port],
      processor,
      shadowObservations: { async observe() {} },
      workerId: 'feed-v3-e2e-entity-worker',
      now: () => new Date(ENTITY_NOW),
      leaseId: () => 'feed-v3-e2e-entity-lease',
      heartbeatScheduler: { schedule: () => () => {} },
    })
    const entityResult = await entityWorker.runActiveCycle()
    assert.equal(entityResult.completed, 1,
      `entity did not succeed: ${store.getResearchWork(workId)?.failureCategory} ${store.getResearchWork(workId)?.failureDetail}`)
    assert.equal(store.getResearchWork(workId)?.status, 'complete')
    assert.equal(store.getResearchWork(workId)?.attemptCount, 3)

    // The commitArticle input: the saved packet, one new managed item, the
    // resolved entity, no duplicate target and the writer context.
    const operationId = deriveProgressionOperationId(workId)
    assert.equal(fake.commits.length, 1)
    const commit = fake.commits[0]!
    assert.equal(commit.operationId, operationId)
    assert.equal(commit.workId, workId)
    assert.equal(commit.owner, 'feed-v3-e2e-entity')
    assert.equal(commit.epoch, 1)
    assert.deepEqual(commit.packet, packet)
    assert.match(commit.itemId ?? '', /^[0-9a-f-]{36}$/)
    assert.equal(commit.duplicateTarget, null)
    assert.deepEqual(commit.entities.map((entity) => entity.id), [ENTITY_ID])
    assert.equal(commit.contextWatermark, 'fake-watermark-1')
    assert.deepEqual(commit.targetRevisions, { [ENTITY_ID]: 'entity:1' })
    assert.deepEqual(fake.savedSources, [packet])
    assert.equal(fake.calls.includes('commitArticleHold'), false)
    // The returned receipt is the accepted receipt for this work.
    const receipt = fake.receipts.get(operationId)
    assert.ok(receipt)
    assert.equal(receipt.status, 'accepted')
    assert.equal(receipt.workId, workId)

    // Full replay: intake, research and entity are all no-ops.
    const replayed = await intake.process(triageInput(item))
    assert.deepEqual(replayed.persisted, {
      signalInserted: false, decisionInserted: false, dispositionInserted: false, workInserted: false,
    })
    assert.deepEqual(await researchWorker.runOnce(), { kind: 'idle' })
    const entityReplay = await entityWorker.runActiveCycle()
    assert.equal(entityReplay.claimed, 0)
    // A direct receipt-first replay of the same work reuses the receipt.
    assert.deepEqual(await processor.recoverAccepted(store.getResearchWork(workId)!), { entityTelemetry: null, memoryOutcome: 'written' })
    assert.equal(fake.commits.length, 1, 'replay must not commit the article again')
    assert.equal(fake.receipts.get(operationId), receipt)
    assert.equal(store.listResearchPacketsByWork(workId, 10).length, 1)
    assert.equal(networkCalls, 1)
    assert.equal(proseGateway.calls, 1)
    assert.equal(jev.requests.length, jevCalls)
    assert.equal(contextReads, 1)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
