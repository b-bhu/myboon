import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ArticleResearchHold, ARTICLE_PLACEMENT_LINK_FLOOR_ENV, ARTICLE_PLACEMENT_PRIMARY_FLOOR_ENV,
  ARTICLE_PLACEMENT_SAVE_UNCERTAIN_ENV, parseArticlePlacementConfidenceFloors,
  parseArticlePlacementSaveUncertain, prepareArticlePlacement,
} from './article-placement'
import { v4ClassificationResult } from './v4-test-fixtures'
import { managedFixture } from '../entity-manager/managed-v4.test-support'
import { createConfiguredClassificationRuntime } from '../inference-gateway/classification-configuration'
import { StructuredResearchSynthesizer } from './structured-synthesizer'
import type { ClassificationRequest, ClassificationResult, JevAnswer } from '../inference-gateway/classification-types'
import { InferenceGatewayError } from '../inference-gateway/errors'
import { articleNoveltyDefinition, articleStoryRelationshipDefinition, articleCatalogueBatchDefinition, articleRelationshipBatchDefinition, ARTICLE_ENTITY_PLACEMENT_HERMES_FALLBACK_VERSION, ARTICLE_NOVELTY_HERMES_FALLBACK_VERSION, type ArticleCatalogueBatchState, type ArticleRelationshipBatchState } from '../inference-gateway/classification-definitions'
import { ARTICLE_DECISION_SOURCE_MAX_CHARS, ARTICLE_DECISION_STATE_MAX_BYTES } from './article-input-bounds'

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

test('article placement admits a captured source above the former 16k bound without changing it', async () => {
  const sourceText = 'Captured article text. '.repeat(1_200) // 26,400 characters
  assert.ok(sourceText.length > 16_000)
  const requests: ClassificationRequest[] = []
  const gateway = { recordPolicyOutcome() {}, async classify<Value>(request: ClassificationRequest): Promise<ClassificationResult<Value>> {
    requests.push(request)
    let value: unknown; let answers: Record<string, JevAnswer>
    if (request.workload.endsWith('entity_placement')) {
      value = { entityId: 'bitcoin', disposition: 'selected' }; answers = { placement: answer('bitcoin') }
    } else if (request.workload.endsWith('related_membership')) {
      value = { dispositions: { blackrock: 'not_related' } }; answers = { related_blackrock: answer('not_related') }
    } else if (request.workload.endsWith('story_relationship')) {
      value = { relationship: 'same_topic_only', priorItemId: null }; answers = { relationship_target: answer('same_topic_only') }
    } else {
      value = { verdict: 'new_information' }; answers = { novelty: answer('new_information') }
    }
    return { ...v4ClassificationResult(value as Value), workload: request.workload, decisionVersion: request.decisionVersion, answers }
  } }
  const result = await prepareArticlePlacement({ gateway, stableDecisionKey: 'large-source', signal, sourceText, context: context() })
  assert.equal(result.memberships[0].entityId, 'bitcoin')
  assert.ok(requests.length > 0)
  for (const request of requests) {
    const article = request.state as { article: { text?: string, sourceText?: string } }
    assert.equal(article.article.text ?? article.article.sourceText, sourceText)
  }
})

test('incomplete context and oversized captures hold before any Jev call', async () => {
  let calls = 0
  const gateway = { recordPolicyOutcome() {}, async classify<Value>(): Promise<ClassificationResult<Value>> { calls++; throw new Error('must not call') } }
  const base = { gateway, stableDecisionKey: 'article-test', signal, sourceText: 'Captured article.', context: context() }
  await assert.rejects(prepareArticlePlacement({ ...base, context: { ...context(), coverageFailures: ['database unavailable'] } }), /coverage|lookup/i)
  await assert.rejects(prepareArticlePlacement({ ...base, sourceText: 'x'.repeat(ARTICLE_DECISION_SOURCE_MAX_CHARS + 1) }), /capture|bound/i)
  assert.equal(calls, 0)
})

test('transient context coverage is a retryable hold while ambiguous coverage stays terminal', async () => {
  const gateway = { recordPolicyOutcome() {}, async classify<Value>(): Promise<ClassificationResult<Value>> {
    throw new Error('must not call Jev while context is unavailable')
  } }
  const base = { gateway, stableDecisionKey: 'context-outage', signal, sourceText: 'Captured article.', context: context() }
  await assert.rejects(
    prepareArticlePlacement({ ...base, context: { ...context(), coverageFailures: ['PGRST002: connection timeout'], coverageFailureKind: 'transient' } }),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'context_coverage_transient',
  )
  await assert.rejects(
    prepareArticlePlacement({ ...base, context: { ...context(), coverageFailures: ['identity catalogue is ambiguous'] } }),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'context_coverage_unavailable',
  )
})

