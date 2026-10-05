import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { createConfiguredInferenceGateway, RESEARCH_NOVELTY_WORKLOAD } from '../inference-gateway'
import { operationsFixture, withIsolatedV4Environment } from '../signal-platform/v4-operations.test-support'
import { createLiveSharedResearchRuntime, loadSharedResearchRunnerConfig, runSharedResearchLoop, SHARED_RESEARCH_ENV,
  type CreateLiveSharedResearchRuntimeOptions } from './run-shared-research'
import { seedV4, v4Signal, v4Clock, v4Classifier, v4ContextReader, V4_NOW } from './v4-test-fixtures'

export function offlineV4ResearchEnvironment(newsPath: string): Record<string, string> {
  return {
    FEED_V3_CUTOVER_POLICY: 'phase1', FEED_V3_RESEARCH_MODE: 'active', FEED_V3_RESEARCH_ACTIVE_SOURCES: 'news',
    FEED_V3_LEGACY_RESEARCH_DISABLED_SOURCES: 'news', FEED_V3_TRIAGE_PROVIDER_HEALTH: 'healthy',
    ENTITY_V4_SOURCE_OWNERSHIP_ENABLED: '1', ENTITY_V4_ACTIVE_SOURCES: 'news', ENTITY_V4_POLICY_VERSION: 'offline.v4',
    ENTITY_V4_NOVELTY_ENABLED: '1', ENTITY_V4_FOLLOWUP_ENABLED: '1', ENTITY_V4_RESEARCH_REUSE_ENABLED: '1',
    ENTITY_V4_REUSE_POLICY_VERSION: 'offline.reuse.v1', ENTITY_V4_REUSE_MAX_EVIDENCE_AGE_MS: '3600000',
    ENTITY_V4_REUSE_MAX_RESEARCH_AGE_MS: '3600000',
    ENTITY_V4_SYNTHESIS_POLICY_VERSION: 'offline.synthesis.v1', ENTITY_V4_SYNTHESIS_MAX_INPUT_TOKENS: '20000',
    ENTITY_V4_SYNTHESIS_MAX_OUTPUT_TOKENS: '4000', ENTITY_V4_SYNTHESIS_MAX_COST_USD_MICROS: 'unknown',
    ENTITY_V4_ASSIGNMENT_POLICY_VERSION: 'offline.assignment.v1', ENTITY_V4_ASSIGNMENT_MAX_PROVIDER_CALLS: '8',
    ENTITY_V4_ASSIGNMENT_MAX_INPUT_TOKENS: '100000', ENTITY_V4_ASSIGNMENT_MAX_OUTPUT_TOKENS: '20000',
    ENTITY_V4_ASSIGNMENT_MAX_COST_USD_MICROS: 'unknown',
    ENTITY_V4_FOLLOWUP_POLICY_VERSION: 'offline.followup.v1', ENTITY_V4_FOLLOWUP_MAX_PROVIDER_CALLS: '1',
    ENTITY_V4_FOLLOWUP_MAX_INPUT_TOKENS: '20000', ENTITY_V4_FOLLOWUP_MAX_OUTPUT_TOKENS: '4000',
    ENTITY_V4_FOLLOWUP_MAX_COST_USD_MICROS: 'unknown', ENTITY_V4_FOLLOWUP_MAX_SOURCES: '2',
    ENTITY_V4_FOLLOWUP_MAX_TOTAL_BYTES: '20000', ENTITY_V4_FOLLOWUP_MAX_BYTES_PER_SOURCE: '10000', ENTITY_V4_FOLLOWUP_MAX_WALL_TIME_MS: '5000',
    MYBOON_MANAGED_KNOWLEDGE_DATABASE_URL: 'postgresql://myboon_internal_reader@offline.invalid/knowledge',
    NEWS_SQLITE_PATH: newsPath, PIPELINE_SQLITE_PATH: join(newsPath, '..', 'unused.sqlite'),
    [SHARED_RESEARCH_ENV.batchSize]: '1', SQLITE_WRITE_HEALTH_JOURNAL_PATH: join(newsPath, '..', 'health.json'),
  }
}

