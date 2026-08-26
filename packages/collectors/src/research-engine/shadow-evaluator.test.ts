import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type {
  GenerateStructuredRequest,
  InferenceResult,
  InferenceTelemetry,
} from '../inference-gateway'
import {
  RESEARCH_PACKET_SCHEMA_VERSION,
  RESEARCH_WORK_SCHEMA_VERSION,
  SIGNAL_SCHEMA_VERSION,
  type ResearchWorkItem,
  type Signal,
} from '../signal-platform/contracts'
import { SqliteSignalPlatformStore } from '../signal-platform/sqlite-platform-store'
import { DeterministicRetriever } from './deterministic-retrieval'
import {
  ResearchShadowEvaluator,
  shadowResearchEvaluationId,
  type ShadowResearchResult,
  type ShadowResearchResultStore,
} from './shadow-evaluator'
import {
  StructuredResearchSynthesizer,
  type StructuredSynthesisBody,
  type StructuredSynthesisGateway,
} from './structured-synthesizer'

const NOW = '2026-08-26T12:10:00.000Z'

function source(): Signal {
  return {
    schemaVersion: SIGNAL_SCHEMA_VERSION,
    signalId: 'signal-news-shadow', sourceType: 'news', sourceId: 'news:shadow',
    contentKind: 'article', content: { schemaVersion: 'myboon.signal_content.article.v1' },
    observedAt: '2026-08-26T12:00:00.000Z', publishedAt: '2026-08-26T11:59:00.000Z',
    canonicalUrl: 'https://news.example/shadow', title: 'Shadow signal', visibleSummary: 'Summary',
    media: { imageUrl: null, attribution: null },
    sourceHints: { entities: ['Example'], assets: [], eventId: null, deadline: null },
    provenance: { provider: 'fixture', upstreamSource: null, rawPayloadRef: 'fixture:shadow' },
    idempotencyKey: 'news:shadow:key',
  }
}

function work(depth: ResearchWorkItem['researchDepth'] = 'light'): ResearchWorkItem {
  return {
    schemaVersion: RESEARCH_WORK_SCHEMA_VERSION,
    workId: `work-shadow-${depth}`, signalId: 'signal-news-shadow', sourceType: 'news',
    researchDepth: depth,
    deepReason: depth === 'deep' ? 'insufficient_primary_evidence' : null,
    priorityClass: 'P1', priorityScore: 0.8,
    freshnessDeadline: '2026-08-26T13:00:00.000Z', policyVersion: 'shadow.policy.v1',
    researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION,
    retrievalPlan: {
      sourceUrl: 'https://news.example/shadow', allowedDomains: ['news.example'], maxExternalSources: 0,
    },
    budget: {
      maxProviderCalls: 2, maxRepairCalls: 1, maxInputTokens: 2_000, maxOutputTokens: 500,
      maxToolCalls: 0, maxWallTimeMs: 30_000,
    },
    status: 'research_pending', attemptCount: 0, nextAttemptAt: null,
    leaseOwner: null, leaseId: null, leaseExpiresAt: null,
    failureCategory: null, failureDetail: null, traceId: `trace-shadow-${depth}`,
    createdAt: '2026-08-26T12:00:00.000Z', updatedAt: '2026-08-26T12:00:00.000Z',
  }
}

class MemoryResults implements ShadowResearchResultStore {
  readonly values = new Map<string, ShadowResearchResult>()
  get(id: string) { return this.values.get(id) ?? null }
  append(result: ShadowResearchResult) {
    const existing = this.values.get(result.evaluationId)
    if (existing) return { inserted: false, value: existing }
    this.values.set(result.evaluationId, structuredClone(result))
    return { inserted: true, value: result }
  }
}