test('long legacy titles remain usable in recent and older relationship context without changing writing history', async () => {
  const fullTitle = 'Legacy history heading '.repeat(40)
  const historyContext = context()
  historyContext.candidates = historyContext.candidates.slice(0, 1)
  historyContext.historyByEntity.get('bitcoin')![0].title = fullTitle
  historyContext.historyByEntity.get('bitcoin')![1].title = '   '
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
      if (relationshipCalls === 0) {
        assert.equal(validated.value.recentItems.find((item) => item.id === 'bitcoin-1')?.title, '[title unavailable]')
      }
      relationshipCalls++
      value = { relationship: 'same_topic_only', priorItemId: null }
      answers = { relationship: answer('same_topic_only'), prior_item: answer('none') }
    } else {
      const state = request.state as { histories: Array<{ entityId: string, items: Array<{ id: string, title: string }> }> }
      const bitcoinHistory = state.histories.find((history) => history.entityId === 'bitcoin')
      assert.match(bitcoinHistory?.items[0].title ?? '', /\[excerpted\]$/)
      assert.equal(bitcoinHistory?.items.find((item) => item.id === 'bitcoin-1')?.title, '[title unavailable]')
      value = { verdict: 'new_information' }; answers = { novelty: answer('new_information') }
    }
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

test('primary exact duplicate selects one reuse item while related legacy matches remain contextual', async () => {
  let noveltyCalls = 0
  const c = context()
  const gateway = { async classify<Value>(request: ClassificationRequest): Promise<ClassificationResult<Value>> {
    let value: unknown; let answers: Record<string, JevAnswer>
    if (request.workload.endsWith('entity_placement')) {
      value = { entityId: 'bitcoin', disposition: 'selected' }; answers = { placement: answer('bitcoin') }
    } else if (request.workload.endsWith('related_membership')) {
      value = { dispositions: { blackrock: 'related' } }; answers = { related_blackrock: answer('related') }
    } else if (request.workload.endsWith('story_relationship')) {
      const entityId = (request.state as { entity: { id: string } }).entity.id
      const itemId = `${entityId}-0`
      value = { relationship: 'duplicate', priorItemId: itemId, priorItemSource: 'legacy' }
      answers = { relationship_target: answer(`duplicate:legacy:${itemId}`) }
    } else {
      noveltyCalls++
      const state = request.state as { selectedTargets: Array<{ role: string, id: string }> }
      assert.deepEqual(state.selectedTargets.map((target) => [target.role, target.id]), [['primary', 'bitcoin-0'], ['related', 'blackrock-0']])
      value = { verdict: 'already_known' }; answers = { novelty: answer('already_known') }
    }
    return { ...v4ClassificationResult(value as Value), workload: request.workload, decisionVersion: request.decisionVersion, answers }
  } }
  const result = await prepareArticlePlacement({ gateway, stableDecisionKey: 'primary-authority', signal,
    sourceText: 'BlackRock and Bitcoin reported the same holdings development.', context: c })
  assert.equal(noveltyCalls, 1)
  assert.deepEqual(result.memberships.map((membership) => ({ role: membership.role, relationship: membership.relationship, priorItemId: membership.priorItemId, duplicateTarget: membership.duplicateTarget })), [
    { role: 'primary', relationship: 'duplicate', priorItemId: 'bitcoin-0', duplicateTarget: { entityId: 'bitcoin', itemId: 'bitcoin-0', source: 'legacy' } },
    { role: 'related', relationship: 'duplicate', priorItemId: 'blackrock-0', duplicateTarget: null },
  ])
  assert.deepEqual(result.memberships[1].contextualDuplicateTarget, { entityId: 'blackrock', itemId: 'blackrock-0', source: 'legacy' })
})

test('conflicting related duplicate targets without a primary target remain an explicit hold', async () => {
  let noveltyCalls = 0
  const c = context()
  c.candidates.push({ id: 'solana', name: 'Solana', aliases: [], summary: 'Solana ecosystem news.', scope: { category: 'asset' } })
  c.historyByEntity.set('solana', Array.from({ length: 6 }, (_, i) => ({ id: `solana-${i}`, source: 'legacy' as const, title: `Earlier Solana development`, summary: `Solana development ${i}.`, eventAt: signal.observedAt })))
  const gateway = { async classify<Value>(request: ClassificationRequest): Promise<ClassificationResult<Value>> {
    let value: unknown; let answers: Record<string, JevAnswer>
    if (request.workload.endsWith('entity_placement')) {
      value = { entityId: 'bitcoin', disposition: 'selected' }; answers = { placement: answer('bitcoin') }
    } else if (request.workload.endsWith('related_membership')) {
      value = { dispositions: { blackrock: 'related', solana: 'related' } }; answers = { related_blackrock: answer('related'), related_solana: answer('related') }
    } else if (request.workload.endsWith('story_relationship')) {
      const entityId = (request.state as { entity: { id: string } }).entity.id
      if (entityId === 'bitcoin') {
        value = { relationship: 'same_topic_only', priorItemId: null }; answers = { relationship_target: answer('same_topic_only') }
      } else {
        const itemId = `${entityId}-0`
        value = { relationship: 'duplicate', priorItemId: itemId, priorItemSource: 'legacy' }
        answers = { relationship_target: answer(`duplicate:legacy:${itemId}`) }
      }
    } else {
      noveltyCalls++
      value = { verdict: 'already_known' }; answers = { novelty: answer('already_known') }
    }
    return { ...v4ClassificationResult(value as Value), workload: request.workload, decisionVersion: request.decisionVersion, answers }
  } }
  await assert.rejects(prepareArticlePlacement({ gateway, stableDecisionKey: 'conflicting-related-targets', signal,
    sourceText: 'Bitcoin, BlackRock and Solana developments.', context: c }), /primary exact durable duplicate/i)
  assert.equal(noveltyCalls, 1)
})

test('new primary development preserves a related historical duplicate link', async () => {
  const c = context()
  const gateway = { async classify<Value>(request: ClassificationRequest): Promise<ClassificationResult<Value>> {
    let value: unknown; let answers: Record<string, JevAnswer>
    if (request.workload.endsWith('entity_placement')) {
      value = { entityId: 'bitcoin', disposition: 'selected' }; answers = { placement: answer('bitcoin') }
    } else if (request.workload.endsWith('related_membership')) {
      value = { dispositions: { blackrock: 'related' } }; answers = { related_blackrock: answer('related') }
    } else if (request.workload.endsWith('story_relationship')) {
      const entityId = (request.state as { entity: { id: string } }).entity.id
      if (entityId === 'bitcoin') {
        value = { relationship: 'same_topic_only', priorItemId: null }; answers = { relationship_target: answer('same_topic_only') }
      } else {
        value = { relationship: 'duplicate', priorItemId: 'blackrock-0', priorItemSource: 'legacy' }
        answers = { relationship_target: answer('duplicate:legacy:blackrock-0') }
      }
    } else {
      value = { verdict: 'new_information' }; answers = { novelty: answer('new_information') }
    }
    return { ...v4ClassificationResult(value as Value), workload: request.workload, decisionVersion: request.decisionVersion, answers }
  } }
  const result = await prepareArticlePlacement({ gateway, stableDecisionKey: 'new-primary-related-history', signal,
    sourceText: 'Bitcoin has a new development with a related BlackRock historical item.', context: c })
  assert.equal(result.novelty.choice, 'new_information')
  assert.equal(result.memberships[0].relationship, 'same_topic_only')
  assert.equal(result.memberships[1].relationship, 'duplicate')
  assert.deepEqual(result.memberships[1].duplicateTarget, { entityId: 'blackrock', itemId: 'blackrock-0', source: 'legacy' })
})

test('uncertain novelty with duplicate context holds without a provider retry', async () => {
  let noveltyCalls = 0
  const c = context()
  const gateway = { async classify<Value>(request: ClassificationRequest): Promise<ClassificationResult<Value>> {
    let value: unknown; let answers: Record<string, JevAnswer>
    if (request.workload.endsWith('entity_placement')) {
      value = { entityId: 'bitcoin', disposition: 'selected' }; answers = { placement: answer('bitcoin') }
    } else if (request.workload.endsWith('related_membership')) {
      value = { dispositions: { blackrock: 'related' } }; answers = { related_blackrock: answer('related') }
    } else if (request.workload.endsWith('story_relationship')) {
      const entityId = (request.state as { entity: { id: string } }).entity.id
      const itemId = `${entityId}-0`
      value = { relationship: 'duplicate', priorItemId: itemId, priorItemSource: 'legacy' }
      answers = { relationship_target: answer(`duplicate:legacy:${itemId}`) }
    } else {
      noveltyCalls++
      value = { verdict: 'uncertain' }; answers = { novelty: answer('uncertain') }
    }
    return { ...v4ClassificationResult(value as Value), workload: request.workload, decisionVersion: request.decisionVersion, answers }
  } }
  await assert.rejects(prepareArticlePlacement({ gateway, stableDecisionKey: 'uncertain-no-retry', signal,
    sourceText: 'An unresolved development.', context: c }), /uncertain/i)
  assert.equal(noveltyCalls, 1)
})

// #308 step 4D: flag-gated provider-aware decisions (useHermesFallbackVersions).
function fallbackGateway(options: { hermes?: (workload: string) => boolean, placement?: 'selected' | 'uncertain', novelty?: string } = {}) {
  const requests: ClassificationRequest[] = []
  const gateway = { recordPolicyOutcome() {}, async classify<Value>(request: ClassificationRequest): Promise<ClassificationResult<Value>> {
    requests.push(request)
    const hermes = options.hermes?.(request.workload) ?? false
    let value: unknown; let answers: Record<string, JevAnswer>
    if (request.workload.endsWith('entity_placement')) {
      value = options.placement === 'uncertain' ? { entityId: null, disposition: 'uncertain' } : { entityId: 'bitcoin', disposition: 'selected' }
      answers = { placement: answer(options.placement === 'uncertain' ? 'uncertain' : 'bitcoin') }
    } else if (request.workload.endsWith('related_membership')) { value = { dispositions: { blackrock: 'related' } }; answers = { related_blackrock: answer('related') } }
    else if (request.workload.endsWith('story_relationship')) {
      const state = request.state as { entity: { id: string } }
      value = { relationship: 'direct_continuation', priorItemId: `${state.entity.id}-0` }
      answers = { relationship: answer('direct_continuation'), prior_item: answer(`${state.entity.id}-0`) }
    } else { value = { verdict: options.novelty ?? 'new_information' }; answers = { novelty: answer(options.novelty ?? 'new_information') } }
    const base = { ...v4ClassificationResult(value as Value), workload: request.workload, decisionVersion: request.decisionVersion }
    return hermes
      ? { ...base, answers: null, actualProvider: 'ollama-cloud', actualModel: 'glm-5.3-flash', fallbackUsed: true, fallbackReason: 'provider_billing' }
      : { ...base, answers, actualProvider: 'typesafe', actualModel: 'jev-1.13.0', fallbackUsed: false, fallbackReason: null }
  } }
  return { gateway, requests }
}

test('#308 flag off keeps v1 decisions and base decision versions', async () => {
  const { gateway, requests } = fallbackGateway()
  const result = await prepareArticlePlacement({ gateway, stableDecisionKey: 'k', signal, sourceText: 'BlackRock added Bitcoin.', context: context() })
  assert.equal('provider' in result.memberships[0].placement, false)
  assert.equal(result.memberships[0].placement.probabilities.bitcoin, .95)
  assert.equal('provider' in result.novelty, false)
  assert.notEqual(requests[0].decisionVersion, ARTICLE_ENTITY_PLACEMENT_HERMES_FALLBACK_VERSION)
})

test('#308 flag on with Jev results gives v2 jev decisions with model', async () => {
  const { gateway, requests } = fallbackGateway()
  const result = await prepareArticlePlacement({ gateway, stableDecisionKey: 'k', signal, sourceText: 'BlackRock added Bitcoin.', context: context(), useHermesFallbackVersions: true })
  const placement = result.memberships[0].placement
  assert.equal(placement.provider, 'jev')
  if (placement.provider === 'jev') { assert.equal(placement.model, 'jev-1.13.0'); assert.equal(placement.probabilities.bitcoin, .95) }
  assert.equal(result.novelty.provider, 'jev')
  assert.equal(requests[0].decisionVersion, ARTICLE_ENTITY_PLACEMENT_HERMES_FALLBACK_VERSION)
  assert.equal(requests.at(-1)!.decisionVersion, ARTICLE_NOVELTY_HERMES_FALLBACK_VERSION)
})

// #343 change 2: a Hermes result has no numeric confidence, so it now counts
// as below the primary-placement floor; this provenance dispatch rejects with
// entity_resolution_uncertain instead of recording Hermes placement provenance.
test('#308 flag on with a Hermes result holds without a confidence score', async () => {
  const { gateway, requests } = fallbackGateway({ hermes: () => true })
  await assert.rejects(
    prepareArticlePlacement({ gateway, stableDecisionKey: 'k', signal, sourceText: 'BlackRock added Bitcoin.', context: context(), useHermesFallbackVersions: true }),
    (error: unknown) => error instanceof ArticleResearchHold && error.code === 'entity_resolution_uncertain'
      && /no confidence score \(provider hermes\)/.test(error.message),
  )
  assert.equal(requests[0].decisionVersion, ARTICLE_ENTITY_PLACEMENT_HERMES_FALLBACK_VERSION)
})

test('#308 Hermes uncertain placement and novelty hold instead of saving a default', async () => {
  const placement = fallbackGateway({ hermes: () => true, placement: 'uncertain' })
  await assert.rejects(prepareArticlePlacement({ gateway: placement.gateway, stableDecisionKey: 'k', signal, sourceText: 'x', context: context(), useHermesFallbackVersions: true }), /could not safely resolve/)
  const novelty = fallbackGateway({ hermes: w => w.endsWith('novelty'), novelty: 'uncertain' })
  await assert.rejects(prepareArticlePlacement({ gateway: novelty.gateway, stableDecisionKey: 'k', signal, sourceText: 'x', context: context(), useHermesFallbackVersions: true }), /Hermes fallback novelty is uncertain/)
})

// #308 patch 5A: flag-gated staged batching (useBatching).
type BatchAnswerOverrides = {
  catalogue?: (state: { article: { title: string, text: string }, candidates: Array<{ id: string }> }) => {
    entityId: string | null
    disposition: 'selected' | 'no_match' | 'uncertain'
    dispositions: Record<string, 'related' | 'not_related' | 'uncertain'>
  }
  relationship?: (state: { entities: Array<{ id: string, name: string, recentItems: Array<{ id: string, source: string }> }> }) => Array<{ entityId: string, relationship: string, priorItemId: string | null }>
  /** Raw (undecoded) decision value, e.g. a durable saved result replayed verbatim. */
  relationshipRaw?: (state: { entities: Array<{ id: string }> }) => unknown
  /** Resolves the relationship batch dispatch as a Hermes fallback result carrying these targets. */
  relationshipHermes?: (state: { entities: Array<{ id: string }> }) => Array<{ entityId: string, relationship: string, priorItemId: string | null }>
  /** Resolves the catalogue batch dispatch as a Hermes fallback result (no Jev answers). */
  catalogueHermes?: boolean
}

// Mocked gateway whose batched answers are decoded through the real registry
// definitions, so the test proves the request/state and answer wire format.
function batchedGateway(options: BatchAnswerOverrides = {}) {
  const requests: ClassificationRequest[] = []
  const gateway = {
    recordPolicyOutcome() {},
    async classify<Value>(request: ClassificationRequest): Promise<ClassificationResult<Value>> {
      requests.push(request)
      if (request.workload === 'research.article_catalogue_batch') {
        const state = request.state as { article: { title: string, text: string }, candidates: Array<{ id: string }> }
        const validated = articleCatalogueBatchDefinition().validateState(state)
        assert.equal(validated.valid, true)
        const planned = options.catalogue?.(state) ?? {
          entityId: 'bitcoin', disposition: 'selected' as const,
          dispositions: { bitcoin: 'not_related', blackrock: 'related' } as Record<string, 'related' | 'not_related' | 'uncertain'>,
        }
        // A Hermes fallback result carries a validated decision value with no
        // Jev answers, decoded through the real batch fallback validator.
        if (options.catalogueHermes === true) {
          const decoded = articleCatalogueBatchDefinition(undefined, { articleHermesFallback: true }).validateHermes!(
            { entityId: planned.entityId ?? planned.disposition, dispositions: planned.dispositions }, validated.value,
          )
          assert.equal(decoded.valid, true)
          if (!decoded.valid) throw new Error('unreachable')
          return { ...v4ClassificationResult(decoded.value as Value), workload: request.workload, decisionVersion: request.decisionVersion, answers: null, actualProvider: 'ollama-cloud', actualModel: 'glm-5.3-flash', fallbackUsed: true, fallbackReason: 'provider_billing' } as ClassificationResult<Value>
        }
        const answers = {
          placement: answer(planned.entityId ?? planned.disposition),
          ...Object.fromEntries(state.candidates.map((candidate) => [`related_${candidate.id}`, answer(planned.dispositions[candidate.id] ?? 'not_related')])),
        }
        const decoded = articleCatalogueBatchDefinition().decodeJev(answers, validated.value)
        assert.equal(decoded.valid, true)
        if (!decoded.valid) throw new Error('unreachable')
        return { ...v4ClassificationResult(decoded.value as Value), workload: request.workload, decisionVersion: request.decisionVersion, answers }
      }
      if (request.workload === 'research.article_relationship_batch') {
        const state = request.state as { entities: Array<{ id: string, name: string, recentItems: Array<{ id: string, source: string }> }> }
        const raw = options.relationshipRaw?.(state)
        if (raw !== undefined) {
          return { ...v4ClassificationResult(raw as Value), workload: request.workload, decisionVersion: request.decisionVersion, answers: {} } as ClassificationResult<Value>
        }
        const validated = articleRelationshipBatchDefinition().validateState(state)
        assert.equal(validated.valid, true)
        // A Hermes fallback result carries its validated decision value with
        // no Jev answers; a duplicate target is demoted to uncertain by the
        // real batch validator before this point.
        const hermesTargets = options.relationshipHermes?.(state)
        if (hermesTargets) {
          const decoded = articleRelationshipBatchDefinition(undefined, { articleHermesFallback: true }).validateHermes!(
            { targets: hermesTargets }, validated.value,
          )
          assert.equal(decoded.valid, true)
          if (!decoded.valid) throw new Error('unreachable')
          return { ...v4ClassificationResult(decoded.value as Value), workload: request.workload, decisionVersion: request.decisionVersion, answers: null, actualProvider: 'ollama-cloud', actualModel: 'glm-5.3-flash', fallbackUsed: true, fallbackReason: 'provider_billing' } as ClassificationResult<Value>
        }
        const targets = options.relationship?.(state) ?? state.entities.map((entity) => ({ entityId: entity.id, relationship: 'direct_continuation', priorItemId: `${entity.id}-0` }))
        const answers = Object.fromEntries(state.entities.map((entity) => {
          const target = targets.find((item) => item.entityId === entity.id)!
          return [`relationship_target_${entity.id}`, answer(target.priorItemId === null && target.relationship !== 'uncertain' ? target.relationship : `${target.relationship}:${target.priorItemId === null ? '' : 'legacy:'}${target.priorItemId ?? ''}`)]
        }))
        const decoded = articleRelationshipBatchDefinition().decodeJev(answers, validated.value)
        assert.equal(decoded.valid, true)
        if (!decoded.valid) throw new Error('unreachable')
        return { ...v4ClassificationResult(decoded.value as Value), workload: request.workload, decisionVersion: request.decisionVersion, answers }
      }
      if (request.workload.endsWith('entity_proposal_validation')) {
        return { ...v4ClassificationResult({ disposition: 'accept' } as Value), workload: request.workload, decisionVersion: request.decisionVersion, answers: { proposal: answer('accept') } } as ClassificationResult<Value>
      }
      if (request.workload.endsWith('story_relationship')) {
        return { ...v4ClassificationResult({ relationship: 'same_topic_only', priorItemId: null } as Value), workload: request.workload, decisionVersion: request.decisionVersion, answers: { relationship_target: answer('same_topic_only') } } as ClassificationResult<Value>
      }
      return { ...v4ClassificationResult({ verdict: 'new_information' } as Value), workload: request.workload, decisionVersion: request.decisionVersion, answers: { novelty: answer('new_information') } } as ClassificationResult<Value>
    },
  }
  return { gateway, requests }
}

const batchedContext = () => context()

test('#5A batching flag off keeps the exact five-dispatch sequence', async () => {
  const { gateway, requests } = fallbackGateway()
  const result = await prepareArticlePlacement({ gateway, stableDecisionKey: 'k', signal, sourceText: 'BlackRock added Bitcoin.', context: batchedContext(), useBatching: false })
  assert.equal(requests.length, 5)
  assert.deepEqual(result.memberships.map(m => [m.entityId, m.role]), [['bitcoin', 'primary'], ['blackrock', 'related']])
  assert.equal(requests.some((request) => request.workload === 'research.article_catalogue_batch'), false)
  assert.equal(requests.some((request) => request.workload === 'research.article_relationship_batch'), false)
})

test('#5A batching flag on uses exactly three dispatches with the same memberships and links', async () => {
  const articleText = 'BlackRock added $1.5 billion in Bitcoin holdings.'
  const { gateway, requests } = batchedGateway()
  const result = await prepareArticlePlacement({ gateway, stableDecisionKey: 'k', signal, sourceText: articleText, context: batchedContext(), useBatching: true })
  assert.equal(requests.length, 3)
  assert.deepEqual(requests.map((request) => request.workload), [
    'research.article_catalogue_batch', 'research.article_relationship_batch', 'research.article_novelty',
  ])
  assert.deepEqual(requests.map((request) => request.decisionVersion), [
    'research.article_catalogue_batch.v1', 'research.article_relationship_batch.v1', 'research.article_novelty.v2',
  ])
  assert.deepEqual(result.memberships.map(m => [m.entityId, m.role]), [['bitcoin', 'primary'], ['blackrock', 'related']])
  // The joint relationship answers continue each supplied prior item and
  // record new information, matching the unbatched fixture decisions.
  assert.equal(result.memberships[0].relationship, 'direct_continuation')
  assert.equal(result.memberships[0].priorItemId, 'bitcoin-0')
  assert.equal(result.memberships[1].relationship, 'direct_continuation')
  assert.equal(result.memberships[1].priorItemId, 'blackrock-0')
  assert.equal(result.novelty.choice, 'new_information')
  // The article text appears exactly once per batched request.
  for (const request of requests.slice(0, 2)) {
    const article = request.state as { article: { text?: string, sourceText?: string } }
    assert.equal(article.article.text ?? article.article.sourceText, articleText)
    assert.equal(JSON.stringify(request.state).split(articleText).length - 1, 1, `${request.workload} must carry the article text exactly once`)
  }
  assert.deepEqual((requests[0].state as { candidates: Array<{ id: string }> }).candidates.map((candidate) => candidate.id), ['bitcoin', 'blackrock'])
  // One shared state carries placement plus one membership Choice per candidate.
  const catalogueQuestions = articleCatalogueBatchDefinition().questions(requests[0].state as ArticleCatalogueBatchState)
  assert.deepEqual(Object.keys(catalogueQuestions), ['placement', 'related_bitcoin', 'related_blackrock'])
  const relationshipQuestions = articleRelationshipBatchDefinition().questions(requests[1].state as ArticleRelationshipBatchState)
  assert.deepEqual(Object.keys(relationshipQuestions), ['relationship_target_bitcoin', 'relationship_target_blackrock'])
})

test('#5A batched Hermes fallback versions target the batch fallback registry', async () => {
  const articleText = 'BlackRock added $1.5 billion in Bitcoin holdings.'
  const { gateway, requests } = batchedGateway()
  const result = await prepareArticlePlacement({ gateway, stableDecisionKey: 'k', signal, sourceText: articleText, context: batchedContext(), useBatching: true, useHermesFallbackVersions: true })
  assert.equal(requests.length, 3)
  assert.deepEqual(requests.map((request) => request.decisionVersion), [
    'research.article_catalogue_batch.v2', 'research.article_relationship_batch.v2', 'research.article_novelty.v3',
  ])
  assert.deepEqual(result.memberships.map(m => [m.entityId, m.role]), [['bitcoin', 'primary'], ['blackrock', 'related']])
  assert.equal(result.novelty.provider, 'jev')
})

test('#5A oversized batched catalogue splits deterministically by candidate id', async () => {
  const articleText = 'BlackRock added $1.5 billion in Bitcoin holdings.'
  // A ranked catalogue whose projected state exceeds the 96,000-byte bound
  // splits deterministically, sorted by candidate id, never truncated.
  const bulky = (id: string) => ({ id, name: `Entity ${id}`, aliases: id === 'blackrock' ? ['BlackRock'] : [], summary: null, scope: { blob: 'x'.repeat(3_100) } })
  const ids = ['blackrock', ...Array.from({ length: 30 }, (_, i) => `entity-${String(i).padStart(2, '0')}`)]
  const { gateway, requests } = batchedGateway()
  const result = await prepareArticlePlacement({ gateway, stableDecisionKey: 'k', signal, sourceText: articleText,
    context: { ...batchedContext(), candidates: [{ id: 'bitcoin', name: 'Bitcoin', aliases: ['BTC'], summary: 'Bitcoin news.', scope: { category: 'asset' } }, ...ids.map(bulky)] }, useBatching: true })
  const batchIds = requests.filter((item) => item.workload === 'research.article_catalogue_batch')
    .map((request) => (request.state as { candidates: Array<{ id: string }> }).candidates.map((candidate) => candidate.id))
  assert.equal(batchIds.length >= 2, true)
  for (const batch of batchIds) assert.deepEqual([...batch].sort(), batch)
  assert.deepEqual(batchIds.flat(), ['bitcoin', 'blackrock', ...Array.from({ length: 30 }, (_, i) => `entity-${String(i).padStart(2, '0')}`)].sort())
  assert.equal(result.memberships[0].entityId, 'bitcoin')
  assert.equal(result.memberships.some((membership) => membership.entityId === 'blackrock' && membership.role === 'related'), true)
  for (const request of requests.filter((item) => item.workload === 'research.article_catalogue_batch')) {
    const serialized = JSON.stringify(request.state)
    assert.ok(serialized.length <= ARTICLE_DECISION_STATE_MAX_BYTES)
    assert.equal(serialized.split(articleText).length - 1, 1)
  }
})

test('#5A a batched catalogue candidate that cannot fit a bounded batch is held, never truncated', async () => {
  // Summary projection is excerpt-bounded, so state inflation comes from an
  // unbounded scope record. A single candidate larger than one bounded batch
  // cannot be split further and must hold instead of cutting content.
  const oversized = { id: 'zed-entity', name: 'Zed Entity', aliases: [], summary: null, scope: { blob: 'x'.repeat(97_000) } }
  const { gateway, requests } = batchedGateway()
  await assert.rejects(
    prepareArticlePlacement({ gateway, stableDecisionKey: 'k', signal, sourceText: 'x', context: { ...batchedContext(), candidates: [oversized] }, useBatching: true }),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'decision_state_too_large',
  )
  assert.equal(requests.length, 0)
})

test('#5A batched route holds on uncertain batched placement', async () => {
  const uncertain = batchedGateway({ catalogue: () => ({ entityId: null, disposition: 'uncertain', dispositions: { bitcoin: 'uncertain', blackrock: 'uncertain' } }) })
  await assert.rejects(
    prepareArticlePlacement({ gateway: uncertain.gateway, stableDecisionKey: 'k', signal, sourceText: 'x', context: batchedContext(), useBatching: true }),
    /could not safely resolve/,
  )
})

test('#5A batched no-match defers to the configured creation proposal without folding memberships', async () => {
  let proposalCalls = 0
  const creation = batchedGateway({
    catalogue: () => ({ entityId: null, disposition: 'no_match', dispositions: { bitcoin: 'not_related', blackrock: 'not_related' } }),
  })
  await assert.rejects(prepareArticlePlacement({ gateway: creation.gateway, stableDecisionKey: 'k', signal, sourceText: 'x', context: batchedContext(), useBatching: true,
    proposeCreation: async () => { proposalCalls += 1; throw new Error('proposal generated') } }), /proposal generated/)
  assert.equal(proposalCalls, 1)
  const noConfig = batchedGateway({
    catalogue: () => ({ entityId: null, disposition: 'no_match', dispositions: { bitcoin: 'not_related', blackrock: 'not_related' } }),
  })
  await assert.rejects(prepareArticlePlacement({ gateway: noConfig.gateway, stableDecisionKey: 'k', signal, sourceText: 'x', context: batchedContext(), useBatching: true }),
    /no durable source-grounded creation proposal is configured/)
})

test('#5A batched relationship stage keeps the older targeted duplicate lookup separate', async () => {
  let olderLookups = 0
  const { gateway, requests } = batchedGateway({
    relationship: (state) => state.entities.map((entity) => ({ entityId: entity.id, relationship: 'same_topic_only', priorItemId: null })),
  })
  const contextWithOlder = {
    ...batchedContext(),
    lookupOlderDuplicate: async () => {
      olderLookups += 1
      return Array.from({ length: 3 }, (_, i) => ({ id: `old-${i}`, source: 'legacy' as const, title: `Older development ${i}`, summary: `Older ${i}.`, eventAt: '2026-09-01T00:00:00Z' }))
    },
  }
  // Article text mentions both candidates so both stay selected under the
  // #343 related-membership mention gate.
  await prepareArticlePlacement({ gateway, stableDecisionKey: 'k', signal, sourceText: 'Bitcoin and BlackRock developments.', context: contextWithOlder, useBatching: true })
  // The joint stage said not-a-duplicate, so each selected entity consults the
  // bounded older lookup as its own separate dispatch, exactly one per entity.
  assert.equal(olderLookups, 2)
  assert.equal(requests.filter((request) => request.workload === 'research.article_story_relationship').length, 2)
})

test('#5A a batched duplicate without a valid target holds', async () => {
  // A tampered durable result (never decodable from a Jev answer) names a
  // duplicate target outside the entity history; placement holds anyway.
  const duplicate = batchedGateway({
    relationshipRaw: (state) => ({
      targets: state.entities.map((entity) => ({ entityId: entity.id, relationship: 'duplicate', priorItemId: 'missing-item' })),
    }),
  })
  await assert.rejects(
    prepareArticlePlacement({ gateway: duplicate.gateway, stableDecisionKey: 'k', signal, sourceText: 'x', context: batchedContext(), useBatching: true }),
    /duplicate without a valid durable historical target/,
  )
})

// #308 remark (c)4: a split catalogue answers placement once per batch; the
// primary may be chosen only from pooled placements that agree.
function splitCataloguePlacements(placements: Array<{ entityId: string | null, disposition: 'selected' | 'no_match' | 'uncertain' }>) {
  // Three candidates whose states each exceed half the 96,000-byte bound force
  // exactly one bounded batch per candidate, so every placement judgment gets
  // its own catalogue dispatch in candidate-id order.
  const candidates = ['a-01', 'a-02', 'a-03'].map((id) => ({ id, name: `Entity ${id}`, aliases: [], summary: null, scope: { blob: 'x'.repeat(50_000) } }))
  let catalogueCalls = 0
  const { gateway, requests } = batchedGateway({
    catalogue: (state) => {
      const judgment = placements[catalogueCalls] ?? { entityId: null, disposition: 'no_match' as const }
      catalogueCalls += 1
      const dispositions = Object.fromEntries(state.candidates.map((candidate) => [candidate.id, 'not_related' as const]))
      return { ...judgment, dispositions }
    },
    relationship: (state) => state.entities.map((entity) => ({ entityId: entity.id, relationship: 'same_topic_only', priorItemId: null })),
  })
  return { gateway, requests, candidates }
}

test('#5A conflicting batch selections hold instead of a first-batch win', async () => {
  const { gateway, requests, candidates } = splitCataloguePlacements([
    { entityId: 'a-01', disposition: 'selected' }, { entityId: 'a-02', disposition: 'selected' }, { entityId: null, disposition: 'no_match' },
  ])
  await assert.rejects(
    prepareArticlePlacement({ gateway, stableDecisionKey: 'k', signal, sourceText: 'x', context: { ...batchedContext(), candidates }, useBatching: true }),
    (error: unknown) => error instanceof ArticleResearchHold && error.code === 'entity_resolution_uncertain'
      && /conflicting primaries/.test(error.message),
  )
  assert.equal(requests.filter((request) => request.workload === 'research.article_catalogue_batch').length, 3)
  assert.equal(requests.some((request) => request.workload.endsWith('novelty')), false)
})

test('#5A a consistent single batch selection proceeds with the existing memberships', async () => {
  const { gateway, requests, candidates } = splitCataloguePlacements([
    { entityId: 'a-01', disposition: 'selected' }, { entityId: null, disposition: 'no_match' }, { entityId: null, disposition: 'no_match' },
  ])
  const result = await prepareArticlePlacement({ gateway, stableDecisionKey: 'k', signal, sourceText: 'x', context: { ...batchedContext(), candidates }, useBatching: true })
  assert.deepEqual(result.memberships.map((membership) => [membership.entityId, membership.role]), [['a-01', 'primary']])
  assert.equal(requests.filter((request) => request.workload === 'research.article_catalogue_batch').length, 3)
  assert.equal(result.novelty.choice, 'new_information')
})

test('#5A a batch selection made while another batch is uncertain holds', async () => {
  const { gateway, requests, candidates } = splitCataloguePlacements([
    { entityId: 'a-01', disposition: 'selected' }, { entityId: null, disposition: 'uncertain' }, { entityId: null, disposition: 'no_match' },
  ])
  await assert.rejects(
    prepareArticlePlacement({ gateway, stableDecisionKey: 'k', signal, sourceText: 'x', context: { ...batchedContext(), candidates }, useBatching: true }),
    (error: unknown) => error instanceof ArticleResearchHold && error.code === 'entity_resolution_uncertain'
      && /selected a primary while another batch was uncertain/.test(error.message),
  )
  assert.equal(requests.filter((request) => request.workload === 'research.article_catalogue_batch').length, 3)
  assert.equal(requests.some((request) => request.workload.endsWith('novelty')), false)
})

// #308 remark (c)6: the validators demote a Hermes duplicate to an uncertain
// relationship; novelty must never save that duplicate as new information.
test('#308 an uncertain Hermes story relationship holds instead of passing through novelty (unbatched)', async () => {
  const c = context(); c.candidates = c.candidates.slice(0, 1)
  const gateway = { recordPolicyOutcome() {}, async classify<Value>(request: ClassificationRequest): Promise<ClassificationResult<Value>> {
    let value: unknown; let answers: Record<string, JevAnswer> | null
    if (request.workload.endsWith('entity_placement')) { value = { entityId: 'bitcoin', disposition: 'selected' }; answers = { placement: answer('bitcoin') } }
    else if (request.workload.endsWith('story_relationship')) {
      value = { relationship: 'uncertain', priorItemId: null }
      answers = null
      return { ...v4ClassificationResult(value as Value), workload: request.workload, decisionVersion: request.decisionVersion, answers, actualProvider: 'ollama-cloud', actualModel: 'glm-5.3-flash', fallbackUsed: true, fallbackReason: 'provider_billing' } as ClassificationResult<Value>
    }
    else { value = { verdict: 'new_information' }; answers = { novelty: answer('new_information') } }
    return { ...v4ClassificationResult(value as Value), workload: request.workload, decisionVersion: request.decisionVersion, answers }
  } }
  await assert.rejects(
    prepareArticlePlacement({ gateway, stableDecisionKey: 'k', signal, sourceText: 'x', context: c, useHermesFallbackVersions: true }),
    (error: unknown) => error instanceof ArticleResearchHold && error.code === 'entity_resolution_uncertain'
      && /Hermes story relationship for bitcoin is uncertain/.test(error.message),
  )
  // A durable result replayed without its raw Jev answers (a disabled Jev
  // lifecycle dispatched Hermes directly) is the same Hermes provenance.
  const replayed = { recordPolicyOutcome() {}, async classify<Value>(request: ClassificationRequest): Promise<ClassificationResult<Value>> {
    let value: unknown; let answers: Record<string, JevAnswer> | null
    if (request.workload.endsWith('entity_placement')) { value = { entityId: 'bitcoin', disposition: 'selected' }; answers = { placement: answer('bitcoin') } }
    else if (request.workload.endsWith('story_relationship')) { value = { relationship: 'uncertain', priorItemId: null }; answers = null }
    else { value = { verdict: 'new_information' }; answers = { novelty: answer('new_information') } }
    return { ...v4ClassificationResult(value as Value), workload: request.workload, decisionVersion: request.decisionVersion, answers } as ClassificationResult<Value>
  } }
  await assert.rejects(
    prepareArticlePlacement({ gateway: replayed, stableDecisionKey: 'k', signal, sourceText: 'x', context: c, useHermesFallbackVersions: true }),
    (error: unknown) => error instanceof ArticleResearchHold && error.code === 'entity_resolution_uncertain'
      && /Hermes story relationship for bitcoin is uncertain/.test(error.message),
  )
})

test('#308 an uncertain Hermes story relationship holds instead of passing through novelty (batched)', async () => {
  const { gateway, requests } = batchedGateway({ relationshipHermes: (state) => state.entities.map((entity) => ({ entityId: entity.id, relationship: 'duplicate', priorItemId: `${entity.id}-0` })) })
  await assert.rejects(
    prepareArticlePlacement({ gateway, stableDecisionKey: 'k', signal, sourceText: 'x', context: batchedContext(), useBatching: true, useHermesFallbackVersions: true }),
    (error: unknown) => error instanceof ArticleResearchHold && error.code === 'entity_resolution_uncertain'
      && /Hermes story relationship for bitcoin is uncertain/.test(error.message),
  )
  assert.equal(requests.some((request) => request.workload.endsWith('novelty')), false)
})

test('#308 an uncertain Jev story relationship still passes through placement unchanged', async () => {
  const c = context(); c.candidates = c.candidates.slice(0, 1)
  const gateway = { recordPolicyOutcome() {}, async classify<Value>(request: ClassificationRequest): Promise<ClassificationResult<Value>> {
    let value: unknown; let answers: Record<string, JevAnswer>
    if (request.workload.endsWith('entity_placement')) { value = { entityId: 'bitcoin', disposition: 'selected' }; answers = { placement: answer('bitcoin') } }
    else if (request.workload.endsWith('story_relationship')) { value = { relationship: 'uncertain', priorItemId: null }; answers = { relationship_target: answer('uncertain') } }
    else { value = { verdict: 'new_information' }; answers = { novelty: answer('new_information') } }
    return { ...v4ClassificationResult(value as Value), workload: request.workload, decisionVersion: request.decisionVersion, answers }
  } }
  const result = await prepareArticlePlacement({ gateway, stableDecisionKey: 'k', signal, sourceText: 'x', context: c, useHermesFallbackVersions: true })
  assert.deepEqual(result.memberships.map((membership) => [membership.entityId, membership.role, membership.relationship]), [['bitcoin', 'primary', 'uncertain']])
  assert.equal(result.novelty.choice, 'new_information')
})

// #343 PR-A (placement quality): mention check for related entities and Jev
// confidence floors. A related candidate must be mentioned in the article
// (title plus captured text) by name or alias; a scored Jev decision below the
// floor holds the article as uncertain instead of saving it as certain, and a
// decision without a numeric confidence score — for example a Hermes fallback
// decision — counts as below the floor and holds the article as uncertain too.

/** A Jev Choice with a tunable confidence; the two probabilities sum to 1. */
const floorAnswer = (key: string, confidence: number): JevAnswer => ({ type: 'choice', choice: key, confidence, probabilities: { [key]: confidence, alternative: 1 - confidence } })

// Placement selects bitcoin and Jev marks blackrock related; relationships
// stay unlinked (same_topic_only) so the mention check is the only membership
// filter under test.
function mentionGateway() {
  const requests: ClassificationRequest[] = []
  const gateway = { recordPolicyOutcome() {}, async classify<Value>(request: ClassificationRequest): Promise<ClassificationResult<Value>> {
    requests.push(request)
    let value: unknown; let answers: Record<string, JevAnswer>
    if (request.workload.endsWith('entity_placement')) { value = { entityId: 'bitcoin', disposition: 'selected' }; answers = { placement: answer('bitcoin') } }
    else if (request.workload.endsWith('related_membership')) { value = { dispositions: { blackrock: 'related' } }; answers = { related_blackrock: answer('related') } }
    else if (request.workload.endsWith('story_relationship')) { value = { relationship: 'same_topic_only', priorItemId: null }; answers = { relationship_target: answer('same_topic_only') } }
    else { value = { verdict: 'new_information' }; answers = { novelty: answer('new_information') } }
    return { ...v4ClassificationResult(value as Value), workload: request.workload, decisionVersion: request.decisionVersion, answers }
  } }
  return { gateway, requests }
}

test('#343 related entity not mentioned in the article is rejected', async () => {
  // The managed fixture title is 'Acme statement' and this text carries no
  // BlackRock token, so Jev's related judgment must be rejected code-side.
  const { gateway, requests } = mentionGateway()
  const result = await prepareArticlePlacement({ gateway, stableDecisionKey: 'mention-reject', signal, sourceText: 'Bitcoin rose 4% today.', context: context() })
  assert.deepEqual(result.memberships.map((membership) => [membership.entityId, membership.role]), [['bitcoin', 'primary']])
  // One story-relationship dispatch (bitcoin only); the rejected candidate
  // never joins the memberships.
  assert.deepEqual(requests.map((request) => request.workload), [
    'research.article_entity_placement', 'research.article_related_membership', 'research.article_story_relationship', 'research.article_novelty',
  ])
})

test('#343 related entity mentioned by alias is accepted', async () => {
  const { gateway, requests } = mentionGateway()
  const aliasContext = context()
  aliasContext.candidates[1] = { ...aliasContext.candidates[1], aliases: ['BLK'] }
  const result = await prepareArticlePlacement({ gateway, stableDecisionKey: 'mention-alias', signal, sourceText: 'BLK bought more Bitcoin.', context: aliasContext })
  assert.deepEqual(result.memberships.map((membership) => [membership.entityId, membership.role]), [['bitcoin', 'primary'], ['blackrock', 'related']])
  assert.equal(requests.length, 5)
})

test('#343 primary is unaffected by the mention check', async () => {
  const { gateway } = mentionGateway()
  const result = await prepareArticlePlacement({ gateway, stableDecisionKey: 'mention-primary', signal, sourceText: 'A major development happened.', context: context() })
  assert.equal(result.memberships[0].name, 'Bitcoin')
  assert.equal(result.memberships[0].role, 'primary')
  assert.equal(result.memberships[0].placementDisposition, 'selected')
  assert.deepEqual(result.memberships.map((membership) => [membership.entityId, membership.role]), [['bitcoin', 'primary']])
})

// Placement answers with a tunable Jev confidence; the related candidate stays
// not_related and relationships stay unlinked so the primary floor is the only
// gate under test. `batched` answers the staged catalogue dispatch route.
function floorGateway(placementAnswer: JevAnswer, batched = false) {
  const requests: ClassificationRequest[] = []
  const gateway = { recordPolicyOutcome() {}, async classify<Value>(request: ClassificationRequest): Promise<ClassificationResult<Value>> {
    requests.push(request)
    let value: unknown; let answers: Record<string, JevAnswer>
    if (request.workload === 'research.article_catalogue_batch') {
      value = { entityId: 'bitcoin', disposition: 'selected', dispositions: { bitcoin: 'not_related', blackrock: 'not_related' } }
      answers = { placement: placementAnswer, related_bitcoin: answer('not_related'), related_blackrock: answer('not_related') }
    }
    else if (request.workload === 'research.article_relationship_batch') {
      value = { targets: [{ entityId: 'bitcoin', relationship: 'same_topic_only', priorItemId: null }] }
      answers = { relationship_target_bitcoin: answer('same_topic_only') }
    }
    else if (request.workload.endsWith('entity_placement')) { value = { entityId: 'bitcoin', disposition: 'selected' }; answers = { placement: placementAnswer } }
    else if (request.workload.endsWith('related_membership')) { value = { dispositions: { blackrock: 'not_related' } }; answers = { related_blackrock: answer('not_related') } }
    else if (request.workload.endsWith('story_relationship')) { value = { relationship: 'same_topic_only', priorItemId: null }; answers = { relationship_target: answer('same_topic_only') } }
    else { value = { verdict: 'new_information' }; answers = { novelty: answer('new_information') } }
    return { ...v4ClassificationResult(value as Value), workload: request.workload, decisionVersion: request.decisionVersion, answers }
  } }
  return { gateway, requests }
}

test('#343 a 0.44 primary placement is never saved as certain', async () => {
  const single = floorGateway(floorAnswer('bitcoin', .44))
  await assert.rejects(
    prepareArticlePlacement({ gateway: single.gateway, stableDecisionKey: 'floor-single', signal, sourceText: 'Bitcoin rose 4% today.', context: context() }),
    (error: unknown) => error instanceof ArticleResearchHold && error.code === 'entity_resolution_uncertain'
      && /0\.44 is below the 0\.6 floor/.test(error.message),
  )
  // The floor assert fires before any related-membership classify call.
  assert.deepEqual(single.requests.map((request) => request.workload), ['research.article_entity_placement'])
  const batched = floorGateway(floorAnswer('bitcoin', .44), true)
  await assert.rejects(
    prepareArticlePlacement({ gateway: batched.gateway, stableDecisionKey: 'floor-batched', signal, sourceText: 'Bitcoin rose 4% today.', context: context(), useBatching: true }),
    (error: unknown) => error instanceof ArticleResearchHold && error.code === 'entity_resolution_uncertain'
      && /0\.44 is below the 0\.6 floor/.test(error.message),
  )
  // The floor assert fires before the batched relationship stage.
  assert.deepEqual(batched.requests.map((request) => request.workload), ['research.article_catalogue_batch'])
})

test('#343 a 0.6 primary placement is accepted', async () => {
  const single = await prepareArticlePlacement({ gateway: floorGateway(floorAnswer('bitcoin', .6)).gateway, stableDecisionKey: 'floor-boundary', signal, sourceText: 'Bitcoin rose 4% today.', context: context() })
  assert.deepEqual(single.memberships.map((membership) => [membership.entityId, membership.role]), [['bitcoin', 'primary']])
  const singlePlacement = single.memberships[0].placement
  assert.equal(singlePlacement.confidence, .6)
  const batchedGatewayRequests = floorGateway(floorAnswer('bitcoin', .6), true)
  const batched = await prepareArticlePlacement({ gateway: batchedGatewayRequests.gateway, stableDecisionKey: 'floor-boundary-batched', signal, sourceText: 'Bitcoin rose 4% today.', context: context(), useBatching: true })
  assert.deepEqual(batched.memberships.map((membership) => [membership.entityId, membership.role]), [['bitcoin', 'primary']])
  const batchedPlacement = batched.memberships[0].placement
  assert.equal('confidence' in batchedPlacement, true)
  if ('confidence' in batchedPlacement) assert.equal(batchedPlacement.confidence, .6)
  assert.deepEqual(batchedGatewayRequests.requests.map((request) => request.workload), ['research.article_catalogue_batch', 'research.article_relationship_batch', 'research.article_novelty'])
})

// The prior-item link floor: direct_continuation relationship/prior-item
// answers at or below the 0.5 floor decide whether the link to bitcoin-0 is
// saved as certain or held as uncertain.
function priorItemGateway(confidence: number) {
  const requests: ClassificationRequest[] = []
  const gateway = { recordPolicyOutcome() {}, async classify<Value>(request: ClassificationRequest): Promise<ClassificationResult<Value>> {
    requests.push(request)
    let value: unknown; let answers: Record<string, JevAnswer>
    if (request.workload.endsWith('entity_placement')) { value = { entityId: 'bitcoin', disposition: 'selected' }; answers = { placement: answer('bitcoin') } }
    else if (request.workload.endsWith('story_relationship')) {
      value = { relationship: 'direct_continuation', priorItemId: 'bitcoin-0' }
      answers = { relationship: floorAnswer('direct_continuation', confidence), prior_item: floorAnswer('bitcoin-0', confidence) }
    }
    else { value = { verdict: 'new_information' }; answers = { novelty: answer('new_information') } }
    return { ...v4ClassificationResult(value as Value), workload: request.workload, decisionVersion: request.decisionVersion, answers }
  } }
  return { gateway, requests }
}

test('#343 a below-floor prior-item link is held', async () => {
  const linkContext = () => { const c = context(); c.candidates = c.candidates.slice(0, 1); return c }
  const held = priorItemGateway(.44)
  await assert.rejects(
    prepareArticlePlacement({ gateway: held.gateway, stableDecisionKey: 'link-floor', signal, sourceText: 'Bitcoin continues the earlier development.', context: linkContext() }),
    (error: unknown) => error instanceof ArticleResearchHold && error.code === 'entity_resolution_uncertain'
      && /0\.44 is below the 0\.5 floor/.test(error.message),
  )
  // The hold fires before novelty; no further dispatch happens.
  assert.deepEqual(held.requests.map((request) => request.workload), ['research.article_entity_placement', 'research.article_story_relationship'])
  const accepted = priorItemGateway(.5)
  const result = await prepareArticlePlacement({ gateway: accepted.gateway, stableDecisionKey: 'link-at-floor', signal, sourceText: 'Bitcoin continues the earlier development.', context: linkContext() })
  assert.equal(result.memberships[0].relationship, 'direct_continuation')
  assert.equal(result.memberships[0].priorItemId, 'bitcoin-0')
  assert.equal(result.novelty.choice, 'new_information')
})

test('#343 batched route rejects an unmentioned related entity', async () => {
  // The shared batched fake marks blackrock related, but the article text
  // mentions only Bitcoin, so the batched route must reject it code-side.
  const { gateway, requests } = batchedGateway()
  const result = await prepareArticlePlacement({ gateway, stableDecisionKey: 'k', signal, sourceText: 'Bitcoin added $1.5 billion in new holdings.', context: batchedContext(), useBatching: true })
  assert.deepEqual(result.memberships.map((membership) => [membership.entityId, membership.role]), [['bitcoin', 'primary']])
  // The rejected candidate is excluded from the relationship stage entirely.
  assert.deepEqual((requests[1].state as { entities: Array<{ id: string }> }).entities.map((entity) => entity.id), ['bitcoin'])
})

test('#343 a custom primaryPlacement floor accepts the 0.44 placement', async () => {
  const { gateway, requests } = floorGateway(floorAnswer('bitcoin', .44))
  const result = await prepareArticlePlacement({ gateway, stableDecisionKey: 'floor-custom', signal, sourceText: 'Bitcoin rose 4% today.', context: context(), confidenceFloors: { primaryPlacement: 0.4 } })
  assert.deepEqual(result.memberships.map((membership) => [membership.entityId, membership.role]), [['bitcoin', 'primary']])
  assert.equal(requests.some((request) => request.workload.endsWith('novelty')), true)
})

// #343 CTO review follow-up: Hermes / no-score decisions count as below the
// floor, the floors are env-configurable, and mention rejections are logged.

// A Hermes fallback result has no numeric confidence score; the primary
// placement floor must hold it as uncertain on both routes.
test('#343 a Hermes primary placement without a confidence score holds on both routes', async () => {
  const hold = (error: unknown) => error instanceof ArticleResearchHold && error.code === 'entity_resolution_uncertain'
    && /no confidence score \(provider hermes\)/.test(error.message)
  const single = fallbackGateway({ hermes: () => true })
  await assert.rejects(
    prepareArticlePlacement({ gateway: single.gateway, stableDecisionKey: 'no-score-single', signal, sourceText: 'BlackRock added Bitcoin.', context: context(), useHermesFallbackVersions: true }),
    hold,
  )
  const batched = batchedGateway({ catalogueHermes: true })
  await assert.rejects(
    prepareArticlePlacement({ gateway: batched.gateway, stableDecisionKey: 'no-score-batched', signal, sourceText: 'BlackRock added Bitcoin.', context: batchedContext(), useBatching: true, useHermesFallbackVersions: true }),
    hold,
  )
})

// A Hermes relationship that links a valid prior item carries no score either;
// the prior-item link floor holds it on both routes.
test('#343 a Hermes prior-item link without a confidence score holds', async () => {
  const hold = (error: unknown) => error instanceof ArticleResearchHold && error.code === 'entity_resolution_uncertain'
    && /no confidence score \(provider hermes\)/.test(error.message)
  // Jev confirms the placement (.95); only the relationship dispatch is Hermes.
  const single = { recordPolicyOutcome() {}, async classify<Value>(request: ClassificationRequest): Promise<ClassificationResult<Value>> {
    let value: unknown; let answers: Record<string, JevAnswer> | null
    if (request.workload.endsWith('entity_placement')) { value = { entityId: 'bitcoin', disposition: 'selected' }; answers = { placement: answer('bitcoin') } }
    else if (request.workload.endsWith('story_relationship')) {
      value = { relationship: 'direct_continuation', priorItemId: 'bitcoin-0' }
      answers = null
      return { ...v4ClassificationResult(value as Value), workload: request.workload, decisionVersion: request.decisionVersion, answers, actualProvider: 'ollama-cloud', actualModel: 'glm-5.3-flash', fallbackUsed: true, fallbackReason: 'provider_billing' } as ClassificationResult<Value>
    }
    else { value = { verdict: 'new_information' }; answers = { novelty: answer('new_information') } }
    return { ...v4ClassificationResult(value as Value), workload: request.workload, decisionVersion: request.decisionVersion, answers }
  } }
  const linkContext = () => { const c = context(); c.candidates = c.candidates.slice(0, 1); return c }
  await assert.rejects(
    prepareArticlePlacement({ gateway: single, stableDecisionKey: 'link-no-score-single', signal, sourceText: 'Bitcoin continues the earlier development.', context: linkContext(), useHermesFallbackVersions: true }),
    hold,
  )
  const batched = batchedGateway({
    relationshipHermes: (state) => state.entities.map((entity) => ({ entityId: entity.id, relationship: 'direct_continuation', priorItemId: `${entity.id}-0` })),
  })
  await assert.rejects(
    prepareArticlePlacement({ gateway: batched.gateway, stableDecisionKey: 'link-no-score-batched', signal, sourceText: 'Bitcoin added $1.5 billion in new holdings.', context: batchedContext(), useBatching: true, useHermesFallbackVersions: true }),
    hold,
  )
})

test('#343 parseArticlePlacementConfidenceFloors reads env values, defaults and rejects loudly', () => {
  assert.deepEqual(parseArticlePlacementConfidenceFloors({}), { primaryPlacement: 0.6, priorItemLink: 0.5 })
  assert.deepEqual(parseArticlePlacementConfidenceFloors({ ARTICLE_PLACEMENT_PRIMARY_FLOOR: '  ', ARTICLE_PLACEMENT_LINK_FLOOR: '' }), { primaryPlacement: 0.6, priorItemLink: 0.5 })
  assert.deepEqual(parseArticlePlacementConfidenceFloors({ [ARTICLE_PLACEMENT_PRIMARY_FLOOR_ENV]: '0.7', [ARTICLE_PLACEMENT_LINK_FLOOR_ENV]: '0.45' }), { primaryPlacement: 0.7, priorItemLink: 0.45 })
  assert.deepEqual(parseArticlePlacementConfidenceFloors({ [ARTICLE_PLACEMENT_PRIMARY_FLOOR_ENV]: ' 0.25 ' }), { primaryPlacement: 0.25, priorItemLink: 0.5 })
  for (const bad of ['abc', '1.5', '-0.1', 'NaN', '0x1', '1e-1']) {
    assert.throws(
      () => parseArticlePlacementConfidenceFloors({ [ARTICLE_PLACEMENT_PRIMARY_FLOOR_ENV]: bad }),
      (error: unknown) => error instanceof Error && error.message === `Invalid ${ARTICLE_PLACEMENT_PRIMARY_FLOOR_ENV}=${JSON.stringify(bad)}: expected a number between 0 and 1.`,
    )
  }
  assert.throws(
    () => parseArticlePlacementConfidenceFloors({ [ARTICLE_PLACEMENT_LINK_FLOOR_ENV]: '1.5' }),
    (error: unknown) => error instanceof Error && error.message === `Invalid ${ARTICLE_PLACEMENT_LINK_FLOOR_ENV}="1.5": expected a number between 0 and 1.`,
  )
  assert.deepEqual(parseArticlePlacementConfidenceFloors({ [ARTICLE_PLACEMENT_PRIMARY_FLOOR_ENV]: '0', [ARTICLE_PLACEMENT_LINK_FLOOR_ENV]: '1' }), { primaryPlacement: 0, priorItemLink: 1 })
})

test('#343 prepareArticlePlacement reads the floor environment and per-call overrides win', async () => {
  const previous = process.env.ARTICLE_PLACEMENT_PRIMARY_FLOOR
  try {
    // The env floor 0.4 accepts the 0.44 placement the 0.6 default holds.
    process.env.ARTICLE_PLACEMENT_PRIMARY_FLOOR = '0.4'
    const envFloors = floorGateway(floorAnswer('bitcoin', .44))
    const result = await prepareArticlePlacement({ gateway: envFloors.gateway, stableDecisionKey: 'floor-env', signal, sourceText: 'Bitcoin rose 4% today.', context: context() })
    assert.deepEqual(result.memberships.map((membership) => [membership.entityId, membership.role]), [['bitcoin', 'primary']])
    // A per-call override beats the environment: the 0.6 placement misses 0.7.
    const override = floorGateway(floorAnswer('bitcoin', .6))
    await assert.rejects(
      prepareArticlePlacement({ gateway: override.gateway, stableDecisionKey: 'floor-env-override', signal, sourceText: 'Bitcoin rose 4% today.', context: context(), confidenceFloors: { primaryPlacement: 0.7 } }),
      (error: unknown) => error instanceof ArticleResearchHold && error.code === 'entity_resolution_uncertain'
        && /0\.6 is below the 0\.7 floor/.test(error.message),
    )
  } finally {
    if (previous === undefined) delete process.env.ARTICLE_PLACEMENT_PRIMARY_FLOOR
    else process.env.ARTICLE_PLACEMENT_PRIMARY_FLOOR = previous
  }
})

test('#343 one info line per route logs the related candidates the mention check rejected', async () => {
  const originalInfo = console.info
  const lines: string[] = []
  console.info = ((...args: unknown[]) => { lines.push(args.map(String).join(' ')) }) as typeof console.info
  try {
    lines.length = 0
    const single = mentionGateway()
    await prepareArticlePlacement({ gateway: single.gateway, stableDecisionKey: 'log-single', signal, sourceText: 'Bitcoin rose 4% today.', context: context() })
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /\[research-engine:placement\]/)
    assert.match(lines[0]!, /related_mention_rejected/)
    assert.match(lines[0]!, /"rejected":1/)
    assert.match(lines[0]!, /blackrock/)
    assert.match(lines[0]!, /"route":"single"/)
    assert.doesNotMatch(lines[0]!, /rose 4%/)
    lines.length = 0
    const batched = batchedGateway()
    await prepareArticlePlacement({ gateway: batched.gateway, stableDecisionKey: 'log-batched', signal, sourceText: 'Bitcoin added $1.5 billion in new holdings.', context: batchedContext(), useBatching: true })
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /related_mention_rejected/)
    assert.match(lines[0]!, /"rejected":1/)
    assert.match(lines[0]!, /blackrock/)
    assert.match(lines[0]!, /"route":"batched"/)
    assert.doesNotMatch(lines[0]!, /holdings/)
  } finally { console.info = originalInfo }
})

