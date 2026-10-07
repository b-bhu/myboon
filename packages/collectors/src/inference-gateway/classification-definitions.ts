import type { GateEntityContext, GateSignal } from '../research-gate/types'
import type {
  ClassificationDefinition,
  ClassificationDecisionValidation,
  JevAnswer,
  JevChoiceAnswer,
} from './classification-types'
import type { InferenceProviderTarget } from './types'
export const RESEARCH_NOVELTY_WORKLOAD = 'research.novelty' as const
export const RESEARCH_NOVELTY_VERSION = 'research.novelty.v1' as const
export const RESEARCH_FOLLOWUP_VALUE_WORKLOAD = 'research.followup_value' as const
export const RESEARCH_FOLLOWUP_VALUE_VERSION = 'research.followup_value.v1' as const
export const ARTICLE_ENTITY_PLACEMENT_WORKLOAD = 'research.article_entity_placement' as const
export const ARTICLE_ENTITY_PLACEMENT_VERSION = 'research.article_entity_placement.v2' as const
export const ARTICLE_ENTITY_PROPOSAL_VALIDATION_WORKLOAD = 'research.article_entity_proposal_validation' as const
export const ARTICLE_ENTITY_PROPOSAL_VALIDATION_VERSION = 'research.article_entity_proposal_validation.v1' as const
export const ARTICLE_STORY_RELATIONSHIP_WORKLOAD = 'research.article_story_relationship' as const
export const ARTICLE_STORY_RELATIONSHIP_VERSION = 'research.article_story_relationship.v2' as const
export const ARTICLE_RELATED_MEMBERSHIP_WORKLOAD = 'research.article_related_membership' as const
export const ARTICLE_RELATED_MEMBERSHIP_VERSION = 'research.article_related_membership.v1' as const
export const ARTICLE_NOVELTY_WORKLOAD = 'research.article_novelty' as const
export const ARTICLE_NOVELTY_VERSION = 'research.article_novelty.v2' as const

const JEV_TARGET = Object.freeze({ provider: 'typesafe', model: 'jev-1.13.0' })
const DEFAULT_HERMES_TARGET = Object.freeze({ provider: 'ollama-cloud', model: 'glm-5.3-flash' })
const DEFAULT_CAPACITY = Object.freeze({
  liveConcurrency: 4,
  providerMaxCalls: 120,
  workloadMaxCalls: 60,
  windowMs: 60_000,
  circuitFailureThreshold: 5,
  circuitCooldownMs: 10 * 60_000,
  leaseMs: 2 * 60_000,
})

export interface ResearchNoveltyState {
  signal: GateSignal
  context: GateEntityContext
}

export interface ResearchNoveltyDecision {
  verdict: 'already_known' | 'new_information' | 'contradicts_prior'
  reason: string
}

export interface ResearchFollowupValueState {
  signal: GateSignal
  context: GateEntityContext
}

export interface ResearchFollowupValueDecision {
  direction: 'worthwhile' | 'not_worthwhile' | 'uncertain'
  reason: string
}

export interface ArticleEntityPlacementState { article: { title: string, text: string }, candidates: Array<{ id: string, name: string, aliases: string[], summary: string | null, scope: Record<string, unknown> }> }
export interface ArticleEntityPlacementDecision { entityId: string | null, disposition: 'selected' | 'no_match' | 'uncertain' }
export interface ArticleEntityProposalValidationState { article: { title: string, text: string }, proposal: { name: string, type: string, aliases: string[], summary: string, scope: Record<string, unknown> } }
export interface ArticleEntityProposalValidationDecision { disposition: 'accept' | 'reject' | 'uncertain' }
export interface ArticleStoryRelationshipState { article: { title: string, sourceText: string, publishedAt: string | null, observedAt: string }, entity: { id: string, name: string }, recentItems: Array<{ id: string, source: 'legacy' | 'managed', title: string, summary: string, eventAt: string }> }
export interface ArticleStoryRelationshipDecision { relationship: 'duplicate' | 'direct_continuation' | 'related_story_branch' | 'same_topic_only' | 'unrelated' | 'uncertain', priorItemId: string | null, priorItemSource?: 'legacy' | 'managed' | null }
export interface ArticleRelatedMembershipState { article: { title: string, text: string }, primary: { id: string, name: string }, candidates: Array<{ id: string, name: string, aliases: string[], summary: string | null, scope: Record<string, unknown> }> }
export interface ArticleRelatedMembershipDecision { dispositions: Record<string, 'related' | 'not_related' | 'uncertain'> }
export interface ArticleNoveltyState { article: { title: string, text: string, publishedAt: string | null, observedAt: string }, histories: Array<{ entityId: string, items: Array<{ id: string, source: 'legacy' | 'managed', title: string, summary: string, eventAt: string }> }>, selectedTargets: Array<{ entityId: string, role: 'primary' | 'related', id: string, source: 'legacy' | 'managed', title: string, summary: string, eventAt: string }>, reconciliation?: { priorVerdict: string } }
export interface ArticleNoveltyDecision { verdict: 'new_information' | 'already_known' | 'contradicts_prior' | 'uncertain', primaryRelationship?: ArticleStoryRelationshipDecision['relationship'] }

