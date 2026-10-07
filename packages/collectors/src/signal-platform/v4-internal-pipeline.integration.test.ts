import { validateLegacyResearchPacket } from '../signal-platform/validation'
import assert from 'node:assert/strict'
import test from 'node:test'
import { ingestDiscoveredNewsCandidates } from '../news/ingestion'
import { SqliteNewsStore } from '../news/sqlite-store'
import { SqlitePipelineStore } from '../pipeline-store/sqlite-store'
import { SharedResearchWorker } from '../research-engine/shared-worker'
import { DeterministicRetriever } from '../research-engine/deterministic-retrieval'
import { V4_POLICY, V4_FOLLOWUP_POLICY, V4Synthesizer, v4Packet, v4Classifier, v4Clock, v4Signal } from '../research-engine/v4-test-fixtures'
import { InternalResearchEntityMemoryReader } from '../research-gate/managed-context-reader'
import { IsolatedEntityPostgres } from '../entity-manager/isolated-postgres.test-support'
import { ACME_ID } from '../entity-manager/managed-v4.test-support'
import { ManagedCanonicalPacketProcessor } from '../entity-manager/managed-canonical-processor'
import type { PostgresKnowledgeOperationWriter } from '../entity-manager/postgres-knowledge-writer'
import { SharedEntityWorker, type EntityPacketWorkPort } from '../entity-manager/shared-worker'
import { SqliteEntityPacketWorkPort } from '../entity-manager/sqlite-entity-work-port'
import { sharedEntityWorkerConfig } from '../entity-manager/shared-worker-config'
import { deriveProgressionOperationId } from '../entity-manager/progression-processor'
import type { InferenceTelemetry } from '../inference-gateway'
import { RESEARCH_NOVELTY_WORKLOAD } from '../inference-gateway'
import type { Signal, ResearchWorkItem } from './contracts'
import { CanonicalSourceSignalIntake, type SourceSignalIntakePort } from './source-intake'
import { createPriorityPolicyV1, RulesFirstTriageEngine } from './triage-engine'
import type { TriageCapacitySnapshot } from './triage-contracts'
import { drainSourceDeliveries } from './source-delivery-outbox'
import { SqliteSignalPlatformStore } from './sqlite-platform-store'
import { requireSourceOwnership, sourceOwnershipAllows, withSourceOwnershipOperation } from './source-ownership'
import { operationsFixture, observationInput, OPERATIONS_NOW, withIsolatedV4Environment } from './v4-operations.test-support'

type SourceFixture = ReturnType<typeof operationsFixture>

function capacity(): TriageCapacitySnapshot {
  const bucket = { available: 10, reservedAvailable: 2, utilization: 0 }
  return { byPriority: { P0: bucket, P1: bucket, P2: bucket, P3: bucket },
    byDepth: { light: bucket, standard: bucket, deep: bucket } }
}

function intake(fixture: SourceFixture) {
  const engine = new RulesFirstTriageEngine({ policy: createPriorityPolicyV1({
    policyVersion: 'isolated-chain.triage.v1', budgetPolicyVersion: 'isolated-chain.budget.v1',
  }) })
  let decisions = 0
  const workIds = new Set<string>()
  const canonical = new CanonicalSourceSignalIntake({ mode: 'active', store: fixture.store,
    triage: { async decide(input) { decisions += 1; return engine.decide(input) } },
    retrievalPolicy: { policyVersion: 'isolated-chain.retrieval.v1',
      allowedDomains: ['example.com', 'issuer.example', 'regulator.example'],
      maxExternalSourcesByDepth: { light: 1, standard: 1, deep: 1 } },
    decisionPolicy: { priorityPolicyVersion: 'isolated-chain.triage.v1', budgetPolicyVersion: 'isolated-chain.budget.v1' },
    mayAdmit: () => sourceOwnershipAllows({ databasePath: fixture.path, source: fixture.source, domain: 'intake', owner: 'shared' }),
    buildTriageInput: async (signal) => ({ signal, now: OPERATIONS_NOW, sourceAuthorityScore: 0.9, officialSource: true,
      dedupeOutcome: 'new_observation', novelty: 'material', entityCanonOverlap: true, materialityTags: ['market_material'],
      eventDeadline: null, providerHealth: 'healthy', capacity: capacity(), ambiguity: { isAmbiguous: false, reasons: [] }, deepEscalation: null }),
  })
  const port: SourceSignalIntakePort = { mode: 'active', async ingest(signal) {
    const result = await canonical.ingest(signal)
    if (result.work) workIds.add(result.work.workId)
    return result
  } }
  return { port, workIds, decisions: () => decisions }
}