// #343 PR-B: Bucket's save-uncertain mode. A floor failure no longer holds:
// the affected membership is saved with placementUncertain true and EVERY
// membership records both placement fields. With the mode off nothing changes.

// a) A 0.44 primary placement (below the 0.6 floor) resolves on both routes
// with the primary membership saved uncertain at its 0.44 confidence.
test('#343 save-uncertain mode saves a below-floor primary placement as uncertain on both routes', async () => {
  const single = floorGateway(floorAnswer('bitcoin', .44))
  const result = await prepareArticlePlacement({ gateway: single.gateway, stableDecisionKey: 'save-uncertain-single', signal, sourceText: 'Bitcoin rose 4% today.', context: context(), saveUncertainPlacements: true })
  assert.deepEqual(result.memberships.map((membership) => [membership.entityId, membership.role]), [['bitcoin', 'primary']])
  assert.equal(result.memberships[0].placementUncertain, true)
  assert.equal(result.memberships[0].placementConfidence, .44)
  const batched = floorGateway(floorAnswer('bitcoin', .44), true)
  const batchedResult = await prepareArticlePlacement({ gateway: batched.gateway, stableDecisionKey: 'save-uncertain-batched', signal, sourceText: 'Bitcoin rose 4% today.', context: context(), useBatching: true, saveUncertainPlacements: true })
  assert.deepEqual(batchedResult.memberships.map((membership) => [membership.entityId, membership.role]), [['bitcoin', 'primary']])
  assert.equal(batchedResult.memberships[0].placementUncertain, true)
  assert.equal(batchedResult.memberships[0].placementConfidence, .44)
})