const FOLLOWUP_VALUE_DECISION_DESCRIPTION = 'Assess whether one bounded follow-up could add information material to this research assignment beyond the supplied source and relevant saved knowledge. Unanswered details alone are not sufficient. Do not assert that any supplied claim is true. If the supplied context is insufficient to judge, return uncertain.'
const NOVELTY_DECISIONS = ['already_known', 'new_information', 'contradicts_prior'] as const
const FOLLOWUP_VALUE_DECISIONS = ['worthwhile', 'not_worthwhile', 'uncertain'] as const
const ARTICLE_RELATIONSHIPS = ['duplicate', 'direct_continuation', 'related_story_branch', 'same_topic_only', 'unrelated', 'uncertain'] as const

function articleCandidateState(value: unknown, path: string): { id: string, name: string, aliases: string[], summary: string | null, scope: Record<string, unknown> } {
  const candidate = requiredRecord(value, path)
  return {
    id: boundedText(candidate.id, `${path}.id`, 200),
    name: boundedText(candidate.name, `${path}.name`, 300),
    aliases: Array.isArray(candidate.aliases)
      ? candidate.aliases.slice(0, 25).map((item, index) => boundedText(item, `${path}.aliases[${index}]`, 200))
      : (() => { throw new Error(`${path}.aliases must be an array`) })(),
    summary: nullableText(candidate.summary, `${path}.summary`, 128_000),
    scope: requiredRecord(candidate.scope, `${path}.scope`),
  }
}

export function approvedClassificationDefinitions(
  hermesTarget: InferenceProviderTarget = DEFAULT_HERMES_TARGET,
): readonly ClassificationDefinition[] {
  return Object.freeze([researchNoveltyDefinition(hermesTarget), researchFollowupValueDefinition(hermesTarget), articleEntityPlacementDefinition(hermesTarget), articleEntityProposalValidationDefinition(hermesTarget), articleRelatedMembershipDefinition(hermesTarget), articleStoryRelationshipDefinition(hermesTarget), articleNoveltyDefinition(hermesTarget)])
}

export function articleEntityProposalValidationDefinition(hermesTarget: InferenceProviderTarget = DEFAULT_HERMES_TARGET): ClassificationDefinition<ArticleEntityProposalValidationState, ArticleEntityProposalValidationDecision> {
  return {
    workload: ARTICLE_ENTITY_PROPOSAL_VALIDATION_WORKLOAD, decisionVersion: ARTICLE_ENTITY_PROPOSAL_VALIDATION_VERSION, maximumLifecycleMode: 'active', defaultLifecycleMode: 'active', requiresJev: true, canaryPercent: 100,
    jevTarget: JEV_TARGET, hermesTarget, budget: { deadlineMs: 30_000, maxStateBytes: 96_000, maxInputTokens: 64_000, maxOutputTokens: 500 }, capacity: DEFAULT_CAPACITY,
    validateState: (value) => { if (!record(value) || !record(value.article) || !record(value.proposal)) return { valid: false, issues: ['article and proposal are required'] }; try { const proposal = value.proposal; return { valid: true, value: { article: { title: boundedText(value.article.title, 'article.title', 500), text: boundedText(value.article.text, 'article.text', 16_000) }, proposal: { name: boundedText(proposal.name, 'proposal.name', 300), type: boundedText(proposal.type, 'proposal.type', 100), aliases: Array.isArray(proposal.aliases) ? proposal.aliases.slice(0, 25).map((item, index) => boundedText(item, `proposal.aliases[${index}]`, 200)) : [], summary: boundedText(proposal.summary, 'proposal.summary', 128_000), scope: requiredRecord(proposal.scope, 'proposal.scope') } } } } catch (error) { return invalid(error) } },
    questions: () => ({ proposal: { type: 'choice', instructions: { question: 'Does this source-grounded proposed identity validly describe the article subject after no existing catalogue candidate matched?', rules: ['Accept only when name, type, aliases and scope are supported by the captured article.', 'Do not decide whether it duplicates an existing catalogue entity; Entity Manager performs equivalence checks.', 'Choose uncertain when the article does not support a safe identity proposal.'] }, criteria: { accept: 'A meaningful article-subject identity suitable for bounded Entity Manager equivalence checking.', reject: 'The proposed identity is unsupported, generic, or materially wrong.', uncertain: 'The captured article does not safely support or reject this proposal.' } } }),
    decodeJev: (answers) => { const answer = answers.proposal; return isChoice(answer) && ['accept', 'reject', 'uncertain'].includes(answer.choice) ? { valid: true, value: { disposition: answer.choice as ArticleEntityProposalValidationDecision['disposition'] } } : { valid: false, issues: ['proposal validation is invalid'] } },
    acceptJev: (answers) => isChoice(answers.proposal) ? { accepted: true, reason: 'Jev proposal validation distribution retained' } : { accepted: false, reason: 'proposal validation is not Choice' }, renderHermes: () => '', validateHermes: () => ({ valid: false, issues: ['Article proposal validation is Jev-only'] }),
  }
}