function telemetry(): InferenceTelemetry {
  return { workload: 'entity.extract', purpose: 'isolated-chain.entity', mode: 'generateStructured',
    promptVersion: 'isolated-chain.v1', policyVersion: 'isolated-chain.v1',
    configuredPrimaryProvider: 'offline-fixture', configuredPrimaryModel: 'offline-fixture', actualProvider: 'offline-fixture', actualModel: 'offline-fixture',
    fallbackInvoked: false, fallbackReason: null, schemaValid: true, providerCalls: 1, repairCalls: 0,
    inputTokens: 100, outputTokens: 50, toolCalls: 0, costUsdMicros: null, durationMs: 1, budgetExceeded: false, failureCategory: null, calls: [] }
}

function research(fixture: SourceFixture, writer: PostgresKnowledgeOperationWriter, alreadyKnown = false) {
  const synth = new V4Synthesizer((input) => {
    const packet = v4Packet(input)
    const claim = { ...validateLegacyResearchPacket(packet).claims[0], claim: 'Acme says a product launches Friday.', attributedTo: 'Acme' }
    return { ...packet, claims: [claim], observedAt: input.signal.observedAt, createdAt: OPERATIONS_NOW,
      entityHints: [{ name: 'Acme', type: 'organization', role: 'subject', aliases: [], source: 'synthesis', claimRefs: [claim.claimId], evidenceRefs: claim.evidenceRefs }] }
  })
  const classifier = v4Classifier((request) => request.workload === RESEARCH_NOVELTY_WORKLOAD
    ? { verdict: alreadyKnown ? 'already_known' : 'new_information', reason: alreadyKnown
      ? 'The complete captured fixture statement is represented in the supplied private knowledge.'
      : 'Isolated fixture supplies new attributed information.' }
    : { direction: 'not_worthwhile', reason: 'No admitted follow-up is useful in this fixture.' })
  const reader = (signal: Signal) => new InternalResearchEntityMemoryReader({
    legacy: { entityIdsForSourceRef: async () => [], entitiesByIds: async () => [], recentMemories: async () => [] },
    managed: writer, source: signal.sourceType, sourceRefs: [signal.sourceId, signal.canonicalUrl!], labels: ['Acme'],
  })
  const worker = new SharedResearchWorker({ workerId: 'isolated-chain-research', stores: [fixture.store],
    mode: 'active', ownership: 'shared', legacyClaimersActive: false, clock: v4Clock(OPERATIONS_NOW),
    stages: ['retrieval', 'synthesis'], synthesizer: synth,
    retriever: new DeterministicRetriever({ now: () => new Date(OPERATIONS_NOW), fetchDocument: async (url) => ({
      body: Buffer.from('Acme says a product launches Friday.'), finalUrl: url, contentType: 'text/plain', status: 200, visitedHosts: [] }) }),
    standardSearch: { async discover() { return { policyVersion: 'isolated-chain.search.v1', connectorId: 'offline', queryCount: 0, urls: [] } } },
    mayExecuteWork: () => sourceOwnershipAllows({ databasePath: fixture.path, source: fixture.source, domain: 'research', owner: 'shared' }),
    v4: { ...V4_POLICY, contextReader: reader, novelty: { classification: classifier.port, reader },
      followup: { classification: classifier.port, policy: V4_FOLLOWUP_POLICY } },
  })
  return { worker, synth, classifier }
}