// b) Above the floors every membership is saved with both fields, uncertain
// false — the annotation itself does not depend on the floor outcome.
test('#343 save-uncertain mode annotates every membership when the floors pass', async () => {
  const { gateway } = fallbackGateway()
  const result = await prepareArticlePlacement({ gateway, stableDecisionKey: 'save-uncertain-certain', signal, sourceText: 'BlackRock added Bitcoin.', context: context(), saveUncertainPlacements: true })
  assert.deepEqual(result.memberships.map((membership) => [membership.entityId, membership.role]), [['bitcoin', 'primary'], ['blackrock', 'related']])
  for (const membership of result.memberships) {
    assert.equal(membership.placementUncertain, false)
    assert.equal(membership.placementConfidence, .95)
  }
})

// c) A Hermes primary placement carries no confidence score; the floor "fails"
// without a score and the membership is saved uncertain at confidence null.
test('#343 save-uncertain mode saves a Hermes no-score primary placement as uncertain on both routes', async () => {
  const single = fallbackGateway({ hermes: () => true })
  const result = await prepareArticlePlacement({ gateway: single.gateway, stableDecisionKey: 'save-uncertain-no-score-single', signal, sourceText: 'BlackRock added Bitcoin.', context: context(), useHermesFallbackVersions: true, saveUncertainPlacements: true })
  const primary = result.memberships.find((membership) => membership.role === 'primary')!
  assert.equal(primary.entityId, 'bitcoin')
  assert.equal(primary.placementUncertain, true)
  assert.equal(primary.placementConfidence, null)
  const batched = batchedGateway({ catalogueHermes: true })
  const batchedResult = await prepareArticlePlacement({ gateway: batched.gateway, stableDecisionKey: 'save-uncertain-no-score-batched', signal, sourceText: 'BlackRock added Bitcoin.', context: batchedContext(), useBatching: true, useHermesFallbackVersions: true, saveUncertainPlacements: true })
  const batchedPrimary = batchedResult.memberships.find((membership) => membership.role === 'primary')!
  assert.equal(batchedPrimary.entityId, 'bitcoin')
  assert.equal(batchedPrimary.placementUncertain, true)
  assert.equal(batchedPrimary.placementConfidence, null)
})

