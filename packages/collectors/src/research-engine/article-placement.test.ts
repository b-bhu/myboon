import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareArticlePlacement } from './article-placement'
import { v4ClassificationResult } from './v4-test-fixtures'
import { managedFixture } from '../entity-manager/managed-v4.test-support'
import { createConfiguredClassificationRuntime } from '../inference-gateway/classification-configuration'
import { StructuredResearchSynthesizer } from './structured-synthesizer'
import type { ClassificationRequest, ClassificationResult, JevAnswer } from '../inference-gateway/classification-types'
import { InferenceGatewayError } from '../inference-gateway/errors'
import { articleNoveltyDefinition, articleStoryRelationshipDefinition } from '../inference-gateway/classification-definitions'

const answer = (key: string): JevAnswer => ({ type: 'choice', choice: key, confidence: .95, probabilities: { [key]: .95, alternative: .05 } })
const signal = managedFixture('article-decision').handoffContext.signal
const context = () => ({ candidates: [
  { id: 'bitcoin', name: 'Bitcoin', aliases: ['BTC'], summary: 'Bitcoin news.', scope: { category: 'asset' } },
  { id: 'blackrock', name: 'BlackRock', aliases: [], summary: 'BlackRock corporate developments.', scope: { category: 'organization' } },
], historyByEntity: new Map(['bitcoin', 'blackrock'].map(entityId => [entityId, Array.from({ length: 6 }, (_, i) => ({
  id: `${entityId}-${i}`, source: 'legacy' as const, title: `Earlier ${entityId} development`, summary: `Development ${i}.`, eventAt: '2026-10-01T00:00:00Z',
}))])), coverageFailures: [] as string[] })

test('article placement keeps Bitcoin primary, BlackRock related and only five story entries per entity', async () => {
  const requests: ClassificationRequest[] = []
  const gateway = { recordPolicyOutcome() {}, async classify<Value>(request: ClassificationRequest): Promise<ClassificationResult<Value>> {
    requests.push(request)
    let value: unknown; let answers: Record<string, JevAnswer>
    if (request.workload.endsWith('entity_placement')) { value = { entityId: 'bitcoin', disposition: 'selected' }; answers = { placement: answer('bitcoin') } }
    else if (request.workload.endsWith('related_membership')) { value = { dispositions: { blackrock: 'related' } }; answers = { related_blackrock: answer('related') } }
    else if (request.workload.endsWith('story_relationship')) {
      const state = request.state as { entity: { id: string }, recentItems: unknown[] }
      assert.equal(state.recentItems.length, 5)
      value = { relationship: 'direct_continuation', priorItemId: `${state.entity.id}-0` }
      answers = { relationship: answer('direct_continuation'), prior_item: answer(`${state.entity.id}-0`) }
    } else { value = { verdict: 'new_information' }; answers = { novelty: answer('new_information') } }
    return { ...v4ClassificationResult(value as Value), workload: request.workload, decisionVersion: request.decisionVersion, answers }
  } }
  const articleText = 'BlackRock added $1.5 billion in Bitcoin holdings.'
  const fullContext = context()
  const historyReads: string[] = []
  const lazyContext = { ...fullContext, historyByEntity: new Map(), loadHistory: async (id: string) => {
    historyReads.push(id); return fullContext.historyByEntity.get(id) ?? []
  } }
  const result = await prepareArticlePlacement({ gateway, stableDecisionKey: 'article-test', signal, sourceText: articleText, context: lazyContext })
  assert.deepEqual(result.memberships.map(m => [m.entityId, m.role]), [['bitcoin', 'primary'], ['blackrock', 'related']])
  assert.equal(result.memberships[0].placement.probabilities.bitcoin, .95)
  assert.equal(result.memberships[0].priorItemId, 'bitcoin-0')
  assert.match(result.contextualHistory, /Development 4/); assert.doesNotMatch(result.contextualHistory, /Development 5/)
  assert.equal(requests.length, 5)
  assert.deepEqual(historyReads.sort(), ['bitcoin', 'blackrock'])
  assert.equal((requests[0].state as { article: { text: string } }).article.text, articleText)
})