export function articleRelatedMembershipDefinition(hermesTarget: InferenceProviderTarget = DEFAULT_HERMES_TARGET): ClassificationDefinition<ArticleRelatedMembershipState, ArticleRelatedMembershipDecision> {
  return {
    workload: ARTICLE_RELATED_MEMBERSHIP_WORKLOAD, decisionVersion: ARTICLE_RELATED_MEMBERSHIP_VERSION, maximumLifecycleMode: 'active', defaultLifecycleMode: 'active', requiresJev: true, canaryPercent: 100,
    jevTarget: JEV_TARGET, hermesTarget, budget: { deadlineMs: 30_000, maxStateBytes: 96_000, maxInputTokens: 64_000, maxOutputTokens: 8_000 }, capacity: DEFAULT_CAPACITY,
    validateState: (value) => { if (!record(value) || !record(value.article) || !record(value.primary) || !Array.isArray(value.candidates) || value.candidates.length > 31) return { valid: false, issues: ['article, primary and up to 31 candidates are required'] }; try { return { valid: true, value: { article: { title: boundedText(value.article.title, 'article.title', 500), text: boundedText(value.article.text, 'article.text', 16_000) }, primary: { id: boundedText(value.primary.id, 'primary.id', 200), name: boundedText(value.primary.name, 'primary.name', 300) }, candidates: value.candidates.map((candidate, index) => articleCandidateState(candidate, `candidates[${index}]`)) } } } catch (error) { return invalid(error) } },
    questions: (state) => Object.fromEntries(state.candidates.map((candidate) => [`related_${candidate.id}`, { type: 'choice' as const, instructions: { question: `Should ${candidate.name} receive an independent related membership for this article?`, rules: ['Decide each candidate independently of the primary placement.', 'A co-mention, publisher, desk, venue, or generic context is not enough.', 'Bitcoin holding news can file Bitcoin primary and BlackRock related when the article materially concerns both.'] }, criteria: { related: 'The article materially concerns this candidate as an independent participant or subject.', not_related: 'The candidate is only incidental, contextual, a publisher, or absent.', uncertain: 'The captured article does not resolve an independent membership safely.' } }])),
    decodeJev: (answers, state) => { const dispositions: ArticleRelatedMembershipDecision['dispositions'] = {}; for (const candidate of state.candidates) { const answer = answers[`related_${candidate.id}`]; if (!isChoice(answer) || !['related', 'not_related', 'uncertain'].includes(answer.choice)) return { valid: false, issues: [`related membership for ${candidate.id} is invalid`] }; dispositions[candidate.id] = answer.choice as ArticleRelatedMembershipDecision['dispositions'][string] } return { valid: true, value: { dispositions } } },
    acceptJev: (answers, _decision, state) => state.candidates.every((candidate) => isChoice(answers[`related_${candidate.id}`])) ? { accepted: true, reason: 'Jev independent related-membership distributions retained' } : { accepted: false, reason: 'one or more membership answers are not Choice' }, renderHermes: () => '', validateHermes: () => ({ valid: false, issues: ['Article related membership is Jev-only'] }),
  }
}