class ToollessGateway implements StructuredSynthesisGateway {
  calls = 0
  lastRequest: GenerateStructuredRequest<unknown> | null = null
  async generateStructured<T>(request: GenerateStructuredRequest<T>): Promise<InferenceResult<T>> {
    this.calls += 1
    this.lastRequest = request as GenerateStructuredRequest<unknown>
    const evidenceId = request.prompt.match(/evidence_[0-9a-f]{64}/)?.[0]
    assert.ok(evidenceId)
    const body: StructuredSynthesisBody = {
      claims: [{ claim: 'Source claim', attributedTo: 'Example', evidenceRefs: [evidenceId] }],
      verifiedFacts: [], unresolvedClaims: [],
      entityHints: [{
        name: 'Example', type: 'organization', role: 'subject', aliases: [], source: 'source', evidenceRefs: [evidenceId],
      }],
      limitations: [], openQuestions: [], completion: 'complete',
    }
    const validated = request.validate(body)
    assert.equal(validated.valid, true)
    return { value: body as T, telemetry: telemetry(request.promptVersion, request.policyVersion) }
  }
}

function telemetry(promptVersion: string, policyVersion: string): InferenceTelemetry {
  return {
    workload: 'research.synthesis', purpose: 'research.structured-synthesis', mode: 'generateStructured',
    promptVersion, policyVersion,
    configuredPrimaryProvider: 'fixture', configuredPrimaryModel: 'fixture-model',
    actualProvider: 'fixture', actualModel: 'fixture-model', fallbackInvoked: false, fallbackReason: null,
    schemaValid: true, providerCalls: 1, repairCalls: 0, inputTokens: 20, outputTokens: 10,
    toolCalls: 0, durationMs: 5, budgetExceeded: false, failureCategory: null, calls: [],
  }
}

