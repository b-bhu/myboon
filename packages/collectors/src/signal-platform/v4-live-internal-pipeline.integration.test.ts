import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse as parseEnv } from 'dotenv'
import { HermesService } from '../hermes'
import {
  ClassificationGateway, HermesDecisionAdapter, JevSystemOneAdapter,
  SqliteClassificationControlPlane, StaticClassificationRegistry,
  createConfiguredInferenceGateway, researchNoveltyDefinition, researchFollowupValueDefinition,
  type InferenceTelemetry,
} from '../inference-gateway'
import { ingestDiscoveredNewsCandidates } from '../news/ingestion'
import type { NewsCandidate } from '../news/types'
import type { SqliteNewsStore } from '../news/sqlite-store'
import type { SqlitePipelineStore } from '../pipeline-store/sqlite-store'
import { SharedResearchWorker } from '../research-engine/shared-worker'
import { StructuredResearchSynthesizer } from '../research-engine/structured-synthesizer'
import { DeterministicRetriever, type RetrievedEvidenceArtifact } from '../research-engine/deterministic-retrieval'
import { InternalResearchEntityMemoryReader } from '../research-gate/managed-context-reader'
import { IsolatedEntityPostgres } from '../entity-manager/isolated-postgres.test-support'
import { ManagedCanonicalPacketProcessor } from '../entity-manager/managed-canonical-processor'
import type { PostgresKnowledgeOperationWriter } from '../entity-manager/postgres-knowledge-writer'
import { SharedEntityWorker, type EntityPacketWorkPort } from '../entity-manager/shared-worker'
import { SqliteEntityPacketWorkPort } from '../entity-manager/sqlite-entity-work-port'
import { sharedEntityWorkerConfig } from '../entity-manager/shared-worker-config'
import { deriveProgressionOperationId } from '../entity-manager/progression-processor'
import { canonicalJson } from './canonical-json'
import { assessResearchReadiness } from './research-readiness'
import { adaptRetrievedEvidenceArtifact } from './retrieved-evidence-adapter'
import type { Signal, ResearchPacketV1, ResearchWorkItem } from './contracts'
import { CanonicalSourceSignalIntake, type SourceSignalIntakePort } from './source-intake'
import { createPriorityPolicyV1, RulesFirstTriageEngine } from './triage-engine'
import { drainSourceDeliveries } from './source-delivery-outbox'
import { SqliteSignalPlatformStore } from './sqlite-platform-store'
import { requireSourceOwnership, sourceOwnershipAllows, withSourceOwnershipOperation } from './source-ownership'
import { operationsFixture, withIsolatedV4Environment } from './v4-operations.test-support'

type SourceFixture = ReturnType<typeof operationsFixture>
interface LiveCase {
  caseId: string
  sourceType: 'news' | 'polymarket'
  signal: Signal
  body: string
  bodySha256: string
  evidenceCapturedAt: string
  capturedEvidence: RetrievedEvidenceArtifact[]
  nativeObservation: { source_id: string, raw_candidate: NewsCandidate } | null
  coverage: { fullArticleCompletenessVerified: false, originalFreshnessPreserved: true }
}
interface CatalogueEntity {
  id: string, slug: string, name: string, type: string, aliases: unknown,
  summary: string | null, status: string, created_at: string, updated_at: string,
}

const ROUTE = { provider: 'ollama-cloud', model: 'glm-5.3-flash' }
const PROFILE = 'myboon-codex-production'
const POLICY = 'myboon.v4_live_internal_evaluation.20261003'
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
function privateJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  chmodSync(path, 0o600)
}
function environment(): Record<string, string | undefined> {
  const repository = resolve(__dirname, '../../../..')
  const env: Record<string, string | undefined> = {}
  for (const file of [join(repository, '.env'), join(repository, 'packages/collectors/.env')]) {
    if (existsSync(file)) Object.assign(env, parseEnv(readFileSync(file)))
  }
  Object.assign(env, process.env)
  env.INFERENCE_GATEWAY_PRIMARY_PROVIDER = ROUTE.provider
  env.INFERENCE_GATEWAY_PRIMARY_MODEL = ROUTE.model
  env.INFERENCE_GATEWAY_HERMES_PROFILE = PROFILE
  delete env.INFERENCE_GATEWAY_OPENROUTER_FALLBACK_MODEL
  return env
}