// d) A 0.44 prior-item link (below the 0.5 floor) saves the membership
// uncertain and the direct_continuation relationship, prior item and novelty
// all proceed unchanged.
test('#343 save-uncertain mode saves a below-floor prior-item link as uncertain', async () => {
  const linkContext = () => { const c = context(); c.candidates = c.candidates.slice(0, 1); return c }
  const link = priorItemGateway(.44)
  const result = await prepareArticlePlacement({ gateway: link.gateway, stableDecisionKey: 'save-uncertain-link', signal, sourceText: 'Bitcoin continues the earlier development.', context: linkContext(), saveUncertainPlacements: true })
  assert.equal(result.memberships[0].relationship, 'direct_continuation')
  assert.equal(result.memberships[0].priorItemId, 'bitcoin-0')
  assert.equal(result.memberships[0].placementUncertain, true)
  // The placement confidence stays the placement decision's own 0.95; the
  // failed 0.44 link decision is what marked the membership uncertain.
  assert.equal(result.memberships[0].placementConfidence, .95)
  assert.equal(result.novelty.choice, 'new_information')
  // The relationship stage and novelty both ran despite the link floor failure.
  assert.deepEqual(link.requests.map((request) => request.workload), ['research.article_entity_placement', 'research.article_story_relationship', 'research.article_novelty'])
})

