import assert from 'node:assert/strict'
import test from 'node:test'
import {
  approvedClassificationDefinitions,
  articleEntityPlacementDefinition,
  articleRelatedMembershipDefinition,
  articleNoveltyDefinition,
  articleStoryRelationshipDefinition,
  researchFollowupValueDefinition,
  researchNoveltyDefinition,
  type ResearchFollowupValueState,
  type ResearchNoveltyState,
} from './classification-definitions'
import { ARTICLE_DECISION_SOURCE_MAX_CHARS } from '../research-engine/article-input-bounds'

test('Research novelty definition is bounded to novelty and defaults fail-safe disabled', () => {
  const definition = researchNoveltyDefinition()
  assert.equal(definition.defaultLifecycleMode, 'disabled')
  assert.equal(definition.maximumLifecycleMode, 'canary')
  const state: ResearchNoveltyState = {
    signal: { source: 'news', sourceRefId: 'article-1', title: 'SEC update', whatChanged: 'SEC approved a conditional exemption.', observedAt: '2026-09-23T00:00:00.000Z' },
    context: {
      entities: [{ id: 'sec', slug: 'sec', name: 'SEC', summary: null }],
      recentMemories: [{ entityId: 'sec', memoryType: 'news', title: 'Earlier filing', summary: 'The SEC was considering an exemption.', eventAt: '2026-09-20T00:00:00.000Z' }],
    },
  }
  assert.equal(definition.validateState(state).valid, true)
  assert.match(definition.renderHermes(state), /Do not judge importance/)
  const decoded = definition.decodeJev({ novelty: {
    type: 'choice', choice: 'new_information', confidence: 0.95,
    probabilities: { already_known: 0.03, new_information: 0.95, contradicts_prior: 0.02 },
  } }, state)
  assert.deepEqual(decoded, { valid: true, value: { verdict: 'new_information', reason: 'Jev classified the signal as new_information.' } })
})

test('article Jev definitions accept the supported full captured-source bound', () => {
  const sourceText = 'A complete captured article. '.repeat(900)
  assert.ok(sourceText.length > 16_000)
  assert.ok(sourceText.length <= ARTICLE_DECISION_SOURCE_MAX_CHARS)
  const candidate = { id: 'bitcoin', name: 'Bitcoin', aliases: ['BTC'], summary: null, scope: {} }
  assert.equal(articleEntityPlacementDefinition().validateState({ article: { title: 'Bitcoin update', text: sourceText }, candidates: [candidate] }).valid, true)
  assert.equal(articleRelatedMembershipDefinition().validateState({ article: { title: 'Bitcoin update', text: sourceText }, primary: { id: 'bitcoin', name: 'Bitcoin' }, candidates: [] }).valid, true)
  assert.equal(articleNoveltyDefinition().validateState({ article: { title: 'Bitcoin update', text: sourceText, publishedAt: null, observedAt: '2026-10-01T00:00:00.000Z' }, histories: [], selectedTargets: [] }).valid, true)
  assert.equal(articleStoryRelationshipDefinition().validateState({ article: { title: 'Bitcoin update', sourceText, publishedAt: null, observedAt: '2026-10-01T00:00:00.000Z' }, entity: { id: 'bitcoin', name: 'Bitcoin' }, recentItems: [] }).valid, true)
})

test('definition validators create exact bounded projections and discard unknown caller data', () => {
  const noveltyDefinition = researchNoveltyDefinition()
  const noveltyState = {
    signal: {
      source: 'news', sourceRefId: 'article-1', title: 'SEC update',
      whatChanged: 'The SEC approved an exemption.', observedAt: '2026-09-23T00:00:00.000Z',
      fullArticleBody: 'must not cross the boundary',
    },
    context: {
      entities: [{ id: 'sec', slug: 'sec', name: 'SEC', summary: null, privateMetadata: 'drop' }],
      recentMemories: [{
        entityId: 'sec', memoryType: 'news', title: 'Earlier filing', summary: 'Earlier state.',
        eventAt: '2026-09-20T00:00:00.000Z', evidence: ['drop'],
      }],
    },
    arbitrary: 'drop',
  }
  const novelty = noveltyDefinition.validateState(noveltyState)
  assert.equal(novelty.valid, true)
  if (novelty.valid) {
    assert.deepEqual(Object.keys(novelty.value).sort(), ['context', 'signal'])
    assert.equal('fullArticleBody' in (novelty.value.signal as unknown as Record<string, unknown>), false)
    assert.equal('privateMetadata' in (novelty.value.context.entities[0] as unknown as Record<string, unknown>), false)
    assert.equal('evidence' in (novelty.value.context.recentMemories[0] as unknown as Record<string, unknown>), false)
  }
  assert.equal(noveltyDefinition.validateState({
    ...noveltyState,
    context: { ...noveltyState.context, entities: Array.from({ length: 21 }, () => noveltyState.context.entities[0]) },
  }).valid, false)
})
function followupValueState(): ResearchFollowupValueState {
  return {
    signal: {
      source: 'news', sourceRefId: 'article-2', title: 'Treasury update',
      whatChanged: 'Treasury released draft guidance for comment.', observedAt: '2026-10-01T00:00:00.000Z',
    },
    context: {
      entities: [{ id: 'treasury', slug: 'treasury', name: 'Treasury', summary: null }],
      recentMemories: [{
        entityId: 'treasury', memoryType: 'news', title: 'Draft circulating',
        summary: 'A draft of the guidance was circulating.', eventAt: '2026-09-30T00:00:00.000Z',
      }],
    },
  }
}