test('incomplete context and oversized captures hold before any Jev call', async () => {
  let calls = 0
  const gateway = { recordPolicyOutcome() {}, async classify<Value>(): Promise<ClassificationResult<Value>> { calls++; throw new Error('must not call') } }
  const base = { gateway, stableDecisionKey: 'article-test', signal, sourceText: 'Captured article.', context: context() }
  await assert.rejects(prepareArticlePlacement({ ...base, context: { ...context(), coverageFailures: ['database unavailable'] } }), /coverage|lookup/i)
  await assert.rejects(prepareArticlePlacement({ ...base, sourceText: 'x'.repeat(16001) }), /capture|bound/i)
  assert.equal(calls, 0)
})

test('long legacy titles remain usable in recent and older relationship context without changing writing history', async () => {
  const fullTitle = 'Legacy history heading '.repeat(40)
  const historyContext = context()
  historyContext.candidates = historyContext.candidates.slice(0, 1)
  historyContext.historyByEntity.get('bitcoin')![0].title = fullTitle
  const older = { id: 'bitcoin-old', source: 'legacy' as const, title: fullTitle, summary: 'An older development.', eventAt: '2026-09-01T00:00:00Z' }
  let relationshipCalls = 0
  const gateway = { async classify<Value>(request: ClassificationRequest): Promise<ClassificationResult<Value>> {
    let value: unknown; let answers: Record<string, JevAnswer>
    if (request.workload.endsWith('entity_placement')) {
      value = { entityId: 'bitcoin', disposition: 'selected' }; answers = { placement: answer('bitcoin') }
    } else if (request.workload.endsWith('story_relationship')) {
      const validated = articleStoryRelationshipDefinition().validateState(request.state)
      assert.equal(validated.valid, true)
      assert.equal(validated.value.recentItems[0].title.length <= 500, true)
      assert.match(validated.value.recentItems[0].title, /\[excerpted\]$/)
      relationshipCalls++
      value = { relationship: 'same_topic_only', priorItemId: null }
      answers = { relationship: answer('same_topic_only'), prior_item: answer('none') }
    } else { value = { verdict: 'new_information' }; answers = { novelty: answer('new_information') } }
    return { ...v4ClassificationResult(value as Value), workload: request.workload, decisionVersion: request.decisionVersion, answers }
  } }
  const result = await prepareArticlePlacement({ gateway, stableDecisionKey: 'long-history', signal, sourceText: 'A new Bitcoin development.',
    context: { ...historyContext, lookupOlderDuplicate: async () => [older] } })
  assert.equal(relationshipCalls, 2)
  assert.equal(historyContext.historyByEntity.get('bitcoin')![0].title, fullTitle)
  assert.equal(older.title, fullTitle)
  assert.equal(result.contextualHistory.includes(fullTitle), true)
})