function entity(fixture: SourceFixture, writer: PostgresKnowledgeOperationWriter, port: EntityPacketWorkPort,
  work: ResearchWorkItem, onPlan: () => void, now = OPERATIONS_NOW, providersAvailable = true) {
  const processor = new ManagedCanonicalPacketProcessor({ writer, ports: [port], owner: 'isolated-chain-entity', policyVersion: 'isolated-chain.v1',
    assertOwnership: () => requireSourceOwnership({ databasePath: fixture.path, source: fixture.source, domain: 'entity', owner: 'shared' }),
    executeOwned: (_source, action) => withSourceOwnershipOperation({ databasePath: fixture.path, source: fixture.source, domain: 'entity', owner: 'shared' }, action),
    gatewayFactory() {
      if (!providersAvailable) throw new Error('Recovered accepted work must not construct providers')
      return { resolveRoute: () => ({ primary: { provider: 'offline-fixture', model: 'offline-fixture' } }),
        async generateStructured<Value>() {
          onPlan()
          const packet = fixture.store.listResearchPacketsByWork(work.workId, 1)[0]
          return { value: { kind: 'apply', drafts: [{ localKey: 'development', candidateId: null, note: validateLegacyResearchPacket(packet).claims[0].claim,
            entityLinks: [{ candidateEntityRef: ACME_ID, role: 'subject' }], continuityLinks: [],
            evidenceRefs: [{ claimId: validateLegacyResearchPacket(packet).claims[0].claimId, evidenceId: validateLegacyResearchPacket(packet).evidence[0].evidenceId, sourceRef: validateLegacyResearchPacket(packet).evidence[0].url }] }], operations: [] } as Value,
          telemetry: telemetry() }
        } }
    },
  })
  return new SharedEntityWorker({ config: sharedEntityWorkerConfig({ ownership: { [fixture.source]: 'shared' },
    runtimeTopology: { [fixture.source]: { legacyActiveClaimers: 0, sharedActiveClaimers: 1 } } }),
    ports: [port], processor, shadowObservations: { async observe() {} }, workerId: 'isolated-chain-entity', now: () => new Date(now),
    heartbeatScheduler: { schedule: () => () => undefined },
  })
}