function intake(fixture: SourceFixture, historicalNow: string): {
  port: SourceSignalIntakePort, workIds: Set<string>, decisions(): number,
} {
  const workIds = new Set<string>()
  let decisions = 0
  const triage = new RulesFirstTriageEngine({ policy: createPriorityPolicyV1({
    policyVersion: POLICY + '.triage', budgetPolicyVersion: POLICY + '.budget',
  }) })
  const canonical = new CanonicalSourceSignalIntake({ mode: 'active', store: fixture.store,
    triage: { async decide(input) { decisions += 1; return triage.decide(input) } },
    retrievalPolicy: { policyVersion: POLICY + '.retrieval', allowedDomains: ['x.com', 'polymarket.com'],
      maxExternalSourcesByDepth: { light: 0, standard: 0, deep: 0 } },
    decisionPolicy: { priorityPolicyVersion: POLICY + '.triage', budgetPolicyVersion: POLICY + '.budget' },
    mayAdmit: () => sourceOwnershipAllows({ databasePath: fixture.path, source: fixture.source, domain: 'intake', owner: 'shared' }),
    // Explicit historical light-evaluation admission; this does not evaluate
    // production urgency, approve current freshness or replace a source policy.
    buildTriageInput: async (signal) => ({ signal, now: historicalNow, sourceAuthorityScore: 0.6,
      officialSource: false, dedupeOutcome: 'new_observation', novelty: 'low', entityCanonOverlap: false,
      materialityTags: [], eventDeadline: signal.sourceHints.deadline, providerHealth: 'healthy',
      capacity: { byPriority: { P0: bucket(), P1: bucket(), P2: bucket(), P3: bucket() },
        byDepth: { light: bucket(), standard: bucket(), deep: bucket() } },
      ambiguity: { isAmbiguous: false, reasons: [] }, deepEscalation: null }),
  })
  return { workIds, decisions: () => decisions,
    port: { mode: 'active', async ingest(signal) {
      const result = await canonical.ingest(signal)
      if (result.work) workIds.add(result.work.workId)
      return result
    } } }
}
function bucket() { return { available: 10, reservedAvailable: 2, utilization: 0 } }

/** The only retrieval injection: retained bytes, never current HTTP/browser IO. */
function historicalRetriever(source: LiveCase, artifactDirectory: string): DeterministicRetriever {
  const native = source.sourceType === 'polymarket'
  const envelope = {
    kind: native ? 'historical-replay.native-observation' : 'historical-replay.retained-source-text',
    currentNetworkFetch: false, fullArticleCompletenessVerified: false,
    originalObservedAt: source.signal.observedAt, originalPublishedAt: source.signal.publishedAt,
    originalEvidenceCapturedAt: native ? null : source.evidenceCapturedAt,
    sourceUrl: source.signal.canonicalUrl,
    limitation: native
      ? 'Archived native odds observation only; no Polymarket page was fetched. These odds are not a current price or a resolved market result.'
      : 'Exported historical source text only; the original HTML and full article completeness are not established.',
    capturedMaterial: native ? source.signal.content : source.body,
  }
  privateJson(join(artifactDirectory, source.caseId + '.retrieval-envelope.json'), envelope)
  const text = canonicalJson(envelope)
  return new DeterministicRetriever({
    now: () => new Date(native ? source.signal.observedAt : source.evidenceCapturedAt),
    async fetchDocument(url) {
      assert.equal(url, source.signal.canonicalUrl, 'No new source may be fetched in this retained-capture evaluation')
      return { body: Buffer.from(text), finalUrl: url, contentType: 'text/plain', status: 200, visitedHosts: [] }
    },
  })
}