export function articleNoveltyDefinition(hermesTarget: InferenceProviderTarget = DEFAULT_HERMES_TARGET): ClassificationDefinition<ArticleNoveltyState, ArticleNoveltyDecision> {
  return {
    workload: ARTICLE_NOVELTY_WORKLOAD, decisionVersion: ARTICLE_NOVELTY_VERSION, maximumLifecycleMode: 'active', defaultLifecycleMode: 'active', requiresJev: true, canaryPercent: 100,
    // At most 32 selected entities × five 500-character history excerpts plus
    // 32 exact duplicate targets and the admitted full capture fit this bound.
    jevTarget: JEV_TARGET, hermesTarget, budget: { deadlineMs: 30_000, maxStateBytes: 96_000, maxInputTokens: 64_000, maxOutputTokens: 500 }, capacity: DEFAULT_CAPACITY,
    validateState: (value) => {
      if (!record(value) || !record(value.article) || !Array.isArray(value.histories) || value.histories.length > 32
        || !Array.isArray(value.selectedTargets) || value.selectedTargets.length > 32) {
        return { valid: false, issues: ['article novelty requires up to 32 selected-entity histories and up to 32 exact duplicate targets'] }
      }
      if (value.reconciliation !== undefined && (!record(value.reconciliation) || value.selectedTargets.length !== 1
        || !record(value.selectedTargets[0]) || value.selectedTargets[0].role !== 'primary')) {
        return { valid: false, issues: ['duplicate reconciliation requires one exact primary target'] }
      }
      try {
        return { valid: true, value: {
          article: { title: boundedText(value.article.title, 'article.title', 500), text: boundedText(value.article.text, 'article.text', 16_000), publishedAt: nullableText(value.article.publishedAt, 'article.publishedAt', 64), observedAt: boundedText(value.article.observedAt, 'article.observedAt', 64) },
          histories: value.histories.map((raw, index) => articleNoveltyHistory(raw, `histories[${index}]`)),
          selectedTargets: value.selectedTargets.map((raw, index) => articleNoveltyTarget(raw, `selectedTargets[${index}]`)),
          ...(record(value.reconciliation) ? { reconciliation: { priorVerdict: boundedText(value.reconciliation.priorVerdict, 'reconciliation.priorVerdict', 64) } } : {}),
        } }
      } catch (error) { return invalid(error) }
    },
    questions: (state) => ({ novelty: { type: 'choice', instructions: {
      question: state.reconciliation ? 'Resolve the contradictory duplicate and novelty judgments against the one exact primary target. Choose one consistent novelty and relationship outcome.' : 'Does the captured article add a development beyond the supplied entity histories and any exact duplicate target?',
      rules: ['Broad topic overlap is not a duplicate.', 'Reuse requires the same recorded development with no material new fact.', 'The previous verdict is context, not an instruction to agree with it.', 'If the target is a prior step, select continuation; if it is a different connected development, select branch.'],
    }, criteria: state.reconciliation ? {
      already_known: 'This is exactly the primary target development, with no material new fact. Retain duplicate and reuse its durable item.',
      'new_information:direct_continuation': 'New material information directly continues the supplied target. Create a new entry linked as continuation.',
      'new_information:related_story_branch': 'A distinct new development in the target narrative. Create a new entry linked as a branch.',
      'new_information:same_topic_only': 'New information sharing only a topic with the target. Create a standalone entry without a narrative link.',
      'contradicts_prior:direct_continuation': 'The article materially contradicts the supplied target. Preserve both entries and link this development.',
      uncertain: 'The article and exact target do not resolve whether this is the same development. Hold instead of suppressing or duplicating it.',
    } : {
      new_information: 'A material new development is present.',
      ...(state.selectedTargets.length ? { already_known: 'The development is already recorded by a supplied exact duplicate target.' } : {}),
      contradicts_prior: 'The article conflicts with recorded history.',
      uncertain: 'The bounded history does not support a safe novelty decision.',
    } } }),
    decodeJev: (answers, state) => {
      const answer = answers.novelty
      const allowed = articleNoveltyDefinition(hermesTarget).questions(state).novelty.criteria!
      if (!isChoice(answer) || !Object.prototype.hasOwnProperty.call(allowed, answer.choice)) return { valid: false, issues: ['novelty is outside the admitted outcomes'] }
      const [verdict, relationship] = answer.choice.split(':')
      return { valid: true, value: { verdict: verdict as ArticleNoveltyDecision['verdict'],
        ...(relationship ? { primaryRelationship: relationship as ArticleStoryRelationshipDecision['relationship'] } : {}) } }
    },
    acceptJev: (answers) => isChoice(answers.novelty) ? { accepted: true, reason: 'Jev novelty distribution retained' } : { accepted: false, reason: 'novelty is not Choice' }, renderHermes: () => '', validateHermes: () => ({ valid: false, issues: ['Article novelty is Jev-only'] }),
  }
}

function articleNoveltyHistory(value: unknown, path: string): ArticleNoveltyState['histories'][number] {
  const history = requiredRecord(value, path)
  if (!Array.isArray(history.items) || history.items.length > 5) throw new Error(`${path}.items must contain at most five entries`)
  return { entityId: boundedText(history.entityId, `${path}.entityId`, 200), items: history.items.map((item, index) => articleNoveltyItem(item, `${path}.items[${index}]`)) }
}

function articleNoveltyTarget(value: unknown, path: string): ArticleNoveltyState['selectedTargets'][number] {
  const target = requiredRecord(value, path)
  const role = boundedText(target.role, `${path}.role`, 20)
  if (role !== 'primary' && role !== 'related') throw new Error(`${path}.role must be primary or related`)
  return { entityId: boundedText(target.entityId, `${path}.entityId`, 200), role, ...articleNoveltyItem(target, path) }
}

function articleNoveltyItem(value: unknown, path: string): { id: string, source: 'legacy' | 'managed', title: string, summary: string, eventAt: string } {
  const item = requiredRecord(value, path)
  const source = boundedText(item.source, `${path}.source`, 20)
  if (source !== 'legacy' && source !== 'managed') throw new Error(`${path}.source is invalid`)
  return { id: boundedText(item.id, `${path}.id`, 200), source, title: boundedText(item.title, `${path}.title`, 500), summary: boundedText(item.summary, `${path}.summary`, 500), eventAt: boundedText(item.eventAt, `${path}.eventAt`, 64) }
}