test('research.followup_value embeds the bounded-value directive and defaults disabled', () => {
  const definition = researchFollowupValueDefinition()
  assert.equal(definition.workload, 'research.followup_value')
  assert.equal(definition.decisionVersion, 'research.followup_value.v1')
  assert.equal(definition.defaultLifecycleMode, 'disabled')
  assert.equal(definition.maximumLifecycleMode, 'canary')
  const directive = "Assess whether one bounded follow-up could add information material to this research assignment beyond the supplied source and relevant saved knowledge. Unanswered details alone are not sufficient. Do not assert that any supplied claim is true. If the supplied context is insufficient to judge, return uncertain."
  const state = followupValueState()
  assert.equal(definition.validateState(state).valid, true)
  assert.ok(definition.renderHermes(state).includes(directive))
  const question = definition.questions(state).followup_value
  assert.ok(question && question.type === 'choice')
  const rules = (question.instructions as { rules: string[] }).rules
  assert.ok(rules.includes(directive))
  assert.ok('worthwhile' in question.criteria && 'not_worthwhile' in question.criteria && 'uncertain' in question.criteria)
})

test('research.followup_value decodes Jev and Hermes decisions and rejects unknown directions', () => {
  const definition = researchFollowupValueDefinition()
  const state = followupValueState()
  const answers = { followup_value: {
    type: 'choice' as const, choice: 'worthwhile', confidence: 0.9,
    probabilities: { worthwhile: 0.9, not_worthwhile: 0.06, uncertain: 0.04 },
  } }
  assert.deepEqual(definition.decodeJev(answers, state), {
    valid: true, value: { direction: 'worthwhile', reason: 'Jev classified the bounded follow-up as worthwhile.' },
  })
  assert.equal(definition.decodeJev({ followup_value: {
    type: 'choice', choice: 'maximize_engagement', confidence: 1, probabilities: { maximize_engagement: 1 },
  } }, state).valid, false)
  assert.deepEqual(definition.acceptJev(answers, { direction: 'worthwhile', reason: 'x' }, state), {
    accepted: true, reason: 'followup_value Choice passed registry thresholds',
  })
  assert.equal(definition.acceptJev({ followup_value: {
    type: 'choice', choice: 'uncertain', confidence: 0.4, probabilities: { uncertain: 0.5, worthwhile: 0.4, not_worthwhile: 0.1 },
  } }, { direction: 'uncertain', reason: 'x' }, state).accepted, false)
  const hermes = definition.validateHermes({ direction: 'not_worthwhile', reason: 'The saved knowledge already covers the proposal.' }, state)
  assert.deepEqual(hermes, {
    valid: true, value: { direction: 'not_worthwhile', reason: 'The saved knowledge already covers the proposal.' },
  })
  assert.equal(definition.validateHermes({ direction: 'already_known', reason: 'x' }, state).valid, false)
})

test('research.followup_value reuses the bounded novelty state projection and ships disabled in the approved list', () => {
  const definition = researchFollowupValueDefinition()
  const raw = followupValueState() as unknown as Record<string, unknown>
  raw.arbitrary = 'drop'
  ;(raw.signal as Record<string, unknown>).fullArticleBody = 'must not cross the boundary'
  const projected = definition.validateState(raw)
  assert.equal(projected.valid, true)
  if (projected.valid) {
    assert.deepEqual(Object.keys(projected.value).sort(), ['context', 'signal'])
    assert.equal('fullArticleBody' in (projected.value.signal as unknown as Record<string, unknown>), false)
  }
  assert.equal(definition.validateState({
    ...followupValueState(),
    context: { ...followupValueState().context, entities: Array.from({ length: 21 }, () => followupValueState().context.entities[0]) },
  }).valid, false)
  const approved = approvedClassificationDefinitions().find((item) => item.workload === 'research.followup_value')
  assert.ok(approved)
  assert.equal(approved!.defaultLifecycleMode, 'disabled')
})