test('explicitly disabled article Jev cannot dispatch Jev or Hermes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'article-jev-'))
  let calls = 0
  const runtime = createConfiguredClassificationRuntime({ env: { CLASSIFICATION_LIFECYCLE_JSON: '{}', CLASSIFICATION_SQLITE_PATH: join(directory, 'classification.sqlite') },
    jevAdapter: { async classify() { calls++; throw new Error('must not dispatch') } },
    hermesService: { async oneshot() { calls++; throw new Error('must not dispatch') } } })
  try {
    await assert.rejects(runtime.gateway.classify({ workload: 'research.article_entity_placement', decisionVersion: 'research.article_entity_placement.v2',
      state: { article: { title: signal.title, text: 'Captured article.' }, candidates: context().candidates }, trace: { stableDecisionKey: 'disabled' } }), /explicitly active Jev/)
    assert.equal(calls, 0)
  } finally { runtime.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('configured article writer refuses prose generation before Jev preparation', async () => {
  let calls = 0
  const synthesizer = new StructuredResearchSynthesizer({ promptVersion: 'article-test.v1', requireArticlePreparation: true,
    gateway: { async generateStructured() { calls++; throw new Error('must not dispatch') } } })
  const fixture = managedFixture('unprepared')
  await assert.rejects(synthesizer.synthesize({ signal: fixture.handoffContext.signal, workItem: fixture.work, evidence: fixture.handoffContext.persistedEvidence.map(e => ({ ...e, retrievalMethod: 'safe_http' as const })) }), /Jev placement/)
  assert.equal(calls, 0)
})

test('article choice accepts a full catalogue distribution within the real provider token bounds', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'article-choice-budget-'))
  const candidates = Array.from({ length: 32 }, (_, i) => ({ id: `entity-${i}`, name: `Entity ${i}`, aliases: [], summary: null, scope: {} }))
  const probabilities = Object.fromEntries([...candidates.map(c => [c.id, c.id === 'entity-0' ? .95 : 0]), ['no_match', .05], ['uncertain', 0]])
  const runtime = createConfiguredClassificationRuntime({ env: { CLASSIFICATION_SQLITE_PATH: join(directory, 'classification.sqlite') },
    jevAdapter: { async classify() { return { actualProvider: 'typesafe', actualModel: 'jev-1.13.0',
      answers: { placement: { type: 'choice', choice: 'entity-0', confidence: .95, probabilities } },
      usage: { inputTokens: 40_000, outputTokens: 1_400 }, durationMs: 1 } } } })
  try {
    const result = await runtime.gateway.classify({ workload: 'research.article_entity_placement', decisionVersion: 'research.article_entity_placement.v2',
      state: { article: { title: 'Development', text: 'Captured article.' }, candidates }, trace: { stableDecisionKey: 'full-catalogue' } })
    assert.equal(result.fallbackUsed, false); assert.equal(result.answers?.placement.type, 'choice')
  } finally { runtime.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('required article Jev preserves provider failure and never relabels it as a fallback budget failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'article-choice-failure-'))
  let fallbackCalls = 0
  const runtime = createConfiguredClassificationRuntime({ env: { CLASSIFICATION_SQLITE_PATH: join(directory, 'classification.sqlite') },
    jevAdapter: { async classify() { throw new InferenceGatewayError('Jev classification failed with HTTP 400', { category: 'invalid_structured_output', retryable: false }) } },
    hermesService: { async oneshot() { fallbackCalls++; throw new Error('must not dispatch') } } })
  try {
    await assert.rejects(runtime.gateway.classify({ workload: 'research.article_entity_placement', decisionVersion: 'research.article_entity_placement.v2',
      state: { article: { title: 'Development', text: 'Captured article.' }, candidates: context().candidates }, trace: { stableDecisionKey: 'provider-error' }, maxProviderCalls: 1 }),
    (error: unknown) => error instanceof InferenceGatewayError && error.category === 'invalid_structured_output' && /HTTP 400/.test(error.message))
    assert.equal(fallbackCalls, 0)
  } finally { runtime.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('joint historical outcomes cannot declare continuation without a real target, even with empty history', () => {
  const definition = articleStoryRelationshipDefinition()
  const state = { article: { title: 'CertiK AI tracing', sourceText: 'CertiK adds an AI tracing capability.', publishedAt: null, observedAt: signal.observedAt },
    entity: { id: 'certik', name: 'CertiK' }, recentItems: [] }
  const questions = definition.questions(state)
  assert.deepEqual(Object.keys(questions.relationship_target.criteria!), ['same_topic_only', 'unrelated', 'uncertain'])
  assert.equal(definition.decodeJev({ relationship_target: answer('direct_continuation:legacy:missing') }, state).valid, false)
  assert.equal(definition.decodeJev({ relationship_target: answer('same_topic_only:unknown') }, state).valid, false)
  const withHistory = { ...state, recentItems: [{ id: 'earlier', source: 'legacy' as const, title: 'Earlier update', summary: 'Earlier development.', eventAt: signal.observedAt }] }
  assert.equal(definition.decodeJev({ relationship_target: answer('same_topic_only:legacy:earlier') }, withHistory).valid, false)
  assert.equal(definition.decodeJev({ relationship_target: answer('direct_continuation:managed:earlier') }, withHistory).valid, false)
  assert.equal(definition.decodeJev({ relationship_target: answer('direct_continuation:legacy:earlier') }, withHistory).valid, true)
  const standalone = definition.decodeJev({ relationship_target: answer('same_topic_only') }, state)
  assert.equal(standalone.valid, true)
  if (standalone.valid) assert.equal(standalone.value.priorItemId, null)
})

test('an exact existing identity is confirmed by Jev instead of creating a duplicate after a no-match shortlist', async () => {
  let placementCalls = 0, creationChecks = 0
  const exact = { id: 'raoul-pal', name: 'Raoul Pal', aliases: [], summary: 'Macro commentator', scope: {} }
  const gateway = { async classify<Value>(request: ClassificationRequest): Promise<ClassificationResult<Value>> {
    let value: unknown; let answers: Record<string, JevAnswer>
    if (request.workload.endsWith('entity_placement')) {
      placementCalls++
      const present = (request.state as { candidates: typeof exact[] }).candidates.some(e => e.id === exact.id)
      value = present ? { entityId: exact.id, disposition: 'selected' } : { entityId: null, disposition: 'no_match' }
      answers = { placement: answer(present ? exact.id : 'no_match') }
    } else if (request.workload.endsWith('entity_proposal_validation')) { creationChecks++; throw new Error('must use the existing identity') }
    else if (request.workload.endsWith('story_relationship')) { value = { relationship: 'same_topic_only', priorItemId: null }; answers = { relationship_target: answer('same_topic_only') } }
    else { value = { verdict: 'new_information' }; answers = { novelty: answer('new_information') } }
    return { ...v4ClassificationResult(value as Value), workload: request.workload, decisionVersion: request.decisionVersion, answers }
  } }
  const result = await prepareArticlePlacement({ gateway, signal, stableDecisionKey: 'missing-raoul', sourceText: 'Raoul Pal predicts a crypto bull run.',
    context: { candidates: [], historyByEntity: new Map(), coverageFailures: [], findExactEntities: async labels => { assert.ok(labels.includes('Raoul Pal')); return [exact] } },
    proposeCreation: async () => ({ ...exact, type: 'person', summary: exact.summary }) })
  assert.equal(result.memberships[0].entityId, exact.id)
  assert.equal(result.memberships[0].creationProposal, null)
  assert.equal(placementCalls, 2); assert.equal(creationChecks, 0)
})

test('one bounded duplicate recheck can preserve a new narrative development without suppressing it', async () => {
  let noveltyCalls = 0
  const c = context(); c.candidates = c.candidates.slice(0, 1)
  const gateway = { async classify<Value>(request: ClassificationRequest): Promise<ClassificationResult<Value>> {
    let value: unknown; let answers: Record<string, JevAnswer>
    if (request.workload.endsWith('entity_placement')) { value = { entityId: 'bitcoin', disposition: 'selected' }; answers = { placement: answer('bitcoin') } }
    else if (request.workload.endsWith('story_relationship')) { value = { relationship: 'duplicate', priorItemId: 'bitcoin-0', priorItemSource: 'legacy' }; answers = { relationship_target: answer('duplicate:legacy:bitcoin-0') } }
    else {
      noveltyCalls++
      if (noveltyCalls === 1) { value = { verdict: 'new_information' }; answers = { novelty: answer('new_information') } }
      else {
        assert.equal((request.state as {selectedTargets: unknown[]}).selectedTargets.length, 1)
        const validated = articleNoveltyDefinition().validateState(request.state)
        assert.equal(validated.valid, true)
        if (validated.valid) assert.ok(validated.value.reconciliation)
        value = { verdict: 'new_information', primaryRelationship: 'related_story_branch' }
        answers = { novelty: answer('new_information:related_story_branch') }
      }
    }
    return { ...v4ClassificationResult(value as Value), workload: request.workload, decisionVersion: request.decisionVersion, answers }
  } }
  const result = await prepareArticlePlacement({ gateway, stableDecisionKey: 'recheck', signal, sourceText: 'A new Bitcoin development.', context: c })
  assert.equal(noveltyCalls, 2)
  assert.equal(result.novelty.choice, 'new_information')
  assert.equal(result.memberships[0].relationship, 'related_story_branch')
  assert.equal(result.memberships[0].priorItemId, 'bitcoin-0')
  assert.equal(result.memberships[0].duplicateTarget, null)
})