export function articleEntityPlacementDefinition(hermesTarget: InferenceProviderTarget = DEFAULT_HERMES_TARGET): ClassificationDefinition<ArticleEntityPlacementState, ArticleEntityPlacementDecision> {
  return {
    workload: ARTICLE_ENTITY_PLACEMENT_WORKLOAD, decisionVersion: ARTICLE_ENTITY_PLACEMENT_VERSION,
    maximumLifecycleMode: 'active', defaultLifecycleMode: 'active', requiresJev: true, canaryPercent: 100,
    jevTarget: JEV_TARGET, hermesTarget, budget: { deadlineMs: 30_000, maxStateBytes: 96_000, maxInputTokens: 64_000, maxOutputTokens: 4_000 }, capacity: DEFAULT_CAPACITY,
    validateState: (value) => {
      if (!record(value) || !record(value.article) || !Array.isArray(value.candidates) || value.candidates.length > 32) return { valid: false, issues: ['bounded article and candidate catalogue are required'] }
      try { return { valid: true, value: { article: { title: boundedText(value.article.title, 'article.title', 500), text: boundedText(value.article.text, 'article.text', 16_000) }, candidates: value.candidates.map((candidate, index) => { const item = requiredRecord(candidate, `candidates[${index}]`); return { id: boundedText(item.id, `candidates[${index}].id`, 200), name: boundedText(item.name, `candidates[${index}].name`, 300), aliases: Array.isArray(item.aliases) ? item.aliases.slice(0, 25).map((alias, aliasIndex) => boundedText(alias, `candidates[${index}].aliases[${aliasIndex}]`, 200)) : (() => { throw new Error('aliases must be an array') })(), summary: nullableText(item.summary, `candidates[${index}].summary`, 1_000), scope: requiredRecord(item.scope, `candidates[${index}].scope`) } }) } } } catch (error) { return invalid(error) }
    },
    questions: (state) => ({ placement: { type: 'choice', instructions: { question: 'Which supplied candidate is the primary entity for this article?', rules: ['Choose a candidate only when the article is substantively about it.', 'Choose no_match when no supplied candidate fits.', 'Choose uncertain for unresolved ambiguity.', 'Policy: proposal news concerning U.S.–Iran belongs primarily to U.S.–Iran Conflict. Bitcoin holding news belongs primarily to Bitcoin; BlackRock may be independently related.'] }, criteria: Object.fromEntries([...state.candidates.map((candidate, index) => [candidate.id, `${candidate.name}: the entity described by candidates[${index}] in the supplied state, including its aliases, summary and scope.`]), ['no_match', 'No supplied candidate is a meaningful primary placement.'], ['uncertain', 'The bounded candidates do not resolve placement safely.']]) } }),
    decodeJev: (answers) => { const answer = answers.placement; if (!isChoice(answer)) return { valid: false, issues: ['placement must be Choice'] }; if (answer.choice === 'no_match') return { valid: true, value: { entityId: null, disposition: 'no_match' } }; if (answer.choice === 'uncertain') return { valid: true, value: { entityId: null, disposition: 'uncertain' } }; return { valid: true, value: { entityId: answer.choice, disposition: 'selected' } } },
    acceptJev: (answers, decision, state) => { const answer = answers.placement; return isChoice(answer) && (decision.entityId === null || state.candidates.some((candidate) => candidate.id === decision.entityId)) ? { accepted: true, reason: 'Jev placement retained with raw probabilities' } : { accepted: false, reason: 'placement candidate is outside supplied catalogue' } },
    renderHermes: () => '', validateHermes: () => ({ valid: false, issues: ['Article placement is Jev-only'] }),
  }
}