test('isolated internal pipeline preserves source delivery, paid results and private receipts across restarts', {
  skip: process.env.ENTITY_V4_RUN_POSTGRES_TESTS !== '1', timeout: 180_000,
}, async (t) => {
  const restoreEnvironment = withIsolatedV4Environment()
  const news = operationsFixture('news')
  const poly = operationsFixture('polymarket')
  const database = new IsolatedEntityPostgres()
  let writer: PostgresKnowledgeOperationWriter | undefined
  let reopened: SqliteSignalPlatformStore | undefined
  try {
    await database.start(); await database.migrate(); writer = database.writer()
    news.run(news.receipt('initialize'))
    const newsReceipt = news.receipt('resume_shared')
    const executedNews = news.run(newsReceipt)
    poly.run(poly.receipt('initialize'))
    poly.run(poly.receipt('resume_shared', { newsReceipt: { databasePath: news.path, receiptId: newsReceipt.receipt.receiptId, receiptSha256: executedNews.evidenceSha256 } }))
    const sourceIntake = intake(news)
    const discovery = observationInput('internal-chain')
    discovery.candidate.headline = 'Acme says a product launches Friday'
    const discoveries = [{ source: discovery.source, sourceUrl: discovery.sourceUrl, candidate: discovery.candidate, observedAt: OPERATIONS_NOW }]
    await t.test('Scout lost acknowledgement and unchanged poll recover one saved admission', async () => {
      const lostAckStore = new Proxy(news.legacy as SqliteNewsStore, { get(target, key) {
        if (key === 'markSourceDeliveryDelivered') return async () => { throw new Error('Fixture lost source acknowledgement') }
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
      } })
      const first = await ingestDiscoveredNewsCandidates({ store: lostAckStore, discoveries, signalIntake: sourceIntake.port })
      assert.equal(first.delivery.failures.length, 1)
      assert.equal((await news.legacy.listPendingSourceDeliveries(10)).length, 1)
      assert.equal(sourceIntake.workIds.size, 1)
      const replay = await ingestDiscoveredNewsCandidates({ store: news.legacy as SqliteNewsStore, discoveries, signalIntake: sourceIntake.port })
      assert.equal(replay.drainedBeforeFeed.delivered, 0)
      assert.equal(replay.drainedBeforeFeed.duplicateDeliveries, 1)
      assert.equal((await news.legacy.listPendingSourceDeliveries(10)).length, 0)
      assert.equal(sourceIntake.workIds.size, 1)
      assert.equal(sourceIntake.decisions(), 1)
    })
    const workId = [...sourceIntake.workIds][0]
    await t.test('actual Research persists attributable partial readiness and durable decision exposure', async () => {
      const run = research(news, writer!)
      assert.equal((await run.worker.runOnce()).kind, 'succeeded')
      assert.equal((await run.worker.runOnce()).kind, 'succeeded')
      assert.equal(news.store.getResearchWork(workId)?.status, 'entity_pending')
      assert.equal(news.store.getResearchReadinessByWork(workId)?.outcome, 'ready_for_entity')
      const packet = news.store.listResearchPacketsByWork(workId, 1)[0]
      assert.equal(packet.completion, 'partial'); assert.equal(validateLegacyResearchPacket(packet).claims[0].attributedTo, 'Acme')
      assert.deepEqual(packet.verifiedFacts, []); assert.equal(run.synth.inputs.length, 1)
      assert.ok(news.store.listResearchReservations(100).every((record) => record.state === 'settled'))
    })
    let plans = 0
    let receipt: unknown
    await t.test('private commit survives lost SQLite completion acknowledgement', async () => {
      const port = new SqliteEntityPacketWorkPort(news.store)
      const lostAck = new Proxy(port, { get(target, key) {
        if (key === 'transitionLeased') return async () => false
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
      } })
      const result = await entity(news, writer!, lostAck, news.store.getResearchWork(workId)!, () => { plans += 1 }).runActiveCycle()
      assert.equal(result.staleLeases, 1)
      assert.equal(news.store.getResearchWork(workId)?.status, 'entity_leased')
      receipt = await writer!.findReceipt(deriveProgressionOperationId(workId))
      assert.ok(receipt); assert.equal(plans, 1)
      assert.equal((await writer!.researchContext({ labels: ['Acme'] })).items.length, 1)
    })
    await t.test('database/client restart completes from receipt before hydration or provider configuration', async () => {
      news.store.close(); reopened = new SqliteSignalPlatformStore(news.path, 'news')
      await reopened.recoverExpiredLeases({ now: '2026-10-03T09:02:00.000Z', limit: 10 })
      await writer!.close(); await database.restart(); writer = database.writer()
      const port = new Proxy(new SqliteEntityPacketWorkPort(reopened), { get(target, key) {
        if (key === 'readResearchPacket' || key === 'readHandoffContext') return async () => { throw new Error('Receipt replay must not hydrate packets') }
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
      } })
      const liveFixture = { ...news, store: reopened }
      const result = await entity(liveFixture, writer!, port, reopened.getResearchWork(workId)!, () => { plans += 1 }, '2026-10-03T09:02:00.000Z', false).runActiveCycle()
      assert.equal(result.completed, 1); assert.equal(reopened.getResearchWork(workId)?.status, 'complete')
      assert.equal(plans, 1)
      assert.deepEqual(await writer!.findReceipt(deriveProgressionOperationId(workId)), receipt)
      assert.equal((await writer!.researchContext({ labels: ['Acme'] })).items.length, 1)
    })
    await t.test('Polymarket source obligation traverses actual Research and private Entity under exclusive ownership', async () => {
      const sourceIntake = intake(poly)
      const signal = { ...v4Signal('polymarket', 'internal-chain'), title: 'Acme says a product launches Friday',
        observedAt: OPERATIONS_NOW, publishedAt: OPERATIONS_NOW, sourceHints: { entities: ['Acme'], assets: [], eventId: 'fixture-market', deadline: null } } as Signal
      const native = poly.legacy as SqlitePipelineStore
      await native.commitWatchlistAndSourceDeliveries([], [{ signal, observedAt: OPERATIONS_NOW }])
      assert.equal((await drainSourceDeliveries({ store: native, intake: sourceIntake.port })).delivered, 1)
      const polyWorkId = [...sourceIntake.workIds][0]
      const run = research(poly, writer!)
      assert.equal((await run.worker.runOnce()).kind, 'succeeded')
      assert.equal((await run.worker.runOnce()).kind, 'succeeded')
      const result = await entity(poly, writer!, new SqliteEntityPacketWorkPort(poly.store), poly.store.getResearchWork(polyWorkId)!, () => { plans += 1 }).runActiveCycle()
      assert.equal(result.completed, 1); assert.equal(poly.store.getResearchWork(polyWorkId)?.status, 'complete')
      assert.ok(await writer!.findReceipt(deriveProgressionOperationId(polyWorkId)))
      assert.equal(plans, 2); assert.equal(run.synth.inputs.length, 1)
      assert.equal((await writer!.researchContext({ labels: ['Acme'] })).items.length, 2)
    })
    await t.test('complete known observation uses actual private context, retains evidence and spends no synthesis or follow-up', async () => {
      const liveFixture = { ...news, store: reopened! }
      const sourceIntake = intake(liveFixture)
      const signal = { ...v4Signal('news', 'known-internal-chain'), title: 'Acme says a product launches Friday',
        observedAt: OPERATIONS_NOW, publishedAt: OPERATIONS_NOW,
        sourceHints: { entities: ['Acme'], assets: [], eventId: null, deadline: null } } as Signal
      await sourceIntake.port.ingest(signal)
      const knownWorkId = [...sourceIntake.workIds][0]
      const run = research(liveFixture, writer!, true)
      assert.equal((await run.worker.runOnce()).kind, 'succeeded')
      assert.equal((await run.worker.runOnce()).kind, 'succeeded')
      assert.equal(reopened!.getResearchWork(knownWorkId)?.status, 'complete', JSON.stringify(
        reopened!.getResearchV4Record('novelty', knownWorkId, 'decision')))
      const readiness = reopened!.getResearchReadinessByWork(knownWorkId)!
      assert.equal(readiness.outcome, 'resolved_without_new_item')
      assert.equal(readiness.entityAction.kind, 'none')
      const packet = reopened!.listResearchPacketsByWork(knownWorkId, 1)[0]
      assert.ok(packet.knownObservationResolution)
      assert.ok(reopened!.listEvidenceByWork(knownWorkId, 10).length > 0)
      assert.deepEqual(packet.claims, []); assert.deepEqual(packet.verifiedFacts, [])
      assert.equal(run.synth.inputs.length, 0)
      assert.equal(run.classifier.requests.length, 1)
      assert.equal(await writer!.findReceipt(deriveProgressionOperationId(knownWorkId)), null)
      assert.equal((await writer!.researchContext({ labels: ['Acme'] })).items.length, 2)
      assert.equal(plans, 2)
    })
  } finally {
    reopened?.close(); await writer?.close(); await database.close()
    news.dispose(); poly.dispose(); restoreEnvironment()
  }
})
