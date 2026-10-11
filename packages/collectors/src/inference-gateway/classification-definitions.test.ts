import assert from 'node:assert/strict'
import test from 'node:test'
import {
  approvedClassificationDefinitions,
  articleEntityPlacementDefinition,
  articleRelatedMembershipDefinition,
  articleNoveltyDefinition,
  articleStoryRelationshipDefinition,
  articleEntityProposalValidationDefinition,
  researchFollowupValueDefinition,
  researchNoveltyDefinition,
  type ArticleEntityPlacementState,
  type ArticleEntityProposalValidationState,
  type ArticleRelatedMembershipState,
  type ArticleNoveltyState,
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