export function articleStoryRelationshipDefinition(hermesTarget: InferenceProviderTarget = DEFAULT_HERMES_TARGET): ClassificationDefinition<ArticleStoryRelationshipState, ArticleStoryRelationshipDecision> {
  return {
    workload: ARTICLE_STORY_RELATIONSHIP_WORKLOAD, decisionVersion: ARTICLE_STORY_RELATIONSHIP_VERSION,
    maximumLifecycleMode: 'active', defaultLifecycleMode: 'active', requiresJev: true, canaryPercent: 100,
    jevTarget: JEV_TARGET, hermesTarget, budget: { deadlineMs: 30_000, maxStateBytes: 96_000, maxInputTokens: 64_000, maxOutputTokens: 4_000 }, capacity: DEFAULT_CAPACITY,
    validateState: (value) => {
      if (!record(value) || !record(value.article) || !record(value.entity) || !Array.isArray(value.recentItems) || value.recentItems.length > 5) return { valid: false, issues: ['article, entity and at most five recent items are required'] }
      try { return { valid: true, value: { article: { title: boundedText(value.article.title, 'article.title', 500), sourceText: boundedText(value.article.sourceText, 'article.sourceText', 16_000), publishedAt: nullableText(value.article.publishedAt, 'article.publishedAt', 64), observedAt: boundedText(value.article.observedAt, 'article.observedAt', 64) }, entity: { id: boundedText(value.entity.id, 'entity.id', 200), name: boundedText(value.entity.name, 'entity.name', 300) }, recentItems: value.recentItems.map((raw, index) => { const item = requiredRecord(raw, `recentItems[${index}]`); const source = boundedText(item.source, `recentItems[${index}].source`, 20); if (source !== 'legacy' && source !== 'managed') throw new Error('item source is invalid'); return { id: boundedText(item.id, `recentItems[${index}].id`, 200), source, title: boundedText(item.title, `recentItems[${index}].title`, 500), summary: boundedText(item.summary, `recentItems[${index}].summary`, 128_000), eventAt: boundedText(item.eventAt, `recentItems[${index}].eventAt`, 64) } }) } } } catch (error) { return invalid(error) }
    },
    questions: (state) => ({ relationship_target: { type: 'choice', instructions: {
      question: 'Choose the article relationship together with its exact supplied historical target, or a standalone outcome.',
      rules: ['A continuation or branch must identify one supplied item.', 'Duplicate means the same development, not the same topic.', 'A branch is not a direct next step or resolution.', 'With no valid target choose same_topic_only, unrelated, or uncertain. The five items are narrative context; older duplicate coverage is retrieved separately.'],
    }, criteria: Object.fromEntries([
      ['same_topic_only', 'Shares a broad topic but no meaningful narrative link to a supplied item. No historical target.'],
      ['unrelated', 'Not related to the supplied developments. No historical target.'],
      ['uncertain', 'No safe narrative relationship can be established. No historical target.'],
      ...state.recentItems.flatMap(item => [
        [`duplicate:${item.source}:${item.id}`, { relation: 'Same recorded development without a material new fact', target: item }],
        [`direct_continuation:${item.source}:${item.id}`, { relation: 'Later step, update, outcome, or explicit continuation of this target', target: item }],
        [`related_story_branch:${item.source}:${item.id}`, { relation: 'Distinct development in the same evolving narrative as this target', target: item }],
      ]),
    ]) } }),
    decodeJev: (answers, state) => {
      const answer = answers.relationship_target
      if (!isChoice(answer)) return { valid: false, issues: ['relationship_target must be Choice'] }
      const allowedChoices = ['same_topic_only', 'unrelated', 'uncertain', ...state.recentItems.flatMap(item =>
        ['duplicate', 'direct_continuation', 'related_story_branch'].map(relationship => `${relationship}:${item.source}:${item.id}`))]
      if (!allowedChoices.includes(answer.choice)) return { valid: false, issues: ['relationship target is outside supplied history'] }
      const [relationship, source, ...id] = answer.choice.split(':')
      const priorItemId = id.length ? id.join(':') : null
      if (!ARTICLE_RELATIONSHIPS.includes(relationship as typeof ARTICLE_RELATIONSHIPS[number])
        || (priorItemId === null ? !['same_topic_only', 'unrelated', 'uncertain'].includes(relationship)
          : !state.recentItems.some(item => item.id === priorItemId && item.source === source))) return { valid: false, issues: ['relationship target is outside supplied history'] }
      return { valid: true, value: { relationship: relationship as ArticleStoryRelationshipDecision['relationship'], priorItemId, priorItemSource: priorItemId ? source as 'legacy' | 'managed' : null } }
    },
    acceptJev: (answers) => isChoice(answers.relationship_target) ? { accepted: true, reason: 'Jev joint relationship/target distribution retained' } : { accepted: false, reason: 'relationship_target is not Choice' },
    renderHermes: () => '', validateHermes: () => ({ valid: false, issues: ['Article relationship is Jev-only'] }),
  }
}

