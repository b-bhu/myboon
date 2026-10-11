import assert from 'node:assert/strict'
import test from 'node:test'
import {
  approvedClassificationDefinitions,
  articleEntityPlacementDefinition,
  articleRelatedMembershipDefinition,
  articleNoveltyDefinition,
  articleStoryRelationshipDefinition,
  articleEntityProposalValidationDefinition,
  articleCatalogueBatchDefinition,
  articleRelationshipBatchDefinition,
  researchFollowupValueDefinition,
  researchNoveltyDefinition,
  type ArticleCatalogueBatchState,
  type ArticleEntityPlacementState,
  type ArticleEntityProposalValidationState,
  type ArticleRelatedMembershipState,
  type ArticleNoveltyState,
  type ArticleRelationshipBatchState,
  type ArticleStoryRelationshipState,
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

const FALLBACK_PLACEMENT_STATE: ArticleEntityPlacementState = {
  article: { title: 'Development', text: 'A captured article about Bitcoin custody.' },
  candidates: [
    { id: 'bitcoin', name: 'Bitcoin', aliases: ['BTC'], summary: null, scope: {} },
    { id: 'blackrock', name: 'BlackRock', aliases: [], summary: null, scope: {} },
  ],
}
const FALLBACK_MEMBERSHIP_STATE: ArticleRelatedMembershipState = {
  article: { title: 'Development', text: 'A captured article about Bitcoin custody.' },
  primary: { id: 'bitcoin', name: 'Bitcoin' },
  candidates: [{ id: 'blackrock', name: 'BlackRock', aliases: [], summary: null, scope: {} }],
}
const FALLBACK_PROPOSAL_STATE: ArticleEntityProposalValidationState = {
  article: { title: 'Development', text: 'A captured article about the article subject.' },
  proposal: { name: 'New Entity', type: 'company', aliases: [], summary: 'A summary supported by the article.', scope: {} },
}
const FALLBACK_STORY_STATE: ArticleStoryRelationshipState = {
  article: { title: 'Development', sourceText: 'A captured article.', publishedAt: null, observedAt: '2026-10-01T00:00:00.000Z' },
  entity: { id: 'bitcoin', name: 'Bitcoin' },
  recentItems: [{ id: 'bitcoin-1', source: 'managed', title: 'Earlier filing', summary: 'Earlier state.', eventAt: '2026-09-20T00:00:00.000Z' }],
}
const FALLBACK_NOVELTY_STATE: ArticleNoveltyState = {
  article: { title: 'Development', text: 'A captured article.', publishedAt: null, observedAt: '2026-10-01T00:00:00.000Z' },
  histories: [],
  selectedTargets: [],
}
const FALLBACK_NOVELTY_DUPLICATE_STATE: ArticleNoveltyState = {
  article: { title: 'Development', text: 'A captured article.', publishedAt: null, observedAt: '2026-10-01T00:00:00.000Z' },
  histories: [],
  selectedTargets: [{ entityId: 'bitcoin', role: 'primary', id: 'bitcoin-1', source: 'managed', title: 'Earlier filing', summary: 'Earlier state.', eventAt: '2026-09-20T00:00:00.000Z' }],
}
const FALLBACK_NOVELTY_RECONCILIATION_STATE: ArticleNoveltyState = {
  article: { title: 'Development', text: 'A captured article.', publishedAt: null, observedAt: '2026-10-01T00:00:00.000Z' },
  histories: [{ entityId: 'bitcoin', items: [{ id: 'bitcoin-1', source: 'managed', title: 'Earlier filing', summary: 'Earlier state.', eventAt: '2026-09-20T00:00:00.000Z' }] }],
  selectedTargets: [{ entityId: 'bitcoin', role: 'primary', id: 'bitcoin-1', source: 'managed', title: 'Earlier filing', summary: 'Earlier state.', eventAt: '2026-09-20T00:00:00.000Z' }],
  reconciliation: { priorVerdict: 'contradicts_prior' },
}

function fallbackAnswer(questionKey: string, choice: string) {
  return { [questionKey]: { type: 'choice' as const, choice, confidence: 0.9, probabilities: { [choice]: 1 } } }
}

test('article definitions keep Jev-only defaults when the Hermes fallback flag is off', () => {
  const definitions = approvedClassificationDefinitions()
  assert.equal(definitions.length, 7)
  const expected = [
    ['research.article_entity_placement', 'research.article_entity_placement.v2'],
    ['research.article_entity_proposal_validation', 'research.article_entity_proposal_validation.v1'],
    ['research.article_related_membership', 'research.article_related_membership.v1'],
    ['research.article_story_relationship', 'research.article_story_relationship.v2'],
    ['research.article_novelty', 'research.article_novelty.v2'],
  ] as const
  for (const [workload, version] of expected) {
    const definition = definitions.find((item) => item.workload === workload)
    assert.ok(definition, `${workload} must stay registered`)
    assert.equal(definition!.decisionVersion, version)
    assert.equal(definition!.requiresJev, true)
  }
})

test('article Hermes fallback flag registers new versions beside the retired ones', () => {
  const definitions = approvedClassificationDefinitions(undefined, { articleHermesFallback: true })
  assert.equal(definitions.length, 12)
  const byVersion = new Map(definitions.map((definition) => [definition.decisionVersion, definition]))
  const expectedVersions = [
    ['research.article_entity_placement.v2', 'research.article_entity_placement.v3'],
    ['research.article_entity_proposal_validation.v1', 'research.article_entity_proposal_validation.v2'],
    ['research.article_related_membership.v1', 'research.article_related_membership.v2'],
    ['research.article_story_relationship.v2', 'research.article_story_relationship.v3'],
    ['research.article_novelty.v2', 'research.article_novelty.v3'],
  ] as const
  for (const [legacyVersion, fallbackVersion] of expectedVersions) {
    const legacy = byVersion.get(legacyVersion)
    const modern = byVersion.get(fallbackVersion)
    assert.ok(legacy, `${legacyVersion} must stay registered`)
    assert.ok(modern, `${fallbackVersion} must be registered`)
    assert.equal(legacy!.requiresJev, true)
    assert.equal(modern!.requiresJev, false)
    assert.equal(modern!.workload, legacy!.workload)
  }
})

test('article Hermes fallback prompts reuse the Jev rubric text and an exact JSON schema', () => {
  const placement = articleEntityPlacementDefinition(undefined, { articleHermesFallback: true })
  const prompt = placement.renderHermes(FALLBACK_PLACEMENT_STATE)
  assert.ok(prompt.length > 0)
  const question = placement.questions(FALLBACK_PLACEMENT_STATE).placement
  assert.ok(question && question.type === 'choice')
  const questionRules = (question.instructions as { rules: string[] }).rules
  for (const rule of questionRules) assert.ok(prompt.includes(rule), `rule missing from Hermes prompt: ${rule}`)
  const placementCriteria = (question.criteria as Record<string, string>)
  for (const description of Object.values(placementCriteria)) assert.ok(prompt.includes(description))
  assert.ok(prompt.includes('Return strict JSON only'))
  assert.ok(prompt.includes('bitcoin'))

  const membership = articleRelatedMembershipDefinition(undefined, { articleHermesFallback: true })
  const membershipPrompt = membership.renderHermes(FALLBACK_MEMBERSHIP_STATE)
  const membershipQuestion = membership.questions(FALLBACK_MEMBERSHIP_STATE).related_blackrock!
  assert.ok(membershipQuestion.type === 'choice')
  const membershipRules = (membershipQuestion.instructions as { rules: string[] }).rules
  for (const rule of membershipRules) assert.ok(membershipPrompt.includes(rule))
  assert.ok(membershipPrompt.includes('dispositions') && membershipPrompt.includes('blackrock'))

  const proposal = articleEntityProposalValidationDefinition(undefined, { articleHermesFallback: true })
  const proposalPrompt = proposal.renderHermes(FALLBACK_PROPOSAL_STATE)
  const proposalQuestion = proposal.questions(FALLBACK_PROPOSAL_STATE).proposal
  assert.ok(proposalQuestion.type === 'choice')
  const proposalRules = (proposalQuestion.instructions as { rules: string[] }).rules
  for (const rule of proposalRules) assert.ok(proposalPrompt.includes(rule))
  assert.ok(proposalPrompt.includes('disposition'))

  const story = articleStoryRelationshipDefinition(undefined, { articleHermesFallback: true })
  const storyPrompt = story.renderHermes(FALLBACK_STORY_STATE)
  const storyQuestion = story.questions(FALLBACK_STORY_STATE).relationship_target
  assert.ok(storyQuestion.type === 'choice')
  const storyRules = (storyQuestion.instructions as { rules: string[] }).rules
  for (const rule of storyRules) assert.ok(storyPrompt.includes(rule))
  assert.ok(storyPrompt.includes('duplicate:managed:bitcoin-1'))
  assert.ok(storyPrompt.includes('priorItemId'))

  const novelty = articleNoveltyDefinition(undefined, { articleHermesFallback: true })
  const noveltyPrompt = novelty.renderHermes(FALLBACK_NOVELTY_STATE)
  const noveltyQuestion = novelty.questions(FALLBACK_NOVELTY_STATE).novelty
  assert.ok(noveltyQuestion.type === 'choice')
  const noveltyRules = (noveltyQuestion.instructions as { rules: string[] }).rules
  for (const rule of noveltyRules) assert.ok(noveltyPrompt.includes(rule))
  assert.ok(noveltyPrompt.includes('already_known') && noveltyPrompt.includes('verdict'))
})

test('article Hermes fallback validateHermes returns the decodeJev decision shape and rejects malformed output', () => {
  const placement = articleEntityPlacementDefinition(undefined, { articleHermesFallback: true })
  assert.deepEqual(
    placement.validateHermes({ entityId: 'bitcoin' }, FALLBACK_PLACEMENT_STATE),
    { valid: true, value: { entityId: 'bitcoin', disposition: 'selected' } },
  )
  assert.deepEqual(
    placement.validateHermes({ entityId: 'no_match' }, FALLBACK_PLACEMENT_STATE),
    { valid: true, value: { entityId: null, disposition: 'no_match' } },
  )
  assert.equal(placement.validateHermes({ entityId: 'unregistered-id' }, FALLBACK_PLACEMENT_STATE).valid, false)
  assert.equal(placement.validateHermes({ entityId: 'bitcoin', extra: 1 }, FALLBACK_PLACEMENT_STATE).valid, false)
  assert.equal(placement.validateHermes({ entityId: 42 }, FALLBACK_PLACEMENT_STATE).valid, false)

  const membership = articleRelatedMembershipDefinition(undefined, { articleHermesFallback: true })
  assert.deepEqual(
    membership.validateHermes({ dispositions: { blackrock: 'related' } }, FALLBACK_MEMBERSHIP_STATE),
    { valid: true, value: { dispositions: { blackrock: 'related' } } },
  )
  assert.equal(membership.validateHermes({ dispositions: { unknown: 'related' } }, FALLBACK_MEMBERSHIP_STATE).valid, false)
  assert.equal(membership.validateHermes({ dispositions: { blackrock: 'partner' } }, FALLBACK_MEMBERSHIP_STATE).valid, false)
  assert.equal(membership.validateHermes({ dispositions: { blackrock: 'related', extra: 'uncertain' } }, FALLBACK_MEMBERSHIP_STATE).valid, false)

  const story = articleStoryRelationshipDefinition(undefined, { articleHermesFallback: true })
  assert.deepEqual(
    story.validateHermes({ relationship: 'direct_continuation', priorItemId: 'bitcoin-1' }, FALLBACK_STORY_STATE),
    { valid: true, value: { relationship: 'direct_continuation', priorItemId: 'bitcoin-1', priorItemSource: 'managed' } },
  )
  assert.deepEqual(
    story.validateHermes({ relationship: 'unrelated', priorItemId: null }, FALLBACK_STORY_STATE),
    { valid: true, value: { relationship: 'unrelated', priorItemId: null, priorItemSource: null } },
  )
  assert.equal(story.validateHermes({ relationship: 'duplicate', priorItemId: 'unregistered-id' }, FALLBACK_STORY_STATE).valid, false)
  assert.equal(story.validateHermes({ relationship: 'unrelated', priorItemId: 'bitcoin-1' }, FALLBACK_STORY_STATE).valid, false)
  assert.equal(story.validateHermes({ relationship: 'duplicate', priorItemId: 'bitcoin-1', source: 'managed' }, FALLBACK_STORY_STATE).valid, false)
  assert.equal(story.validateHermes({ relationship: 'teleported', priorItemId: null }, FALLBACK_STORY_STATE).valid, false)

  const novelty = articleNoveltyDefinition(undefined, { articleHermesFallback: true })
  assert.deepEqual(
    novelty.validateHermes({ verdict: 'new_information', primaryRelationship: 'direct_continuation' }, FALLBACK_NOVELTY_STATE),
    { valid: true, value: { verdict: 'new_information', primaryRelationship: 'direct_continuation' } },
  )
  // Composite verdict keys are only admitted in reconciliation mode, mirroring
  // the Jev question's criteria for that state.
  assert.deepEqual(
    novelty.validateHermes({ verdict: 'new_information:same_topic_only' }, FALLBACK_NOVELTY_RECONCILIATION_STATE),
    { valid: true, value: { verdict: 'new_information', primaryRelationship: 'same_topic_only' } },
  )
  assert.deepEqual(
    novelty.validateHermes({ verdict: 'new_information:related_story_branch' }, FALLBACK_NOVELTY_RECONCILIATION_STATE),
    { valid: true, value: { verdict: 'new_information', primaryRelationship: 'related_story_branch' } },
  )
  // The composite form is rejected outside reconciliation mode.
  assert.equal(novelty.validateHermes({ verdict: 'new_information:same_topic_only' }, FALLBACK_NOVELTY_STATE).valid, false)
  assert.equal(novelty.validateHermes({ verdict: 'already_known', primaryRelationship: 'duplicate' }, FALLBACK_NOVELTY_DUPLICATE_STATE).valid, false)
  assert.equal(novelty.validateHermes({ verdict: 'contradicts_prior', primaryRelationship: 'uncertain' }, FALLBACK_NOVELTY_STATE).valid, false)
  assert.equal(novelty.validateHermes({ verdict: 'invented' }, FALLBACK_NOVELTY_STATE).valid, false)
  assert.equal(novelty.validateHermes({ verdict: 'new_information', extra: true }, FALLBACK_NOVELTY_STATE).valid, false)

  const proposal = articleEntityProposalValidationDefinition(undefined, { articleHermesFallback: true })
  assert.deepEqual(
    proposal.validateHermes({ disposition: 'reject' }, FALLBACK_PROPOSAL_STATE),
    { valid: true, value: { disposition: 'reject' } },
  )
  assert.equal(proposal.validateHermes({ disposition: 'accept', extra: 1 }, FALLBACK_PROPOSAL_STATE).valid, false)
  assert.equal(proposal.validateHermes({ disposition: 'maybe' }, FALLBACK_PROPOSAL_STATE).valid, false)
})

test('article Hermes fallback safety holds: proposal accept and novelty duplicate become uncertain', () => {
  const proposal = articleEntityProposalValidationDefinition(undefined, { articleHermesFallback: true })
  assert.deepEqual(
    proposal.validateHermes({ disposition: 'accept' }, FALLBACK_PROPOSAL_STATE),
    { valid: true, value: { disposition: 'uncertain' } },
  )

  const novelty = articleNoveltyDefinition(undefined, { articleHermesFallback: true })
  // already_known is admitted only when duplicate targets are supplied, and a
  // Hermes duplicate outcome must hold as uncertain instead of suppressing.
  assert.deepEqual(
    novelty.validateHermes({ verdict: 'already_known' }, FALLBACK_NOVELTY_DUPLICATE_STATE),
    { valid: true, value: { verdict: 'uncertain' } },
  )
  assert.deepEqual(
    novelty.validateHermes({ verdict: 'already_known' }, FALLBACK_NOVELTY_RECONCILIATION_STATE),
    { valid: true, value: { verdict: 'uncertain' } },
  )
})

test('article Hermes fallback safety hold: story duplicate becomes uncertain', () => {
  const story = articleStoryRelationshipDefinition(undefined, { articleHermesFallback: true })
  assert.deepEqual(
    story.validateHermes({ relationship: 'duplicate', priorItemId: 'bitcoin-1' }, FALLBACK_STORY_STATE),
    { valid: true, value: { relationship: 'uncertain', priorItemId: null, priorItemSource: null } },
  )
  // A duplicate naming a target outside the supplied history stays invalid.
  assert.equal(story.validateHermes({ relationship: 'duplicate', priorItemId: 'unregistered-id' }, FALLBACK_STORY_STATE).valid, false)
})

test('fallback article versions decode Jev answers identically to the legacy versions', () => {
  const legacy = articleEntityPlacementDefinition()
  const modern = articleEntityPlacementDefinition(undefined, { articleHermesFallback: true })
  assert.deepEqual(
    modern.decodeJev(fallbackAnswer('placement', 'bitcoin'), FALLBACK_PLACEMENT_STATE),
    legacy.decodeJev(fallbackAnswer('placement', 'bitcoin'), FALLBACK_PLACEMENT_STATE),
  )
  assert.deepEqual(
    modern.decodeJev(fallbackAnswer('placement', 'no_match'), FALLBACK_PLACEMENT_STATE),
    legacy.decodeJev(fallbackAnswer('placement', 'no_match'), FALLBACK_PLACEMENT_STATE),
  )

  const legacyNovelty = articleNoveltyDefinition()
  const modernNovelty = articleNoveltyDefinition(undefined, { articleHermesFallback: true })
  assert.deepEqual(
    modernNovelty.decodeJev(fallbackAnswer('novelty', 'new_information:same_topic_only'), FALLBACK_NOVELTY_STATE),
    legacyNovelty.decodeJev(fallbackAnswer('novelty', 'new_information:same_topic_only'), FALLBACK_NOVELTY_STATE),
  )
})

// #308 patch 5A: staged-batching decision versions (articleBatching).
const BATCH_CATALOGUE_STATE: ArticleCatalogueBatchState = {
  article: { title: 'Development', text: 'BlackRock added $1.5 billion in Bitcoin holdings.' },
  candidates: [
    { id: 'bitcoin', name: 'Bitcoin', aliases: ['BTC'], summary: null, scope: {} },
    { id: 'blackrock', name: 'BlackRock', aliases: [], summary: null, scope: {} },
  ],
}
const BATCH_RELATIONSHIP_STATE: ArticleRelationshipBatchState = {
  article: { title: 'Development', sourceText: 'A captured article.', publishedAt: null, observedAt: '2026-10-01T00:00:00.000Z' },
  entities: [
    { id: 'bitcoin', name: 'Bitcoin', recentItems: [{ id: 'bitcoin-1', source: 'managed', title: 'Earlier filing', summary: 'Earlier state.', eventAt: '2026-09-20T00:00:00.000Z' }] },
    { id: 'blackrock', name: 'BlackRock', recentItems: [{ id: 'blackrock-2', source: 'legacy', title: 'Earlier filing', summary: 'Earlier state.', eventAt: '2026-09-21T00:00:00.000Z' }] },
  ],
}

test('batching flag registers batched catalogue/relationship versions only behind the flag', () => {
  assert.equal(approvedClassificationDefinitions().some((item) => item.workload === 'research.article_catalogue_batch'), false)
  assert.equal(approvedClassificationDefinitions().some((item) => item.workload === 'research.article_relationship_batch'), false)

  const batching = approvedClassificationDefinitions(undefined, { articleBatching: true })
  assert.equal(batching.length, 9)
  const catalogue = batching.find((item) => item.workload === 'research.article_catalogue_batch')!
  const relationship = batching.find((item) => item.workload === 'research.article_relationship_batch')!
  assert.equal(catalogue.decisionVersion, 'research.article_catalogue_batch.v1')
  assert.equal(relationship.decisionVersion, 'research.article_relationship_batch.v1')
  assert.equal(catalogue.requiresJev, true)
  assert.equal(relationship.requiresJev, true)

  const both = approvedClassificationDefinitions(undefined, { articleBatching: true, articleHermesFallback: true })
  // 7 base + 5 Hermes-fallback + 2 batched base + 2 batched-Hermes-fallback.
  assert.equal(both.length, 16)
  const catalogueFallback = both.find((item) => item.decisionVersion === 'research.article_catalogue_batch.v2')!
  const relationshipFallback = both.find((item) => item.decisionVersion === 'research.article_relationship_batch.v2')!
  assert.equal(catalogueFallback.workload, 'research.article_catalogue_batch')
  assert.equal(relationshipFallback.workload, 'research.article_relationship_batch')
  assert.equal(catalogueFallback.requiresJev, false)
  assert.equal(relationshipFallback.requiresJev, false)
  // Base versions stay registered beside the fallback ones.
  assert.ok(both.find((item) => item.decisionVersion === 'research.article_catalogue_batch.v1'))
  assert.ok(both.find((item) => item.decisionVersion === 'research.article_relationship_batch.v1'))
})

test('batched catalogue definition carries one placement question plus one membership question per candidate', () => {
  const definition = articleCatalogueBatchDefinition()
  const questions = definition.questions(BATCH_CATALOGUE_STATE)
  assert.deepEqual(Object.keys(questions), ['placement', 'related_bitcoin', 'related_blackrock'])
  const membership = questions.related_blackrock!
  assert.ok(membership.type === 'choice')
  assert.ok('related' in membership.criteria && 'not_related' in membership.criteria && 'uncertain' in membership.criteria)
  // Membership rules judge candidates independently of the primary placement.
  assert.deepEqual((membership.instructions as { rules: string[] }).rules, (articleRelatedMembershipDefinition().questions({
    article: BATCH_CATALOGUE_STATE.article, primary: { id: 'bitcoin', name: 'Bitcoin' }, candidates: BATCH_CATALOGUE_STATE.candidates,
  }).related_blackrock! as { instructions: { rules: string[] } }).instructions.rules)

  const valid = definition.decodeJev({
    placement: fallbackAnswer('placement', 'bitcoin').placement,
    related_bitcoin: fallbackAnswer('related_bitcoin', 'not_related').related_bitcoin,
    related_blackrock: fallbackAnswer('related_blackrock', 'related').related_blackrock,
  }, BATCH_CATALOGUE_STATE)
  assert.deepEqual(valid, { valid: true, value: { entityId: 'bitcoin', disposition: 'selected', dispositions: { bitcoin: 'not_related', blackrock: 'related' } } })
  const noMatch = definition.decodeJev({
    placement: fallbackAnswer('placement', 'no_match').placement,
    related_bitcoin: fallbackAnswer('related_bitcoin', 'uncertain').related_bitcoin,
    related_blackrock: fallbackAnswer('related_blackrock', 'not_related').related_blackrock,
  }, BATCH_CATALOGUE_STATE)
  assert.deepEqual(noMatch, { valid: true, value: { entityId: null, disposition: 'no_match', dispositions: { bitcoin: 'uncertain', blackrock: 'not_related' } } })
  // Every registered candidate needs a valid membership answer.
  assert.equal(definition.decodeJev({
    placement: fallbackAnswer('placement', 'bitcoin').placement,
    related_bitcoin: fallbackAnswer('related_bitcoin', 'partner').related_bitcoin,
    related_blackrock: fallbackAnswer('related_blackrock', 'related').related_blackrock,
  }, BATCH_CATALOGUE_STATE).valid, false)
  assert.equal(definition.decodeJev({
    placement: fallbackAnswer('placement', 'blackrock').placement,
    related_blackrock: fallbackAnswer('related_blackrock', 'related').related_blackrock,
  }, BATCH_CATALOGUE_STATE).valid, false)
  // Placement catalogue membership is acceptJev's contract (mirrors the
  // standalone placement definition); decode keeps the raw choice value.
  const unregistered = definition.decodeJev({
    placement: fallbackAnswer('placement', 'unregistered').placement,
    related_bitcoin: fallbackAnswer('related_bitcoin', 'related').related_bitcoin,
    related_blackrock: fallbackAnswer('related_blackrock', 'related').related_blackrock,
  }, BATCH_CATALOGUE_STATE)
  assert.equal(unregistered.valid, true)
  if (unregistered.valid) assert.equal(unregistered.value.entityId, 'unregistered')
  assert.equal(definition.acceptJev({
    placement: fallbackAnswer('placement', 'bitcoin').placement,
    related_bitcoin: fallbackAnswer('related_bitcoin', 'not_related').related_bitcoin,
    related_blackrock: fallbackAnswer('related_blackrock', 'related').related_blackrock,
  }, { entityId: 'bitcoin', disposition: 'selected', dispositions: {} }, BATCH_CATALOGUE_STATE).accepted, true)
  assert.equal(definition.acceptJev({
    placement: fallbackAnswer('placement', 'bitcoin').placement,
    related_bitcoin: fallbackAnswer('related_bitcoin', 'not_related').related_bitcoin,
    related_blackrock: fallbackAnswer('related_blackrock', 'related').related_blackrock,
  }, { entityId: 'unregistered', disposition: 'selected', dispositions: {} }, BATCH_CATALOGUE_STATE).accepted, false)
})

test('batched catalogue Hermes fallback holds the primary placement and validates memberships exactly', () => {
  const definition = articleCatalogueBatchDefinition(undefined, { articleHermesFallback: true })
  // Placement may be selected only when Hermes names a supplied candidate id,
  // which backs up the catalogue stage; no_match and uncertain keep holding.
  assert.deepEqual(
    definition.validateHermes({ entityId: 'bitcoin', dispositions: { bitcoin: 'not_related', blackrock: 'related' } }, BATCH_CATALOGUE_STATE),
    { valid: true, value: { entityId: 'bitcoin', disposition: 'selected', dispositions: { bitcoin: 'not_related', blackrock: 'related' } } },
  )
  assert.deepEqual(
    definition.validateHermes({ entityId: 'no_match', dispositions: { bitcoin: 'uncertain', blackrock: 'uncertain' } }, BATCH_CATALOGUE_STATE),
    { valid: true, value: { entityId: null, disposition: 'no_match', dispositions: { bitcoin: 'uncertain', blackrock: 'uncertain' } } },
  )
  assert.deepEqual(
    definition.validateHermes({ entityId: 'uncertain', dispositions: { bitcoin: 'not_related', blackrock: 'uncertain' } }, BATCH_CATALOGUE_STATE),
    { valid: true, value: { entityId: null, disposition: 'uncertain', dispositions: { bitcoin: 'not_related', blackrock: 'uncertain' } } },
  )
  assert.equal(definition.validateHermes({ entityId: 'unregistered', dispositions: {} }, BATCH_CATALOGUE_STATE).valid, false)
  assert.equal(definition.validateHermes({ entityId: 'bitcoin', dispositions: { bitcoin: 'not_related' } }, BATCH_CATALOGUE_STATE).valid, false)
  assert.equal(definition.validateHermes({ entityId: 'bitcoin', dispositions: { bitcoin: 'not_related', blackrock: 'partner' } }, BATCH_CATALOGUE_STATE).valid, false)
  assert.equal(definition.validateHermes({ entityId: 'bitcoin', dispositions: { bitcoin: 'not_related', blackrock: 'related', extra: 'uncertain' } }, BATCH_CATALOGUE_STATE).valid, false)
  assert.equal(definition.validateHermes({ entityId: 'bitcoin' }, BATCH_CATALOGUE_STATE).valid, false)

  // The render prompt names every membership key and the joint placement outcomes.
  const prompt = definition.renderHermes(BATCH_CATALOGUE_STATE)
  assert.ok(prompt.includes('related_bitcoin') === false) // schema carries ids, not question keys
  assert.ok(prompt.includes('"bitcoin": "related|not_related|uncertain"'))
  assert.ok(prompt.includes('no_match'))
  assert.ok(prompt.includes('Return strict JSON only'))
})

test('batched relationship definition validates per-entity joint targets against their own history', () => {
  const definition = articleRelationshipBatchDefinition()
  const questions = definition.questions(BATCH_RELATIONSHIP_STATE)
  assert.deepEqual(Object.keys(questions), ['relationship_target_bitcoin', 'relationship_target_blackrock'])
  const bitcoinQuestion = questions.relationship_target_bitcoin!
  assert.ok(bitcoinQuestion.type === 'choice')
  // The joint criteria include this entity's own history targets and its own id.
  assert.ok('duplicate:managed:bitcoin-1' in bitcoinQuestion.criteria)
  assert.ok('related_story_branch:managed:bitcoin-1' in bitcoinQuestion.criteria)
  assert.ok(!('duplicate:legacy:blackrock-2' in bitcoinQuestion.criteria))
  assert.ok(JSON.stringify((bitcoinQuestion.instructions as unknown as { question: string }).question).includes('blackrock') === false)

  const valid = definition.decodeJev({
    relationship_target_bitcoin: fallbackAnswer('relationship_target_bitcoin', 'direct_continuation:managed:bitcoin-1').relationship_target_bitcoin,
    relationship_target_blackrock: fallbackAnswer('relationship_target_blackrock', 'same_topic_only').relationship_target_blackrock,
  }, BATCH_RELATIONSHIP_STATE)
  assert.deepEqual(valid, { valid: true, value: { targets: [
    { entityId: 'bitcoin', relationship: 'direct_continuation', priorItemId: 'bitcoin-1', priorItemSource: 'managed' },
    { entityId: 'blackrock', relationship: 'same_topic_only', priorItemId: null, priorItemSource: null },
  ] } })
  // A target from another entity's history is invalid.
  assert.equal(definition.decodeJev({
    relationship_target_bitcoin: fallbackAnswer('relationship_target_bitcoin', 'direct_continuation:legacy:blackrock-2').relationship_target_bitcoin,
    relationship_target_blackrock: fallbackAnswer('relationship_target_blackrock', 'same_topic_only').relationship_target_blackrock,
  }, BATCH_RELATIONSHIP_STATE).valid, false)
  // A joint outcome without a target, or a missing entity answer, is invalid.
  assert.equal(definition.decodeJev({
    relationship_target_bitcoin: fallbackAnswer('relationship_target_bitcoin', 'direct_continuation').relationship_target_bitcoin,
    relationship_target_blackrock: fallbackAnswer('relationship_target_blackrock', 'same_topic_only').relationship_target_blackrock,
  }, BATCH_RELATIONSHIP_STATE).valid, false)
  assert.equal(definition.decodeJev({
    relationship_target_blackrock: fallbackAnswer('relationship_target_blackrock', 'same_topic_only').relationship_target_blackrock,
  }, BATCH_RELATIONSHIP_STATE).valid, false)
  assert.equal(definition.acceptJev({
    relationship_target_bitcoin: fallbackAnswer('relationship_target_bitcoin', 'duplicate:managed:bitcoin-1').relationship_target_bitcoin,
    relationship_target_blackrock: fallbackAnswer('relationship_target_blackrock', 'uncertain').relationship_target_blackrock,
  }, { targets: [] }, BATCH_RELATIONSHIP_STATE).accepted, true)
})

test('batched relationship state projection bounds entities, history and ids exactly', () => {
  const definition = articleRelationshipBatchDefinition()
  const item = { id: 'item', source: 'legacy' as const, title: 'Earlier', summary: 'State.', eventAt: '2026-09-20T00:00:00.000Z' }
  assert.equal(definition.validateState({ ...BATCH_RELATIONSHIP_STATE, entities: undefined }).valid, false)
  assert.equal(definition.validateState({
    ...BATCH_RELATIONSHIP_STATE,
    entities: Array.from({ length: 33 }, (_, i) => ({ id: `entity-${i}`, name: `Entity ${i}`, recentItems: [] })),
  }).valid, false)
  assert.equal(definition.validateState({
    ...BATCH_RELATIONSHIP_STATE,
    entities: [{ id: 'bitcoin', name: 'Bitcoin', recentItems: Array.from({ length: 6 }, () => item) }],
  }).valid, false)
  assert.equal(definition.validateState({
    ...BATCH_RELATIONSHIP_STATE,
    entities: [
      { id: 'bitcoin', name: 'Bitcoin', recentItems: [] },
      { id: 'bitcoin', name: 'Duplicate', recentItems: [] },
    ],
  }).valid, false)
  const projected = definition.validateState({ ...BATCH_RELATIONSHIP_STATE, arbitrary: 'drop', entities: [{ id: 'bitcoin', name: 'Bitcoin', recentItems: [{ ...item, privateData: 'drop' }] }] })
  assert.equal(projected.valid, true)
  if (projected.valid) {
    assert.deepEqual(Object.keys(projected.value), ['article', 'entities'])
    assert.equal('privateData' in projected.value.entities[0].recentItems[0], false)
  }

  // Hermes fallback: duplicates demote to the uncertain hold; coverage is exact.
  const fallback = articleRelationshipBatchDefinition(undefined, { articleHermesFallback: true })
  assert.deepEqual(
    fallback.validateHermes({ targets: [
      { entityId: 'bitcoin', relationship: 'duplicate', priorItemId: 'bitcoin-1' },
      { entityId: 'blackrock', relationship: 'related_story_branch', priorItemId: 'blackrock-2' },
    ] }, BATCH_RELATIONSHIP_STATE),
    { valid: true, value: { targets: [
      { entityId: 'bitcoin', relationship: 'uncertain', priorItemId: null, priorItemSource: null },
      { entityId: 'blackrock', relationship: 'related_story_branch', priorItemId: 'blackrock-2', priorItemSource: 'legacy' },
    ] } },
  )
  assert.deepEqual(
    fallback.validateHermes({ targets: [
      { entityId: 'bitcoin', relationship: 'unrelated', priorItemId: null },
      { entityId: 'blackrock', relationship: 'uncertain', priorItemId: null },
    ] }, BATCH_RELATIONSHIP_STATE),
    { valid: true, value: { targets: [
      { entityId: 'bitcoin', relationship: 'unrelated', priorItemId: null, priorItemSource: null },
      { entityId: 'blackrock', relationship: 'uncertain', priorItemId: null, priorItemSource: null },
    ] } },
  )
  assert.equal(fallback.validateHermes({ targets: [{ entityId: 'bitcoin', relationship: 'same_topic_only', priorItemId: null }] }, BATCH_RELATIONSHIP_STATE).valid, false)
  assert.equal(fallback.validateHermes({ targets: [
    { entityId: 'bitcoin', relationship: 'duplicate', priorItemId: 'blackrock-2' },
    { entityId: 'blackrock', relationship: 'same_topic_only', priorItemId: null },
  ] }, BATCH_RELATIONSHIP_STATE).valid, false)
  assert.equal(fallback.validateHermes({ targets: [
    { entityId: 'bitcoin', relationship: 'same_topic_only', priorItemId: 'bitcoin-1' },
    { entityId: 'blackrock', relationship: 'same_topic_only', priorItemId: null },
  ] }, BATCH_RELATIONSHIP_STATE).valid, false)
  assert.equal(fallback.validateHermes({ targets: [
    { entityId: 'bitcoin', relationship: 'same_topic_only', priorItemId: null, extra: 1 },
    { entityId: 'blackrock', relationship: 'same_topic_only', priorItemId: null },
  ] }, BATCH_RELATIONSHIP_STATE).valid, false)
  assert.equal(fallback.validateHermes({ targets: [
    { entityId: 'bitcoin', relationship: 'same_topic_only', priorItemId: null },
    { entityId: 'bitcoin', relationship: 'unrelated', priorItemId: null },
  ] }, BATCH_RELATIONSHIP_STATE).valid, false)
})