function entityWorker(fixture: SourceFixture, writer: PostgresKnowledgeOperationWriter, port: EntityPacketWorkPort,
  gateway: ReturnType<typeof createConfiguredInferenceGateway>['gateway'], historicalNow: string,
  unavailable = false): SharedEntityWorker {
  const processor = new ManagedCanonicalPacketProcessor({ writer, ports: [port], owner: 'live-isolated-entity', policyVersion: POLICY,
    assertOwnership: () => requireSourceOwnership({ databasePath: fixture.path, source: fixture.source, domain: 'entity', owner: 'shared' }),
    executeOwned: (_source, action) => withSourceOwnershipOperation({ databasePath: fixture.path, source: fixture.source, domain: 'entity', owner: 'shared' }, action),
    gatewayFactory() {
      assert.equal(unavailable, false, 'Accepted receipt recovery must not construct any provider')
      return gateway
    },
  })
  return new SharedEntityWorker({ config: sharedEntityWorkerConfig({ ownership: { [fixture.source]: 'shared' },
    runtimeTopology: { [fixture.source]: { legacyActiveClaimers: 0, sharedActiveClaimers: 1 } } }),
    ports: [port], processor, shadowObservations: { async observe() {} }, workerId: 'live-isolated-entity',
    now: () => new Date(historicalNow), heartbeatScheduler: { schedule: () => () => undefined },
  })
}