export function researchNoveltyDefinition(
  hermesTarget: InferenceProviderTarget = DEFAULT_HERMES_TARGET,
): ClassificationDefinition<ResearchNoveltyState, ResearchNoveltyDecision> {
  return {
    workload: RESEARCH_NOVELTY_WORKLOAD,
    decisionVersion: RESEARCH_NOVELTY_VERSION,
    maximumLifecycleMode: 'canary',
    defaultLifecycleMode: 'disabled',
    canaryPercent: 10,
    jevTarget: JEV_TARGET,
    hermesTarget,
    budget: { deadlineMs: 30_000, maxStateBytes: 48_000, maxInputTokens: 10_000, maxOutputTokens: 1_000 },
    capacity: DEFAULT_CAPACITY,
    validateState: validateNoveltyState,
    questions: () => ({
      novelty: {
        type: 'choice',
        instructions: {
          question: 'Does `context.recentMemories` already contain what `signal` reports?',
          rules: [
            'Judge knowledge novelty only, never significance or publish-worthiness.',
            'When uncertain between already_known and new_information, choose new_information.',
          ],
        },
        criteria: {
          already_known: 'The same fact, move, or state is already recorded.',
          new_information: 'The signal adds a fact, move, or state not present in the timeline.',
          contradicts_prior: 'The signal conflicts with what the timeline currently records.',
        },
      },
    }),
    decodeJev: (answers) => {
      const answer = answers.novelty
      if (!isChoice(answer) || !NOVELTY_DECISIONS.includes(answer.choice as typeof NOVELTY_DECISIONS[number])) {
        return { valid: false, issues: ['novelty must be a registry-defined Choice'] }
      }
      return { valid: true, value: {
        verdict: answer.choice as ResearchNoveltyDecision['verdict'],
        reason: `Jev classified the signal as ${answer.choice}.`,
      } }
    },
    acceptJev: (answers) => {
      const answer = answers.novelty
      if (!isChoice(answer)) return { accepted: false, reason: 'novelty answer is not Choice' }
      const selected = answer.probabilities[answer.choice] ?? 0
      return selected >= 0.80 && answer.confidence >= 0.80
        ? { accepted: true, reason: 'novelty Choice passed registry thresholds' }
        : { accepted: false, reason: 'novelty Choice did not pass registry thresholds' }
    },
    renderHermes: (state) => [
      'You are the myboon Research Gate. Decide only whether the entity timeline already records the new signal.',
      'Do not judge importance, newsworthiness, evidence quality, or publishing.',
      'When uncertain between already_known and new_information, prefer new_information.',
      'Return strict JSON only: {"verdict":"already_known|new_information|contradicts_prior","reason":"one short sentence"}',
      JSON.stringify(state),
    ].join('\n'),
    validateHermes: (value) => validateNoveltyDecision(value),
  }
}

export function researchFollowupValueDefinition(
  hermesTarget: InferenceProviderTarget = DEFAULT_HERMES_TARGET,
): ClassificationDefinition<ResearchFollowupValueState, ResearchFollowupValueDecision> {
  return {
    workload: RESEARCH_FOLLOWUP_VALUE_WORKLOAD,
    decisionVersion: RESEARCH_FOLLOWUP_VALUE_VERSION,
    maximumLifecycleMode: 'canary',
    defaultLifecycleMode: 'disabled',
    canaryPercent: 10,
    jevTarget: JEV_TARGET,
    hermesTarget,
    budget: { deadlineMs: 30_000, maxStateBytes: 48_000, maxInputTokens: 10_000, maxOutputTokens: 1_000 },
    capacity: DEFAULT_CAPACITY,
    validateState: validateNoveltyState,
    questions: () => ({
      followup_value: {
        type: 'choice',
        instructions: {
          question: 'Does one bounded follow-up add information material to this research assignment?',
          rules: [
            FOLLOWUP_VALUE_DECISION_DESCRIPTION,
            'Judge follow-up value only, never importance or publish-worthiness.',
          ],
        },
        criteria: {
          worthwhile: 'A bounded follow-up could plausibly add information material to the assignment beyond the supplied source and saved knowledge.',
          not_worthwhile: 'The supplied source plus saved knowledge already covers what one bounded follow-up could add; remaining gaps do not justify spending it.',
          uncertain: 'The supplied context is insufficient to judge whether a bounded follow-up would add material information.',
        },
      },
    }),
    decodeJev: (answers) => {
      const answer = answers.followup_value
      if (!isChoice(answer) || !FOLLOWUP_VALUE_DECISIONS.includes(answer.choice as typeof FOLLOWUP_VALUE_DECISIONS[number])) {
        return { valid: false, issues: ['followup_value must be a registry-defined Choice'] }
      }
      return { valid: true, value: {
        direction: answer.choice as ResearchFollowupValueDecision['direction'],
        reason: `Jev classified the bounded follow-up as ${answer.choice}.`,
      } }
    },
    acceptJev: (answers) => {
      const answer = answers.followup_value
      if (!isChoice(answer)) return { accepted: false, reason: 'followup_value answer is not Choice' }
      const selected = answer.probabilities[answer.choice] ?? 0
      return selected >= 0.80 && answer.confidence >= 0.80
        ? { accepted: true, reason: 'followup_value Choice passed registry thresholds' }
        : { accepted: false, reason: 'followup_value Choice did not pass registry thresholds' }
    },
    renderHermes: (state) => [
      FOLLOWUP_VALUE_DECISION_DESCRIPTION,
      'Do not judge importance, newsworthiness, or evidence quality, and never assert that a supplied claim is true.',
      'Return strict JSON only: {"direction":"worthwhile|not_worthwhile|uncertain","reason":"one short sentence"}',
      JSON.stringify(state),
    ].join('\n'),
    validateHermes: (value) => validateFollowupValueDecision(value),
  }
}