// e) Mode off (the default): floors still hold and packets carry none of the
// new keys, byte-identical to the floors-only behaviour.
test('#343 with save-uncertain mode off the floors still hold and memberships stay unannotated', async () => {
  await assert.rejects(
    prepareArticlePlacement({ gateway: floorGateway(floorAnswer('bitcoin', .44)).gateway, stableDecisionKey: 'save-uncertain-off-floor', signal, sourceText: 'Bitcoin rose 4% today.', context: context() }),
    (error: unknown) => error instanceof ArticleResearchHold && error.code === 'entity_resolution_uncertain'
      && /0\.44 is below the 0\.6 floor/.test(error.message),
  )
  const { gateway } = fallbackGateway()
  const result = await prepareArticlePlacement({ gateway, stableDecisionKey: 'save-uncertain-off-certain', signal, sourceText: 'BlackRock added Bitcoin.', context: context() })
  assert.deepEqual(result.memberships.map((membership) => [membership.entityId, membership.role]), [['bitcoin', 'primary'], ['blackrock', 'related']])
  for (const membership of result.memberships) {
    assert.equal('placementUncertain' in membership, false)
    assert.equal('placementConfidence' in membership, false)
  }
})

// f) The ARTICLE_PLACEMENT_SAVE_UNCERTAIN switch: parser unit cases, the
// environment turning the mode on, and the per-call override still winning.
test('#343 parseArticlePlacementSaveUncertain reads the save-uncertain switch and rejects other values', () => {
  assert.equal(parseArticlePlacementSaveUncertain({}), false)
  assert.equal(parseArticlePlacementSaveUncertain({ [ARTICLE_PLACEMENT_SAVE_UNCERTAIN_ENV]: '  ' }), false)
  assert.equal(parseArticlePlacementSaveUncertain({ [ARTICLE_PLACEMENT_SAVE_UNCERTAIN_ENV]: '' }), false)
  assert.equal(parseArticlePlacementSaveUncertain({ [ARTICLE_PLACEMENT_SAVE_UNCERTAIN_ENV]: 'TRUE' }), true)
  assert.equal(parseArticlePlacementSaveUncertain({ [ARTICLE_PLACEMENT_SAVE_UNCERTAIN_ENV]: '1' }), true)
  assert.equal(parseArticlePlacementSaveUncertain({ [ARTICLE_PLACEMENT_SAVE_UNCERTAIN_ENV]: 'false' }), false)
  assert.equal(parseArticlePlacementSaveUncertain({ [ARTICLE_PLACEMENT_SAVE_UNCERTAIN_ENV]: '0' }), false)
  assert.throws(
    () => parseArticlePlacementSaveUncertain({ [ARTICLE_PLACEMENT_SAVE_UNCERTAIN_ENV]: 'yes' }),
    (error: unknown) => error instanceof Error
      && error.message === `Invalid ${ARTICLE_PLACEMENT_SAVE_UNCERTAIN_ENV}=${JSON.stringify('yes')}: expected true or false.`,
  )
})