test('opt-in real providers traverse the isolated historical internal Research and managed Entity chain', {
  skip: process.env.ENTITY_V4_RUN_LIVE_INTERNAL_PIPELINE !== '1', timeout: 600_000,
}, async (t) => {
  const root = '/tmp/myboon-v4-live-20261003'
  const casesFile = join(root, 'internal-chain-source-cases.json')
  const cases: LiveCase[] = JSON.parse(readFileSync(casesFile, 'utf8')).cases
  const negativeOnly = process.env.ENTITY_V4_LIVE_INTERNAL_CASES === 'negative'
  assert.ok(process.env.ENTITY_V4_LIVE_INTERNAL_CASES === undefined || negativeOnly,
    'Optional case selection only supports the separately replayable negative probe')
  assert.deepEqual(cases.map((entry) => entry.sourceType).sort(), ['news', 'polymarket'])
  for (const source of cases) {
    assert.equal(sha(source.body), source.bodySha256)
    assert.equal(source.coverage.fullArticleCompletenessVerified, false)
    assert.equal(source.coverage.originalFreshnessPreserved, true)
  }
  const directory = join(root, 'internal-chain-live-' + randomUUID())
  mkdirSync(directory, { mode: 0o700 }); chmodSync(directory, 0o700)
  const env = environment()
  assert.ok(env.JEV_API_TOKEN?.trim(), 'A real Jev token must be configured even when empty knowledge bypasses classification')
  const restore = withIsolatedV4Environment()
  const news = operationsFixture('news'), poly = operationsFixture('polymarket')
  const database = new IsolatedEntityPostgres()
  let writer: PostgresKnowledgeOperationWriter | undefined
  const reopened: SqliteSignalPlatformStore[] = []
  const telemetry: InferenceTelemetry[] = []
  const classification = new SqliteClassificationControlPlane(join(directory, 'classification.sqlite'))
  const service = new HermesService()
  let providerDispatches = 0
  let jevDispatches = 0
  const measuredCalls: Array<Record<string, unknown>> = []
  const outcomes: Array<Record<string, unknown>> = []
  const measuredService: Pick<HermesService, 'oneshot'> = { async oneshot(request) {
    // This is a reproducible execution limit, not a price allowance. Unknown
    // production dispatches remain held in the actual durable processor.
    assert.ok(providerDispatches < 12, 'Live internal evaluation dispatch ceiling reached')
    const call = ++providerDispatches
    const prefix = join(directory, `hermes-${call}`)
    privateJson(prefix + '.dispatch.json', { state: 'dispatch_intent', purpose: request.purpose,
      provider: request.provider, model: request.model, profile: request.profile,
      promptDigest: sha(request.prompt), promptChars: request.prompt.length, startedAt: new Date().toISOString() })
    privateJson(prefix + '.cli-usage.json', {})
    try {
      const result = await service.oneshot({ ...request, usageFilePath: prefix + '.cli-usage.json' })
      privateJson(prefix + '.response.json', { state: 'saved_response', ...result, savedAt: new Date().toISOString() })
      const usage = JSON.parse(readFileSync(prefix + '.cli-usage.json', 'utf8'))
      measuredCalls.push({ call, purpose: request.purpose, usage, state: 'saved_response' })
      return result
    } catch (error) {
      privateJson(prefix + '.response.json', { state: 'execution_outcome_unknown', error: String(error), savedAt: new Date().toISOString() })
      measuredCalls.push({ call, purpose: request.purpose, state: 'execution_outcome_unknown' })
      throw error
    } finally { chmodSync(prefix + '.cli-usage.json', 0o600) }
  } }
  const runtime = createConfiguredInferenceGateway({ env, serviceFactory: () => measuredService,
    observer: (event) => { telemetry.push(event); privateJson(join(directory, 'gateway-telemetry.json'), telemetry) } })
  // Sampling is evaluation-local. The provider/model matches the approved
  // subscription route; production lifecycle and confidence thresholds stay intact.
  const definitions = [researchNoveltyDefinition(ROUTE), researchFollowupValueDefinition(ROUTE)]
    .map((definition) => ({ ...definition, canaryPercent: 100, defaultLifecycleMode: 'canary' as const }))
  const decisions = new ClassificationGateway({ registry: new StaticClassificationRegistry(definitions),
    capacity: classification, audit: classification,
    jev: new JevSystemOneAdapter({ apiToken: env.JEV_API_TOKEN!, fetchImpl: async (input, init) => {
      assert.ok(jevDispatches < 4, 'Live Jev evaluation dispatch ceiling reached')
      const call = ++jevDispatches
      privateJson(join(directory, `jev-${call}.dispatch.json`), { state: 'dispatch_intent', startedAt: new Date().toISOString() })
      const response = await fetch(input, init)
      privateJson(join(directory, `jev-${call}.response.json`), { status: response.status, body: await response.clone().text() })
      return response
    } }), hermes: new HermesDecisionAdapter({ service: measuredService, profile: PROFILE }) })
  privateJson(join(directory, 'run.json'), { schemaVersion: 'myboon.v4_live_internal_rehearsal.v1',
    startedAt: new Date().toISOString(), casesSha256: sha(readFileSync(casesFile, 'utf8')),
    route: ROUTE, profile: PROFILE, evaluationOnlyRoute: true, maxHermesDispatches: 12, maxJevDispatches: 4,
    historicalReplay: true, hostedWrites: false, downstreamConsumers: false, negativeOnly,
    catalogueSha256: sha(readFileSync(join(root, 'chain-entities.json'), 'utf8')) })
  try {
    await database.start()
    await database.admin.query(readFileSync(join(root, 'catalog.sql'), 'utf8'))
    await database.migrate({ nonSuperuserAdmin: true })
    const catalogue: CatalogueEntity[] = JSON.parse(readFileSync(join(root, 'chain-entities.json'), 'utf8'))
    for (const row of catalogue) await database.admin.query(
      'insert into public.entities(id,slug,name,type,aliases,summary,status,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [row.id,row.slug,row.name,row.type,JSON.stringify(row.aliases),row.summary,row.status,row.created_at,row.updated_at])
    writer = database.writer()
    news.run(news.receipt('initialize'))
    const newsReceipt = news.receipt('resume_shared'), executedNews = news.run(newsReceipt)
    poly.run(poly.receipt('initialize'))
    poly.run(poly.receipt('resume_shared', { newsReceipt: { databasePath: news.path,
      receiptId: newsReceipt.receipt.receiptId, receiptSha256: executedNews.evidenceSha256 } }))
    for (const source of negativeOnly ? [] : cases) await t.test(source.caseId + ' natural real-provider outcome and receipt recovery', async () => {
      const fixture = source.sourceType === 'news' ? news : poly
      const historicalNow = source.sourceType === 'news' ? source.evidenceCapturedAt : source.signal.observedAt
      const admission = intake(fixture, historicalNow)
      if (source.sourceType === 'news') {
        assert.ok(source.nativeObservation)
        const discovery = { source: { sourceId: source.nativeObservation.source_id, sourceName: source.signal.provenance.upstreamSource!, sourceType: 'curated_news' as const },
          sourceUrl: { urlId: 'feed', label: 'retained historical feed', url: source.signal.canonicalUrl! },
          candidate: source.nativeObservation.raw_candidate, observedAt: source.signal.observedAt }
        const deliveries = await ingestDiscoveredNewsCandidates({ store: fixture.legacy as SqliteNewsStore,
          discoveries: [discovery], signalIntake: admission.port })
        assert.equal(deliveries.delivery.failures.length, 0)
      } else {
        await (fixture.legacy as SqlitePipelineStore).commitWatchlistAndSourceDeliveries([], [{ signal: source.signal, observedAt: source.signal.observedAt }])
        assert.equal((await drainSourceDeliveries({ store: fixture.legacy, intake: admission.port })).delivered, 1)
      }
      assert.equal(admission.workIds.size, 1)
      assert.equal(admission.decisions(), 1)
      const workId = [...admission.workIds][0]
      const work = fixture.store.getResearchWork(workId)!
      assert.equal(work.researchDepth, 'light')
      const signal = fixture.store.getSignal(work.signalId)!
      assert.equal(signal.observedAt, source.signal.observedAt)
      assert.equal(signal.publishedAt, source.signal.publishedAt)
      assert.deepEqual(signal.provenance, source.signal.provenance)
      const reader = (input: Signal) => new InternalResearchEntityMemoryReader({ legacy: {
        entityIdsForSourceRef: async () => [], entitiesByIds: async () => [], recentMemories: async () => [],
      }, managed: writer!, source: input.sourceType, sourceRefs: [input.sourceId,input.canonicalUrl!], labels: input.sourceHints.entities })
      const synthesizer = new StructuredResearchSynthesizer({ gateway: runtime.gateway, promptVersion: POLICY + '.synthesis', now: () => new Date(historicalNow) })
      const research = new SharedResearchWorker({ workerId: 'live-isolated-research', stores: [fixture.store],
        mode: 'active', ownership: 'shared', legacyClaimersActive: false, stages: ['retrieval','synthesis'],
        clock: { now: () => new Date(historicalNow), setInterval: () => 1, clearInterval: () => undefined },
        retriever: historicalRetriever(source, directory), synthesizer,
        mayExecuteWork: () => sourceOwnershipAllows({ databasePath: fixture.path, source: fixture.source, domain: 'research', owner: 'shared' }),
        v4: { policyVersion: POLICY, contextReader: reader, novelty: { classification: decisions, reader },
          assignmentPolicy: { policyVersion: POLICY + '.assignment', maxProviderCalls: 8, maxInputTokens: 100_000, maxOutputTokens: 20_000, maxIncrementalCostUsdMicros: null },
          synthesisPolicy: { policyVersion: POLICY + '.primary', maxInputTokens: 20_000, maxOutputTokens: 4_000, maxIncrementalCostUsdMicros: null },
          followup: { classification: decisions, policy: { policyVersion: POLICY + '.followup', maxProviderCalls: 1, maxInputTokens: 20_000,
            maxOutputTokens: 4_000, maxIncrementalCostUsdMicros: null, maxSources: 1, maxTotalBytes: 20_000, maxBytesPerSource: 20_000, maxWallTimeMs: 5_000 } } },
      })
      const retrieval = await research.runOnce(), synthesis = await research.runOnce()
      const packet = fixture.store.listResearchPacketsByWork(workId, 1)[0] as ResearchPacketV1 | undefined
      const readiness = fixture.store.getResearchReadinessByWork(workId)
      privateJson(join(directory, source.caseId + '.research.json'), { work: fixture.store.getResearchWork(workId), signal, retrieval, synthesis,
        packet, readiness, evidence: fixture.store.listEvidenceByWork(workId, 100),
        novelty: fixture.store.getResearchV4Record('novelty',workId,'decision'),
        followup: fixture.store.getResearchV4Record('followup_decision',workId,'admission'),
        reservations: fixture.store.listResearchReservations(100) })
      assert.equal(retrieval.kind, 'succeeded')
      assert.equal(synthesis.kind, 'succeeded', JSON.stringify(synthesis))
      assert.ok(packet, 'Natural synthesis must produce a saved packet for this evaluation')
      assert.deepEqual(packet.verifiedFacts, [], 'A light historical source capture must not become independently verified fact')
      assert.ok(packet.claims.every((claim) => claim.attributedTo?.trim()), 'Light useful claims require explicit source attribution')
      assert.equal(packet.observedAt, source.signal.observedAt)
      assert.ok(readiness)
      const operationId = deriveProgressionOperationId(workId)
      const lostAck = new Proxy(new SqliteEntityPacketWorkPort(fixture.store), { get(target, key) {
        if (key === 'transitionLeased') return async () => false
        const value = Reflect.get(target,key);return typeof value === 'function' ? value.bind(target) : value
      } })
      const entityResult = await entityWorker(fixture,writer!,lostAck,runtime.gateway,historicalNow).runActiveCycle()
      const receipt = await writer!.findReceipt(operationId)
      const plans = await writer!.findSavedPlanHistory(operationId), holds = await writer!.findHoldHistory(operationId)
      const dispatch = await writer!.findPlanningDispatch(operationId)
      privateJson(join(directory, source.caseId + '.entity.json'), { entityResult, receipt, plans, holds, dispatch,
        work: fixture.store.getResearchWork(workId), context: await writer!.researchContext({ source: source.sourceType, sourceRefs: [signal.sourceId,signal.canonicalUrl!] }) })
      if (!receipt) {
        outcomes.push({ caseId: source.caseId, readiness: readiness.outcome, outcome: 'natural_hold', entityResult,
          reasons: holds, dispatch, plans })
        assert.ok(holds.length || entityResult.deadLettered || entityResult.retryWait || readiness.outcome !== 'ready_for_entity',
          'A missing receipt must have an explicit durable hold or nonclaimable Research decision')
        return
      }
      assert.equal(entityResult.staleLeases,1)
      const callsBeforeRecovery = { hermes: providerDispatches, jev: jevDispatches }
      fixture.store.close()
      const resumed = new SqliteSignalPlatformStore(fixture.path,fixture.source)
      reopened.push(resumed)
      const recoveryNow = new Date(Date.parse(historicalNow) + 120_000).toISOString()
      await resumed.recoverExpiredLeases({ now: recoveryNow, limit: 10 })
      await writer!.close();await database.restart();writer = database.writer()
      const port = new Proxy(new SqliteEntityPacketWorkPort(resumed), { get(target,key) {
        if (key === 'readResearchPacket' || key === 'readHandoffContext') return async () => { throw new Error('Receipt-first restart must not hydrate any packet') }
        const value = Reflect.get(target,key);return typeof value === 'function' ? value.bind(target) : value
      } })
      const recovery = await entityWorker({ ...fixture,store: resumed },writer!,port,runtime.gateway,recoveryNow,true).runActiveCycle()
      assert.equal(recovery.completed,1)
      assert.equal(resumed.getResearchWork(workId)?.status,'complete')
      assert.deepEqual(await writer!.findReceipt(operationId),receipt)
      assert.deepEqual({ hermes: providerDispatches,jev: jevDispatches },callsBeforeRecovery)
      outcomes.push({ caseId: source.caseId, readiness: readiness.outcome, outcome: 'applied_and_receipt_recovered', receipt,
        recovery, recoveryNewProviderCalls: 0, researchProvider: packet.execution, packetCompletion: packet.completion })
      privateJson(join(directory,source.caseId + '.recovery.json'),outcomes.at(-1))
    })
    await t.test('actual irrelevant Baidu capture is retained as a negative synthesis input', async () => {
      const source = cases.find((entry) => entry.sourceType === 'polymarket')!
      const original = source.capturedEvidence[0]
      assert.equal(original.authority,'search_connector')
      assert.equal(new URL(original.finalUrl).hostname,'zhidao.baidu.com')
      const policy = createPriorityPolicyV1({ policyVersion: POLICY + '.negative', budgetPolicyVersion: POLICY + '.negative-budget' })
      // This negative provider-only probe never receives admission or an Entity
      // write. It preserves original URL/authority/capture provenance verbatim.
      const negativeWork: ResearchWorkItem = { schemaVersion: 'myboon.research_work.v1', workId: original.workId,
        signalId: source.signal.signalId,sourceType: source.sourceType,researchDepth: 'light',deepReason: null,
        priorityClass: 'P2',priorityScore: 0.5,freshnessDeadline: new Date(Date.parse(original.retrievedAt) + 3_600_000).toISOString(),
        policyVersion: POLICY + '.negative',researchContractVersion: 'myboon.research_packet.v1',
        retrievalPlan: { sourceUrl: source.signal.canonicalUrl,allowedDomains: ['polymarket.com','zhidao.baidu.com'],maxExternalSources: 1 },
        budget: policy.budgets.light,status: 'synthesis_pending',attemptCount: 0,nextAttemptAt: null,
        leaseOwner: null,leaseId: null,leaseExpiresAt: null,failureCategory: null,failureDetail: null,
        traceId: 'negative-' + source.caseId,createdAt: original.retrievedAt,updatedAt: original.retrievedAt }
      const synth = new StructuredResearchSynthesizer({ gateway: runtime.gateway,promptVersion: POLICY + '.negative-synthesis',
        now: () => new Date(original.retrievedAt) })
      privateJson(join(directory,'polymarket-negative-input.json'), { signal: source.signal, work: negativeWork, evidence: original,
        admitted: false, originalWorkIdentityRetained: true })
      const packet = await synth.synthesize({ signal: source.signal,workItem: negativeWork,evidence: [original],holdOnUnknownOutcome: true })
      const readiness = assessResearchReadiness({ work: negativeWork,signal: source.signal,packet,
        persistedEvidence: [adaptRetrievedEvidenceArtifact(original)],assessedAt: original.retrievedAt })
      privateJson(join(directory,'polymarket-negative.json'),{ original,packet,readiness,admitted: false,
        reviewRequired: 'Irrelevant Yandex retrieval must not establish silver price, prediction resolution or corroboration of odds.' })
      assert.deepEqual(packet.verifiedFacts,[],'Unrelated retained retrieval cannot independently verify this market')
      assert.deepEqual(packet.claims,[], 'An unrelated page cannot become a useful evidence-linked market claim')
      assert.notEqual(readiness.outcome,'ready_for_entity','The unrelated page must not earn Research Entity readiness')
      assert.ok(packet.limitations.some((limitation) => /irrelevant|unrelated|does not|cannot|not.*silver|not.*polymarket|无关|无法/i.test(limitation)),
        'Natural output must acknowledge the irrelevant source instead of treating it as market verification')
      outcomes.push({ caseId: 'polymarket-negative',outcome: 'unrelated_evidence_rejected',readiness: readiness.outcome,
        packetCompletion: packet.completion,claims: packet.claims })
    })
    if (!negativeOnly) {
      for (const source of cases) {
        assert.ok(outcomes.some((outcome) => outcome.caseId === source.caseId
          && outcome.outcome === 'applied_and_receipt_recovered'),
        `${source.caseId} must prove managed application and receipt-first recovery`)
      }
    }
    assert.equal(outcomes.length, negativeOnly ? 1 : 3)
    for (const call of measuredCalls) {
      assert.equal(call.state, 'saved_response')
      const usage = call.usage as Record<string, unknown>
      assert.equal(usage.provider, ROUTE.provider)
      assert.equal(usage.model, ROUTE.model)
      assert.equal(usage.completed, true)
      assert.equal(usage.failed, false)
      assert.equal(usage.api_calls, 1)
      assert.equal((usage.auxiliary as Record<string, unknown>).api_calls, 0)
    }
  } finally {
    privateJson(join(directory,'summary.json'), { finishedAt: new Date().toISOString(),route: ROUTE,profile: PROFILE,
      evaluationOnlyRoute: true,hermesDispatches: providerDispatches,jevDispatches,outcomes,measuredCalls,
      expectedCases: negativeOnly ? ['polymarket-negative'] : [...cases.map((entry) => entry.caseId),'polymarket-negative'],
      allExpectedOutcomesRecorded: outcomes.length === (negativeOnly ? 1 : 3),
      gatewayUsageKind: 'adapter_estimated',actualUsageArtifacts: 'hermes-*.cli-usage.json',
      hostedWrites: false,fullArticleCompletenessVerified: false,serverArtifacts: database.directory })
    t.diagnostic('Private live artifacts: ' + directory)
    for (const store of reopened) store.close()
    classification.close();await writer?.close();await database.close();news.dispose();poly.dispose();restore()
    for (const filename of readdirSync(directory)) chmodSync(join(directory,filename),0o600)
  }
})