function validateNoveltyState(value: unknown) {
  if (!record(value) || !record(value.signal) || !record(value.context)
    || !Array.isArray(value.context.entities) || !Array.isArray(value.context.recentMemories)) {
    return { valid: false as const, issues: ['signal and bounded entity context are required'] }
  }
  try {
    const signal = value.signal
    const context = value.context
    const entities = context.entities as unknown[]
    const recentMemories = context.recentMemories as unknown[]
    if (entities.length > 20 || recentMemories.length > 20) {
      throw new Error('entity context exceeds the registered array limits')
    }
    return { valid: true as const, value: {
      signal: {
        source: boundedText(signal.source, 'signal.source', 100),
        sourceRefId: boundedText(signal.sourceRefId, 'signal.sourceRefId', 300),
        title: boundedText(signal.title, 'signal.title', 500),
        whatChanged: boundedText(signal.whatChanged, 'signal.whatChanged', 2_000),
        observedAt: boundedText(signal.observedAt, 'signal.observedAt', 64),
        ...(signal.sourceMaterial === undefined ? {} : {
          sourceMaterial: boundedText(signal.sourceMaterial, 'signal.sourceMaterial', 12_000),
          sourceMaterialDigest: boundedText(signal.sourceMaterialDigest, 'signal.sourceMaterialDigest', 100),
          sourceMaterialComplete: signal.sourceMaterialComplete === true,
        }),
      },
      context: {
        entities: entities.map((item, index) => {
          const entity = requiredRecord(item, `context.entities[${index}]`)
          return {
            id: boundedText(entity.id, `context.entities[${index}].id`, 200),
            slug: boundedText(entity.slug, `context.entities[${index}].slug`, 200),
            name: boundedText(entity.name, `context.entities[${index}].name`, 300),
            summary: nullableText(entity.summary, `context.entities[${index}].summary`, 1_000),
          }
        }),
        recentMemories: recentMemories.map((item, index) => {
          const memory = requiredRecord(item, `context.recentMemories[${index}]`)
          return {
            entityId: boundedText(memory.entityId, `context.recentMemories[${index}].entityId`, 200),
            memoryType: boundedText(memory.memoryType, `context.recentMemories[${index}].memoryType`, 100),
            title: boundedText(memory.title, `context.recentMemories[${index}].title`, 500),
            summary: boundedText(memory.summary, `context.recentMemories[${index}].summary`, 2_000),
            eventAt: boundedText(memory.eventAt, `context.recentMemories[${index}].eventAt`, 64),
          }
        }),
      },
    } }
  } catch (error) { return invalid(error) }
}

function validateNoveltyDecision(value: unknown): ClassificationDecisionValidation<ResearchNoveltyDecision> {
  if (!record(value) || typeof value.verdict !== 'string'
    || !NOVELTY_DECISIONS.includes(value.verdict as typeof NOVELTY_DECISIONS[number])) {
    return { valid: false, issues: ['verdict is invalid'] }
  }
  const reason = typeof value.reason === 'string' && value.reason.trim()
    ? value.reason.trim().slice(0, 500) : `Classification verdict ${value.verdict}.`
  return { valid: true, value: { verdict: value.verdict as ResearchNoveltyDecision['verdict'], reason } }
}

function validateFollowupValueDecision(value: unknown): ClassificationDecisionValidation<ResearchFollowupValueDecision> {
  if (!record(value) || typeof value.direction !== 'string'
    || !FOLLOWUP_VALUE_DECISIONS.includes(value.direction as typeof FOLLOWUP_VALUE_DECISIONS[number])) {
    return { valid: false, issues: ['direction is invalid'] }
  }
  const reason = typeof value.reason === 'string' && value.reason.trim()
    ? value.reason.trim().slice(0, 500) : `Follow-up value ${value.direction}.`
  return { valid: true, value: { direction: value.direction as ResearchFollowupValueDecision['direction'], reason } }
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!record(value)) throw new Error(`${field} must be an object`)
  return value
}

function boundedText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string') throw new Error(`${field} must be text`)
  const text = value.trim()
  if (!text || text.length > maximum || text.includes('\0')) throw new Error(`${field} is outside its registered bounds`)
  return text
}

function nullableText(value: unknown, field: string, maximum: number): string | null {
  return value === null ? null : boundedText(value, field, maximum)
}

/** Defensive even when a test/durable adapter bypasses the normal raw parser. */
function isChoice(value: JevAnswer | undefined): value is JevChoiceAnswer {
  if (value?.type !== 'choice' || !value.choice.trim() || !Number.isFinite(value.confidence)
    || value.confidence < 0 || value.confidence > 1) return false
  const entries = Object.entries(value.probabilities)
  if (entries.length === 0 || !Object.prototype.hasOwnProperty.call(value.probabilities, value.choice)) return false
  let total = 0
  for (const [key, probability] of entries) {
    if (!key.trim() || !Number.isFinite(probability) || probability < 0 || probability > 1) return false
    total += probability
  }
  return Math.abs(total - 1) <= 0.02
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function invalid(error: unknown): ClassificationDecisionValidation<never> {
  return { valid: false, issues: [error instanceof Error ? error.message : String(error)] }
}