function setup(item: ResearchWorkItem) {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-evaluator-'))
  const canonical = new SqliteSignalPlatformStore(join(dir, 'canonical.sqlite'), 'news')
  canonical.appendSignal(source())
  canonical.admitResearchWork(item)
  const results = new MemoryResults()
  const gateway = new ToollessGateway()
  let retrievalCalls = 0
  let peekCalls = 0
  const evaluator = new ResearchShadowEvaluator({
    scheduler: { peekGlobal: async () => { peekCalls += 1; return [item] } },
    stores: [canonical], results,
    retriever: new DeterministicRetriever({
      now: () => new Date(NOW),
      fetchDocument: async (url) => {
        retrievalCalls += 1
        return { body: Buffer.from('shadow evidence'), finalUrl: url, contentType: 'text/plain', status: 200, visitedHosts: [] }
      },
    }),
    synthesizer: new StructuredResearchSynthesizer({
      gateway, promptVersion: 'shadow.prompt.v1', now: () => new Date(NOW),
    }),
    clock: { now: () => new Date(NOW) },
  })
  return {
    canonical, evaluator, results, gateway,
    counts: () => ({ retrievalCalls, peekCalls }),
    close: () => { canonical.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

test('shadow light research executes retrieval and tool-less synthesis without canonical writes or claims', async () => {
  const item = work('light')
  const fx = setup(item)
  try {
    const [outcome] = await fx.evaluator.runBatch(1)
    assert.equal(outcome?.kind, 'succeeded')
    assert.equal(fx.counts().retrievalCalls, 1)
    assert.equal(fx.counts().peekCalls, 1)
    assert.equal(fx.gateway.calls, 1)
    assert.equal(fx.gateway.lastRequest?.budget.maxToolCalls, 0)
    assert.equal('tools' in (fx.gateway.lastRequest ?? {}), false)
    assert.equal(fx.canonical.getResearchWork(item.workId)?.status, 'research_pending')
    assert.equal(fx.canonical.getResearchWork(item.workId)?.attemptCount, 0)
    assert.equal(fx.canonical.listEvidenceByWork(item.workId, 10).length, 0)
    assert.equal(fx.canonical.listResearchPacketsByWork(item.workId, 10).length, 0)
    assert.equal(fx.results.values.size, 1)
  } finally { fx.close() }
})

test('shadow result replay is idempotent and performs no second retrieval or provider call', async () => {
  const item = work('light')
  const fx = setup(item)
  try {
    assert.equal((await fx.evaluator.evaluate(item)).kind, 'succeeded')
    assert.equal((await fx.evaluator.evaluate(item)).kind, 'replayed')
    assert.deepEqual(fx.counts(), { retrievalCalls: 1, peekCalls: 0 })
    assert.equal(fx.gateway.calls, 1)
    assert.equal(fx.results.values.size, 1)
    assert.ok(fx.results.get(shadowResearchEvaluationId(item)))
  } finally { fx.close() }
})

test('deep work is skipped and a circuit-open route records a zero-call shadow outcome', async () => {
  const deep = work('deep')
  const deepFx = setup(deep)
  try {
    const outcome = await deepFx.evaluator.evaluate(deep)
    assert.equal(outcome.kind, 'skipped')
    assert.equal(outcome.result.skipReason, 'deep_not_supported')
    assert.equal(deepFx.counts().retrievalCalls, 0)
    assert.equal(deepFx.gateway.calls, 0)
  } finally { deepFx.close() }

  const light = work('light')
  const fx = setup(light)
  try {
    const blocked = new ResearchShadowEvaluator({
      scheduler: { peekGlobal: async () => [light] }, stores: [fx.canonical], results: new MemoryResults(),
      retriever: new DeterministicRetriever({ fetchDocument: async () => { throw new Error('must not fetch') } }),
      synthesizer: new StructuredResearchSynthesizer({ gateway: fx.gateway, promptVersion: 'shadow.prompt.v1' }),
      readiness: { check: async () => ({ ready: false, category: 'circuit_open', detail: 'open' }) },
      clock: { now: () => new Date(NOW) },
    })
    const outcome = await blocked.evaluate(light)
    assert.equal(outcome.kind, 'skipped')
    assert.equal(outcome.result.skipReason, 'circuit_open')
    assert.equal(outcome.result.providerCalls, 0)
    assert.equal(fx.gateway.calls, 0)
  } finally { fx.close() }
})

test('standard shadow research without a registered connector fails closed before retrieval', async () => {
  const item = work('standard')
  const fx = setup(item)
  try {
    const outcome = await fx.evaluator.evaluate(item)
    assert.equal(outcome.kind, 'failed')
    assert.equal(outcome.result.failureCategory, 'retrieval_blocked')
    assert.equal(fx.counts().retrievalCalls, 0)
    assert.equal(fx.gateway.calls, 0)
    assert.equal(fx.canonical.getResearchWork(item.workId)?.status, 'research_pending')
  } finally { fx.close() }
})

test('standard shadow research uses the registered bounded discovery stage before synthesis', async () => {
  const item = work('standard')
  const fx = setup(item)
  try {
    let searchCalls = 0
    const evaluator = new ResearchShadowEvaluator({
      scheduler: { peekGlobal: async () => [item] }, stores: [fx.canonical], results: new MemoryResults(),
      retriever: new DeterministicRetriever({
        now: () => new Date(NOW),
        fetchDocument: async (url) => ({
          body: Buffer.from('standard evidence'), finalUrl: url,
          contentType: 'text/plain', status: 200, visitedHosts: [],
        }),
      }),
      synthesizer: new StructuredResearchSynthesizer({
        gateway: fx.gateway, promptVersion: 'shadow.prompt.v1', now: () => new Date(NOW),
      }),
      standardSearch: {
        async discover() {
          searchCalls += 1
          return { policyVersion: 'search.v1', connectorId: 'registered', queryCount: 1, urls: [] }
        },
      },
      clock: { now: () => new Date(NOW) },
    })

    assert.equal((await evaluator.evaluate(item)).kind, 'succeeded')
    assert.equal(searchCalls, 1)
    assert.equal(fx.gateway.calls, 1)
    assert.equal(fx.canonical.listEvidenceByWork(item.workId, 10).length, 0)
  } finally { fx.close() }
})