test('enabled actual runner composes approved V4 ports in both priority pools with no default provider/context access', async () => {
  const restore = withIsolatedV4Environment()
  const fx = operationsFixture()
  let live: ReturnType<typeof createLiveSharedResearchRuntime> | undefined
  try {
    fx.run(fx.receipt('initialize')); fx.run(fx.receipt('resume_shared'))
    const urgent = seedV4(fx.store, v4Signal('news', 'urgent'))
    const background = seedV4(fx.store, v4Signal('news', 'background'), { priorityClass: 'P2' })
    const calls = { inferenceFactory: 0, classifierFactory: 0, legacyFactory: 0, managedFactory: 0,
      synthesis: 0, context: 0, classificationClosed: 0, managedClosed: 0 }
    const classifier = v4Classifier((request) => request.workload === RESEARCH_NOVELTY_WORKLOAD
      ? { verdict: 'new_information', reason: 'New observed state.' } : { direction: 'not_worthwhile', reason: 'No bounded addition needed.' })
    const options: CreateLiveSharedResearchRuntimeOptions = {
      workerClock: v4Clock(),
      createInferenceRuntime: (input) => {
        calls.inferenceFactory++
        return createConfiguredInferenceGateway({ ...input, estimateTokens: () => 100,
          serviceFactory: () => ({ oneshot: async () => { throw new Error('Default provider access forbidden') } }),
          adapterFactory: () => ({ generate: async (request) => {
            calls.synthesis++
            const evidenceIds = JSON.parse(request.prompt.match(/Allowed evidence IDs: (\[[^\n]*\])/)![1]) as string[]
            return { value: { claims: [{ claim: 'Atlas says a product launches Friday.', attributedTo: 'Atlas', evidenceRefs: [evidenceIds[0]] }],
              verifiedFacts: [], unresolvedClaims: [], entityHints: [], limitations: ['Source assertion only.'],
              openQuestions: [], completion: 'partial' }, usage: { inputTokens: 500, outputTokens: 80 } }
          } }),
        })
      },
      createClassificationRuntime: () => { calls.classifierFactory++; return { gateway: classifier.port, close: () => { calls.classificationClosed++ } } },
      createLegacyReader: () => { calls.legacyFactory++; return v4ContextReader() },
      createManagedContext: () => { calls.managedFactory++; return {
        researchContext: async () => { calls.context++; return { entities: [{ id: 'entity-atlas', slug: 'atlas', name: 'Atlas', summary: null }],
          items: [{ itemId: 'item-atlas', entityIds: ['entity-atlas'], note: 'Previously retained launch announcement.', status: 'active', revision: '1',
            observedAt: V4_NOW, packetRefs: ['old-packet'], evidenceRefs: [] }], digest: 'offline-managed-digest', watermark: '1', truncated: false } },
        close: async () => { calls.managedClosed++ },
      } },
    }
    live = createLiveSharedResearchRuntime(loadSharedResearchRunnerConfig(offlineV4ResearchEnvironment(fx.path)), options)
    const outcomes = await live.runCycle()
    assert.equal(outcomes.filter((outcome) => outcome.kind === 'succeeded').length, 2)
    assert.equal(calls.synthesis, 2)
    assert.equal(classifier.requests.length, 4)
    assert.ok(classifier.requests.every((request) => request.maxProviderCalls === 1 && request.holdOnUnknownOutcome === true))
    for (const { work } of [urgent, background]) {
      assert.equal(fx.store.getResearchWork(work.workId)?.status, 'entity_pending')
      assert.equal(fx.store.getResearchReadinessByWork(work.workId)?.outcome, 'ready_for_entity')
      assert.equal(fx.store.listResearchV4Records('classification_result', work.workId, 10).length, 2)
      assert.ok(fx.store.getResearchV4Record('baseline', work.workId, 'packet'))
    }
    assert.deepEqual([calls.inferenceFactory, calls.classifierFactory, calls.legacyFactory, calls.managedFactory], [1, 1, 1, 1])
    assert.ok(calls.context >= 2)
    await live.stop(); live.close(); live = undefined
    assert.deepEqual([calls.classificationClosed, calls.managedClosed], [1, 1])
  } finally { if (live) { await live.stop(); live.close() } fx.dispose(); restore() }
})

test('disabled runner returns before runtime factories and credential/provider access', async () => {
  let factories = 0
  const results: unknown[] = []
  await runSharedResearchLoop({ env: { FEED_V3_RESEARCH_MODE: 'off', [SHARED_RESEARCH_ENV.runOnce]: '1' },
    createRuntime: () => { factories++; throw new Error('Disabled mode must not compose provider/context ports') },
    onResult: (result) => results.push(result) })
  assert.equal(factories, 0)
  assert.deepEqual(results, [{ kind: 'disabled' }])
})

test('injected runner dependencies cannot bypass a missing durable source ownership record', async () => {
  const restore = withIsolatedV4Environment()
  const fx = operationsFixture()
  let live: ReturnType<typeof createLiveSharedResearchRuntime> | undefined
  try {
    const { work } = seedV4(fx.store)
    let transports = 0
    const classifier = v4Classifier({ verdict: 'new_information', reason: 'Should not run' })
    live = createLiveSharedResearchRuntime(loadSharedResearchRunnerConfig(offlineV4ResearchEnvironment(fx.path)), {
      workerClock: v4Clock(), createInferenceRuntime: (input) => createConfiguredInferenceGateway({ ...input,
        serviceFactory: () => ({ oneshot: async () => { throw new Error('No provider access') } }),
        adapterFactory: () => ({ generate: async () => { transports++; return { value: {} } } }) }),
      createClassificationRuntime: () => ({ gateway: classifier.port, close() {} }), createLegacyReader: () => v4ContextReader(),
      createManagedContext: () => ({ researchContext: async () => { throw new Error('Held source must not read remote knowledge') }, close: async () => {} }),
    })
    await live.runCycle()
    assert.equal(transports, 0)
    assert.equal(classifier.requests.length, 0)
    assert.equal(fx.store.getResearchWork(work.workId)?.status, 'synthesis_pending')
  } finally { if (live) { await live.stop(); live.close() } fx.dispose(); restore() }
})