test('#343 the save-uncertain environment turns the mode on and the per-call override still wins', async () => {
  const previous = process.env.ARTICLE_PLACEMENT_SAVE_UNCERTAIN
  try {
    process.env.ARTICLE_PLACEMENT_SAVE_UNCERTAIN = 'true'
    const { gateway } = floorGateway(floorAnswer('bitcoin', .44))
    const result = await prepareArticlePlacement({ gateway, stableDecisionKey: 'save-uncertain-env', signal, sourceText: 'Bitcoin rose 4% today.', context: context() })
    assert.equal(result.memberships[0].placementUncertain, true)
    assert.equal(result.memberships[0].placementConfidence, .44)
    const override = floorGateway(floorAnswer('bitcoin', .44))
    await assert.rejects(
      prepareArticlePlacement({ gateway: override.gateway, stableDecisionKey: 'save-uncertain-env-override', signal, sourceText: 'Bitcoin rose 4% today.', context: context(), saveUncertainPlacements: false }),
      (error: unknown) => error instanceof ArticleResearchHold && error.code === 'entity_resolution_uncertain'
        && /0\.44 is below the 0\.6 floor/.test(error.message),
    )
  } finally {
    if (previous === undefined) delete process.env.ARTICLE_PLACEMENT_SAVE_UNCERTAIN
    else process.env.ARTICLE_PLACEMENT_SAVE_UNCERTAIN = previous
  }
})
