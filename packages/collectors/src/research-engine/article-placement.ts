import { Buffer } from 'node:buffer'
import type {
  ArticleChoiceDecision, ArticleDecisionV2, ArticleEntityCreationProposal, ArticleEntityProposal, ArticleV2EntityProposal, Signal,
} from '../signal-platform/contracts'
import type { ClassificationGateway, ClassificationResult } from '../inference-gateway'
import {
  ARTICLE_ENTITY_PLACEMENT_VERSION,
  ARTICLE_ENTITY_PLACEMENT_HERMES_FALLBACK_VERSION,
  ARTICLE_ENTITY_PLACEMENT_WORKLOAD,
  ARTICLE_ENTITY_PROPOSAL_VALIDATION_VERSION,
  ARTICLE_ENTITY_PROPOSAL_VALIDATION_HERMES_FALLBACK_VERSION,
  ARTICLE_ENTITY_PROPOSAL_VALIDATION_WORKLOAD,
  ARTICLE_RELATED_MEMBERSHIP_VERSION,
  ARTICLE_RELATED_MEMBERSHIP_HERMES_FALLBACK_VERSION,
  ARTICLE_RELATED_MEMBERSHIP_WORKLOAD,
  ARTICLE_NOVELTY_VERSION,
  ARTICLE_NOVELTY_HERMES_FALLBACK_VERSION,
  ARTICLE_NOVELTY_WORKLOAD,
  ARTICLE_STORY_RELATIONSHIP_VERSION,
  ARTICLE_STORY_RELATIONSHIP_HERMES_FALLBACK_VERSION,
  ARTICLE_STORY_RELATIONSHIP_WORKLOAD,
  type ArticleEntityPlacementDecision,
  type ArticleEntityProposalValidationDecision,
  type ArticleRelatedMembershipDecision,
  type ArticleNoveltyDecision,
  type ArticleStoryRelationshipDecision,
} from '../inference-gateway/classification-definitions'
import type { ArticleResearchContext } from '../research-gate/managed-context-reader'
import { rankEntityCandidates } from '../research-gate/entity-candidates'
import {
  ARTICLE_DECISION_SOURCE_MAX_CHARS,
  ARTICLE_DECISION_STATE_MAX_BYTES,
  articleCandidateDecisionSummary,
  articleHistoryDecisionTitle,
} from './article-input-bounds'
export { ARTICLE_DECISION_SOURCE_MAX_CHARS, ARTICLE_DECISION_STATE_MAX_BYTES } from './article-input-bounds'

type Decision = ArticleChoiceDecision | ArticleDecisionV2
// Written out explicitly: ExtensibleContract's index signature collapses Omit.
interface Membership {
  [key: string]: unknown
  entityId: string | null
  placementDisposition: ArticleV2EntityProposal['placementDisposition']
  role: ArticleV2EntityProposal['role']
  name: string
  type: string | null
  aliases: string[]
  summary: string | null
  scope: Record<string, unknown>
  creationProposal: ArticleEntityCreationProposal | null
  creationDecision: Decision | null
  placement: Decision
  relationship: ArticleV2EntityProposal['relationship']
  relationshipDecision: Decision | null
  priorItemDecision: Decision | null
  priorItemId: string | null
  priorItemSource: 'legacy' | 'managed' | null
  duplicateTarget: { itemId: string, source: 'legacy' | 'managed', entityId: string } | null
  contextualDuplicateTarget?: { itemId: string, source: 'legacy' | 'managed', entityId: string } | null
}

export interface ArticlePlacementPreparationV1 {
  memberships: ArticleEntityProposal[]
  novelty: ArticleChoiceDecision
  contextualHistory: string
}

export interface ArticlePlacementPreparationV2 {
  memberships: ArticleV2EntityProposal[]
  novelty: ArticleDecisionV2
  contextualHistory: string
}

/**
 * Code retrieves a bounded catalogue first. Jev then selects placement and
 * story relationship; Hermes receives the prepared memberships only later to
 * write timeline prose. This module never invokes a generative provider.
 */
export interface ArticlePlacementInput {
  gateway: Pick<ClassificationGateway, 'classify'>
  stableDecisionKey: string
  signal: Signal
  sourceText: string
  context: ArticleResearchContext
  proposeCreation?(): Promise<ArticleEntityCreationProposal>
  /**
   * Opt-in Hermes fallback dispatch: every classify call targets the
   * *_HERMES_FALLBACK_VERSION decision versions and retained decisions become
   * provider-aware ArticleDecisionV2. Off by default; the packet stays v1.
   */
  useHermesFallbackVersions?: boolean
}

export async function prepareArticlePlacement(input: ArticlePlacementInput & { useHermesFallbackVersions?: false }): Promise<ArticlePlacementPreparationV1>
export async function prepareArticlePlacement(input: ArticlePlacementInput & { useHermesFallbackVersions: true }): Promise<ArticlePlacementPreparationV2>
export async function prepareArticlePlacement(input: ArticlePlacementInput): Promise<ArticlePlacementPreparationV1 | ArticlePlacementPreparationV2>
export async function prepareArticlePlacement(input: ArticlePlacementInput): Promise<ArticlePlacementPreparationV1 | ArticlePlacementPreparationV2> {
  const fallbackVersions = input.useHermesFallbackVersions === true
  const version = (base: string, fallback: string) => fallbackVersions ? fallback : base
  const decision = <T>(result: ClassificationResult<T>, question: string, hermesChoice: string) => decide(result, question, fallbackVersions, hermesChoice)
  // Jev receives the immutable capture, never an unmarked excerpt.  The
  // definition limits are therefore an admission bound, not a truncation
  // policy: an oversized capture must wait for a configured larger workload.
  if (input.sourceText.length > ARTICLE_DECISION_SOURCE_MAX_CHARS) {
    throw new ArticleResearchHold('source_input_too_large', `Captured article exceeds the ${ARTICLE_DECISION_SOURCE_MAX_CHARS}-character Jev source-input bound.`)
  }
  assertContextCoverage(input.context)
  let candidates = rankEntityCandidates(input.context.candidates, articleLookupTerms(input.signal))
  let placement = await input.gateway.classify<ArticleEntityPlacementDecision>({
    workload: ARTICLE_ENTITY_PLACEMENT_WORKLOAD,
    decisionVersion: version(ARTICLE_ENTITY_PLACEMENT_VERSION, ARTICLE_ENTITY_PLACEMENT_HERMES_FALLBACK_VERSION),
    state: articleDecisionState('placement', { article: { title: input.signal.title, text: input.sourceText }, candidates: decisionCandidates(candidates) }),
    trace: { stableDecisionKey: `${input.stableDecisionKey}:placement`, correlationIds: { signalId: input.signal.signalId } },
  })
  if (!placement.value.entityId && input.context.widenCandidates) {
    const widened = await input.context.widenCandidates(articleLookupTerms(input.signal, input.sourceText))
    assertContextCoverage(input.context)
    const merged = rankEntityCandidates([...widened, ...candidates], articleLookupTerms(input.signal, input.sourceText))
    if (merged.some((candidate, index) => candidate.id !== candidates[index]?.id) || merged.length !== candidates.length) {
      candidates = merged
      placement = await input.gateway.classify<ArticleEntityPlacementDecision>({
        workload: ARTICLE_ENTITY_PLACEMENT_WORKLOAD,
        decisionVersion: version(ARTICLE_ENTITY_PLACEMENT_VERSION, ARTICLE_ENTITY_PLACEMENT_HERMES_FALLBACK_VERSION),
        state: articleDecisionState('placement', { article: { title: input.signal.title, text: input.sourceText }, candidates: decisionCandidates(candidates) }),
        trace: { stableDecisionKey: `${input.stableDecisionKey}:placement:widened`, correlationIds: { signalId: input.signal.signalId } },
      })
    }
  }
  let selected = placement.value.entityId
  if (!selected) {
    if (placement.value.disposition === 'uncertain') {
      throw new ArticleResearchHold('entity_resolution_uncertain', 'Placement could not safely resolve article placement after bounded catalogue retrieval.')
    }
    if (!input.proposeCreation) throw new ArticleResearchHold('entity_resolution_no_match', 'No matching entity was found and no durable source-grounded creation proposal is configured.')
    const creationProposal = await input.proposeCreation()
    if (input.context.findExactEntities) {
      let exact: ArticleResearchContext['candidates']
      try { exact = await input.context.findExactEntities([creationProposal.name, ...creationProposal.aliases]) }
      catch {
        throw new ArticleResearchHold(
          input.context.coverageFailureKind === 'transient' ? 'context_coverage_transient' : 'context_coverage_unavailable',
          'Exact entity identity lookup failed; no creation is allowed without complete identity coverage.',
        )
      }
      assertContextCoverage(input.context)
      if (exact.length > 0) {
        candidates = rankEntityCandidates([...exact, ...candidates], [creationProposal.name, ...creationProposal.aliases])
        placement = await input.gateway.classify<ArticleEntityPlacementDecision>({
          workload: ARTICLE_ENTITY_PLACEMENT_WORKLOAD,
          decisionVersion: version(ARTICLE_ENTITY_PLACEMENT_VERSION, ARTICLE_ENTITY_PLACEMENT_HERMES_FALLBACK_VERSION),
          state: articleDecisionState('exact identity placement', { article: { title: input.signal.title, text: input.sourceText }, candidates: decisionCandidates(candidates) }),
          trace: { stableDecisionKey: `${input.stableDecisionKey}:placement:exact-identity`, correlationIds: { signalId: input.signal.signalId } },
        })
        selected = placement.value.entityId
        if (!selected) throw new ArticleResearchHold('entity_resolution_uncertain', 'An existing exact entity identity was found but placement could not resolve it; the identity will not be duplicated.')
      }
    }
    if (!selected) {
      const creationValidation = await input.gateway.classify<ArticleEntityProposalValidationDecision>({
        workload: ARTICLE_ENTITY_PROPOSAL_VALIDATION_WORKLOAD,
        decisionVersion: version(ARTICLE_ENTITY_PROPOSAL_VALIDATION_VERSION, ARTICLE_ENTITY_PROPOSAL_VALIDATION_HERMES_FALLBACK_VERSION),
        state: articleDecisionState('creation proposal validation', { article: { title: input.signal.title, text: input.sourceText }, proposal: creationProposal }),
        trace: { stableDecisionKey: `${input.stableDecisionKey}:creation-proposal`, correlationIds: { signalId: input.signal.signalId } },
      })
      if (creationValidation.value.disposition === 'uncertain') throw new ArticleResearchHold('entity_resolution_uncertain', 'Placement could not safely validate the source-grounded new-entity proposal.')
      if (creationValidation.value.disposition === 'reject') throw new ArticleResearchHold('entity_resolution_no_match', 'The source-grounded new-entity proposal was rejected; an actionable identity is required.')
      return <ArticlePlacementPreparationV1 | ArticlePlacementPreparationV2>{
        memberships: [{
          entityId: null, placementDisposition: placement.value.disposition, role: 'primary', name: creationProposal.name, type: creationProposal.type, aliases: [...creationProposal.aliases],
          summary: creationProposal.summary, scope: { ...creationProposal.scope }, creationProposal, creationDecision: decision(creationValidation, 'proposal', creationValidation.value.disposition),
          placement: decision(placement, 'placement', placement.value.entityId ?? placement.value.disposition), relationship: null, relationshipDecision: null, priorItemDecision: null,
          priorItemId: null, priorItemSource: null, duplicateTarget: null,
        }] as Membership[],
        novelty: await novelty(input, [], []),
        contextualHistory: 'No existing entity placement was selected; Entity Manager must assess the bounded creation proposal.',
      }
    }
  }
  const entity = candidates.find((candidate) => candidate.id === selected)
  if (!entity) throw new Error('Placement selected an entity outside the bounded candidate catalogue')
  const relatedCandidates = candidates.filter((candidate) => candidate.id !== entity.id)
  const related = relatedCandidates.length === 0 ? null : await input.gateway.classify<ArticleRelatedMembershipDecision>({
    workload: ARTICLE_RELATED_MEMBERSHIP_WORKLOAD,
    decisionVersion: version(ARTICLE_RELATED_MEMBERSHIP_VERSION, ARTICLE_RELATED_MEMBERSHIP_HERMES_FALLBACK_VERSION),
    state: articleDecisionState('related memberships', { article: { title: input.signal.title, text: input.sourceText }, primary: { id: entity.id, name: entity.name }, candidates: decisionCandidates(relatedCandidates) }),
    trace: { stableDecisionKey: `${input.stableDecisionKey}:related-memberships`, correlationIds: { signalId: input.signal.signalId, entityId: entity.id } },
  })
  const memberships: Membership[] = []
  for (const candidate of relatedCandidates) {
    if (related?.value.dispositions[candidate.id] !== 'related') continue
    memberships.push(await membership(input, candidate, 'related', decision(related, relatedQuestion(candidate.id), related.value.dispositions[candidate.id] ?? 'uncertain')))
  }
  memberships.unshift(await membership(input, entity, 'primary', decision(placement, 'placement', placement.value.entityId ?? placement.value.disposition)))
  return <ArticlePlacementPreparationV1 | ArticlePlacementPreparationV2>{
    memberships,
    novelty: await novelty(input, memberships.map((membership) => membership.entityId).filter((id): id is string => id !== null), memberships),
    contextualHistory: memberships.map((membership) => {
      const prior = membership.priorItemId ? `linked to ${membership.priorItemSource} item ${membership.priorItemId}` : 'has no selected prior item'
      const history = (input.context.historyByEntity.get(membership.entityId ?? '') ?? []).slice(0, 5)
        .map((item) => `[${item.source}:${item.id}] ${item.eventAt} — ${item.title}: ${item.summary}`).join('\n')
      return `${membership.role} ${membership.name}: ${membership.relationship ?? 'placement unresolved'}; ${prior}.\nRecent connected history:\n${history || '(none)'}`
    }).join('\n'),
  }
}

export class ArticleResearchHold extends Error {
  constructor(readonly code: 'entity_resolution_no_match' | 'entity_resolution_uncertain' | 'required_jev_disabled' | 'source_capture_missing' | 'source_input_too_large' | 'decision_state_too_large' | 'context_coverage_unavailable' | 'context_coverage_transient' | 'incompatible_article_checkpoint', message: string) { super(message); this.name = 'ArticleResearchHold' }
}

async function membership(
  input: ArticlePlacementInput,
  entity: ArticleResearchContext['candidates'][number], role: 'primary' | 'related',
  placement: Decision,
): Promise<Membership> {
  const allHistory = input.context.loadHistory
    ? await input.context.loadHistory(entity.id)
    : input.context.historyByEntity.get(entity.id) ?? []
  input.context.historyByEntity.set(entity.id, allHistory)
  assertContextCoverage(input.context)
  const history = allHistory.slice(0, 5)
  let relationship = await input.gateway.classify<ArticleStoryRelationshipDecision>({
    workload: ARTICLE_STORY_RELATIONSHIP_WORKLOAD,
    decisionVersion: input.useHermesFallbackVersions === true
      ? ARTICLE_STORY_RELATIONSHIP_HERMES_FALLBACK_VERSION : ARTICLE_STORY_RELATIONSHIP_VERSION,
    state: articleDecisionState('story relationship', { article: { title: input.signal.title, sourceText: input.sourceText, publishedAt: input.signal.publishedAt, observedAt: input.signal.observedAt }, entity: { id: entity.id, name: entity.name }, recentItems: history.map(relationshipHistoryItem) }),
    trace: { stableDecisionKey: `${input.stableDecisionKey}:relationship:${entity.id}`, correlationIds: { signalId: input.signal.signalId, entityId: entity.id } },
  })
  let relationshipHistory = history
  // The latest five are narrative context only. A separate, bounded older
  // lookup is consulted exclusively to find a duplicate target; it never
  // redefines a branch/continuation relationship from the latest context.
  if (relationship.value.relationship !== 'duplicate' && input.context.lookupOlderDuplicate) {
    const older = await input.context.lookupOlderDuplicate(entity.id)
    assertContextCoverage(input.context)
    if (older.length > 0) {
      const targeted = await input.gateway.classify<ArticleStoryRelationshipDecision>({
        workload: ARTICLE_STORY_RELATIONSHIP_WORKLOAD,
        decisionVersion: input.useHermesFallbackVersions === true
          ? ARTICLE_STORY_RELATIONSHIP_HERMES_FALLBACK_VERSION : ARTICLE_STORY_RELATIONSHIP_VERSION,
        state: articleDecisionState('older duplicate relationship', { article: { title: input.signal.title, sourceText: input.sourceText, publishedAt: input.signal.publishedAt, observedAt: input.signal.observedAt }, entity: { id: entity.id, name: entity.name }, recentItems: older.map(relationshipHistoryItem) }),
        trace: { stableDecisionKey: `${input.stableDecisionKey}:older-duplicate:${entity.id}`, correlationIds: { signalId: input.signal.signalId, entityId: entity.id } },
      })
      if (targeted.value.relationship === 'duplicate') { relationship = targeted; relationshipHistory = older }
    }
  }
  const prior = relationship.value.priorItemId === null ? null : relationshipHistory.find((item) => item.id === relationship.value.priorItemId
    && (!relationship.value.priorItemSource || item.source === relationship.value.priorItemSource)) ?? null
  if (relationship.value.relationship === 'duplicate' && !prior) {
    throw new ArticleResearchHold('entity_resolution_uncertain', 'A story relationship marked a duplicate without a valid durable historical target.')
  }
  if ((relationship.value.relationship === 'direct_continuation' || relationship.value.relationship === 'related_story_branch') && !prior) {
    throw new ArticleResearchHold('entity_resolution_uncertain', 'A relationship selected a continuation or story branch without a valid durable historical target.')
  }
  const fallback = input.useHermesFallbackVersions === true
  const relationshipDecision = decide(relationship, 'relationship', fallback, relationship.value.relationship)
  const priorItemDecision = decide(relationship, 'prior_item', fallback, relationship.value.priorItemId ?? 'none')
  return {
    entityId: entity.id, placementDisposition: 'selected', role, name: entity.name, type: null, aliases: [...entity.aliases], summary: entity.summary,
    scope: { ...entity.scope }, creationProposal: null, creationDecision: null, placement,
    relationship: relationship.value.relationship, relationshipDecision,
    priorItemDecision,
    priorItemId: prior?.id ?? null, priorItemSource: prior?.source ?? null,
    duplicateTarget: relationship.value.relationship === 'duplicate' && prior
      ? { itemId: prior.id, source: prior.source, entityId: entity.id } : null,
  }
}

async function novelty(
  input: ArticlePlacementInput, entityIds: string[], memberships: Membership[],
): Promise<Decision> {
  const fallback = input.useHermesFallbackVersions === true
  // Membership selection permits up to 32 entities. Preserve each selected
  // entity in novelty state; history excerpts have a declared state bound.
  const histories = entityIds.map((entityId) => ({ entityId, items: (input.context.historyByEntity.get(entityId) ?? []).slice(0, 5).map(noveltyHistoryItem) }))
  const selectedTargets = await noveltyTargets(input, memberships)
  assertContextCoverage(input.context)
  const result = await input.gateway.classify<ArticleNoveltyDecision>({
    workload: ARTICLE_NOVELTY_WORKLOAD, decisionVersion: fallback ? ARTICLE_NOVELTY_HERMES_FALLBACK_VERSION : ARTICLE_NOVELTY_VERSION,
    state: articleDecisionState('novelty', { article: { title: input.signal.title, text: input.sourceText, publishedAt: input.signal.publishedAt, observedAt: input.signal.observedAt }, histories, selectedTargets }),
    trace: { stableDecisionKey: `${input.stableDecisionKey}:novelty`, correlationIds: { signalId: input.signal.signalId } },
  })
  let decision = decide(result, 'novelty', fallback, result.value.verdict)
  if (decision.choice === 'uncertain' && 'provider' in decision && decision.provider === 'hermes') {
    throw new ArticleResearchHold('entity_resolution_uncertain', 'Hermes fallback novelty is uncertain; the article is held instead of saving a default.')
  }
  const primary = memberships.find(membership => membership.role === 'primary' && membership.duplicateTarget)
  // A contradictory known/new judgment gets one bounded primary-target
  // reconciliation. An uncertain result is already an explicit hold outcome;
  // do not spend another provider call trying to turn unknown into reuse.
  if (primary && ['new_information', 'contradicts_prior'].includes(decision.choice)) {
    const target = selectedTargets.find(target => target.role === 'primary' && target.id === primary.duplicateTarget!.itemId && target.source === primary.duplicateTarget!.source)
    if (!target) throw new ArticleResearchHold('entity_resolution_uncertain', 'The primary duplicate target is unavailable for reconciliation.')
    const reconciled = await input.gateway.classify<ArticleNoveltyDecision>({
      workload: ARTICLE_NOVELTY_WORKLOAD, decisionVersion: fallback ? ARTICLE_NOVELTY_HERMES_FALLBACK_VERSION : ARTICLE_NOVELTY_VERSION,
      state: articleDecisionState('duplicate reconciliation', { article: { title: input.signal.title, text: input.sourceText, publishedAt: input.signal.publishedAt, observedAt: input.signal.observedAt }, histories,
        selectedTargets: [target], reconciliation: { priorVerdict: decision.choice } }),
      trace: { stableDecisionKey: `${input.stableDecisionKey}:novelty:reconcile`, correlationIds: { signalId: input.signal.signalId } },
    })
    decision = decide(reconciled, 'novelty', fallback, reconciled.value.verdict, key => key.split(':')[0])
    if (decision.choice === 'uncertain' && 'provider' in decision && decision.provider === 'hermes') {
      throw new ArticleResearchHold('entity_resolution_uncertain', 'Hermes fallback duplicate reconciliation is uncertain; the article is held.')
    }
    if (['new_information', 'contradicts_prior'].includes(decision.choice) && reconciled.value.primaryRelationship && reconciled.value.primaryRelationship !== 'duplicate') {
      primary.relationship = reconciled.value.primaryRelationship
      primary.relationshipDecision = decide(reconciled, 'novelty', fallback, reconciled.value.primaryRelationship ?? 'uncertain', key => key.split(':')[1] ?? (key === 'already_known' ? 'duplicate' : 'uncertain'))
      primary.duplicateTarget = null
      if (primary.relationship === 'same_topic_only' || primary.relationship === 'uncertain') {
        primary.priorItemId = null; primary.priorItemSource = null; primary.priorItemDecision = null
      }
    }
  }
  const duplicateTargets = memberships.flatMap((membership) => membership.duplicateTarget ? [membership.duplicateTarget] : [])
  if (decision.choice === 'already_known' && duplicateTargets.length === 0) {
    throw new ArticleResearchHold('entity_resolution_uncertain', 'Jev marked the article already known without an exact durable duplicate target.')
  }
  if (decision.choice === 'uncertain' && duplicateTargets.length > 0) {
    throw new ArticleResearchHold('entity_resolution_uncertain', 'Jev novelty is uncertain despite a duplicate target; reuse requires a resolved decision.')
  }
  if (decision.choice === 'already_known') {
    // The primary exact duplicate is the only authoritative reuse decision for
    // one incoming article. A related entity can have an independent historical
    // match without proving that its item is the same shared development. Keep
    // that raw relationship/prior-item judgment as context, but do not let it
    // force a merge or make the article appear to have two durable targets.
    const primary = memberships.find((membership) => membership.role === 'primary' && membership.duplicateTarget)
    if (!primary?.duplicateTarget) {
      throw new ArticleResearchHold('entity_resolution_uncertain', 'Jev marked the article already known without a primary exact durable duplicate target.')
    }
    for (const membership of memberships) {
      if (membership === primary || !membership.duplicateTarget) continue
      membership.contextualDuplicateTarget = membership.duplicateTarget
      membership.duplicateTarget = null
    }
    const resolvedTargets = memberships.flatMap((membership) => membership.duplicateTarget ? [membership.duplicateTarget] : [])
    if (new Set(resolvedTargets.map((target) => `${target.source}:${target.itemId}`)).size > 1) {
      throw new ArticleResearchHold('entity_resolution_uncertain', 'Jev duplicate judgments disagree on the shared item to reuse.')
    }
  }
  // A related-entity duplicate can coexist with a new primary development.
  // An exact duplicate selected for the primary, however, materially conflicts
  // with global new/contradictory novelty and must be held for review.
  const primaryDuplicate = memberships.some((membership) => membership.role === 'primary' && membership.relationship === 'duplicate' && membership.duplicateTarget !== null)
  if (primaryDuplicate && (decision.choice === 'new_information' || decision.choice === 'contradicts_prior')) {
    throw new ArticleResearchHold('entity_resolution_uncertain', 'Jev novelty conflicts with the primary entity’s exact duplicate target; the article is held instead of suppressing or creating an item.')
  }
  return decision
}

async function noveltyTargets(
  input: ArticlePlacementInput, memberships: readonly Membership[],
): Promise<Array<{ entityId: string, role: 'primary' | 'related', id: string, source: 'legacy' | 'managed', title: string, summary: string, eventAt: string }>> {
  const targets = [] as Array<{ entityId: string, role: 'primary' | 'related', id: string, source: 'legacy' | 'managed', title: string, summary: string, eventAt: string }>
  for (const membership of memberships) {
    const target = membership.duplicateTarget
    if (!target || membership.entityId === null) continue
    let entries = input.context.historyByEntity.get(membership.entityId) ?? []
    let selected = entries.find((item) => item.id === target.itemId && item.source === target.source)
    if (!selected && input.context.lookupOlderDuplicate) {
      entries = await input.context.lookupOlderDuplicate(membership.entityId)
      assertContextCoverage(input.context)
      selected = entries.find((item) => item.id === target.itemId && item.source === target.source)
    }
    if (!selected) {
      throw new ArticleResearchHold('entity_resolution_uncertain', 'A selected exact duplicate target could not be retained for the independent novelty decision.')
    }
    targets.push({ entityId: membership.entityId, role: membership.role, ...noveltyHistoryItem(selected) })
  }
  if (targets.length > 32) throw new ArticleResearchHold('entity_resolution_uncertain', 'Article novelty exceeds the bounded selected duplicate-target state.')
  return targets
}

/**
 * Provider-aware decision builder. With fallback versions off this is exactly
 * choice(). With them on, a Jev result keeps its validated raw Choice data plus
 * the model; a Hermes fallback result records the validated decision value and
 * why the fallback happened, never fabricated probabilities or confidence.
 */
function decide<T>(
  result: ClassificationResult<T>, question: string, fallbackVersions: boolean, hermesChoice: string, project?: (key: string) => string,
): Decision {
  if (!fallbackVersions) return choice(result, question, project)
  if (!result.fallbackUsed) {
    return { provider: 'jev', ...choice(result, question, project), model: result.actualModel }
  }
  if (!hermesChoice.trim()) throw new ArticleResearchHold('entity_resolution_uncertain', `Hermes fallback ${question} returned no decision value.`)
  return {
    provider: 'hermes', choice: hermesChoice, decisionId: result.decisionId, decisionVersion: result.decisionVersion,
    model: result.actualModel, fallbackReason: result.fallbackReason ?? 'unspecified',
  }
}

function choice<T>(result: ClassificationResult<T>, question: string, project?: (key: string) => string): ArticleChoiceDecision {
  let answer = result.answers?.[question]
  // New relationship questions choose one valid (relationship, origin, item)
  // combination. Marginals retain that distribution in the existing packet
  // fields; the full joint answer remains in the durable classification record.
  if (!answer && ['relationship', 'prior_item'].includes(question)) {
    answer = result.answers?.relationship_target
    project = key => question === 'relationship' ? key.split(':')[0] : key.includes(':') ? key.split(':').slice(2).join(':') : 'none'
  }
  if (!answer || answer.type !== 'choice') throw new Error(`Jev ${question} result lacks its raw Choice distribution`)
  const entries = Object.entries(answer.probabilities)
  if (entries.length === 0 || !Object.prototype.hasOwnProperty.call(answer.probabilities, answer.choice)) {
    throw new Error(`Jev ${question} result has no declared selected Choice key`)
  }
  const total = entries.reduce((sum, [key, probability]) => {
    if (!key.trim() || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new Error(`Jev ${question} result has an invalid raw probability`)
    }
    return sum + probability
  }, 0)
  if (Math.abs(total - 1) > 0.02 || !Number.isFinite(answer.confidence)
    || answer.confidence < 0 || answer.confidence > 1) {
    throw new Error(`Jev ${question} result has invalid raw Choice confidence or total`)
  }
  const probabilities: Record<string, number> = {}
  for (const [key, probability] of entries) { const label = project ? project(key) : key; probabilities[label] = (probabilities[label] ?? 0) + probability }
  return {
    choice: project ? project(answer.choice) : answer.choice, probabilities, confidence: answer.confidence,
    decisionId: result.decisionId, decisionVersion: result.decisionVersion,
  }
}

export function articleLookupTerms(signal: Signal, sourceText = ''): string[] {
  const stopWords = new Set(['the','and','for','with','from','into','this','that','are','was','were','has','have','its','their','our','your','you','will','can','could','would','should','which','what','how','why','who','when','where','not','but','all','any','now','new','after','before','about','than','over','under','out','off','one','more','most','they','them','been','said','says','https','http','com','co','to','of','on','in','at','is','as','by','it','an','be','or','we','he','she'])
  const words = (`${signal.title}\n${sourceText}`.match(/[A-Za-z0-9][A-Za-z0-9.'-]{2,}/g) ?? []).filter(word => !stopWords.has(word.toLocaleLowerCase('en-US')))
  const titleWords = signal.title.match(/[A-Za-z0-9][A-Za-z0-9.'-]*/g) ?? []
  const phrases = titleWords.slice(0, 25).flatMap((_, index) => [2, 3].flatMap(size =>
    index + size <= titleWords.length ? [titleWords.slice(index, index + size).join(' ')] : []))
  return [...new Set([...signal.sourceHints.entities, ...signal.sourceHints.assets, ...phrases.slice(0, 24), ...words].map((value) => value.trim()).filter(Boolean))].slice(0, 64)
}

function relatedQuestion(entityId: string): string { return `related_${entityId}` }

function articleDecisionState<T>(label: string, state: T): T {
  let bytes: number
  try { bytes = Buffer.byteLength(JSON.stringify(state), 'utf8') }
  catch { throw new ArticleResearchHold('decision_state_too_large', `Article ${label} state cannot be serialized within its bounded Jev request.`) }
  if (bytes > ARTICLE_DECISION_STATE_MAX_BYTES) {
    throw new ArticleResearchHold('decision_state_too_large', `Article ${label} state is ${bytes} bytes; the configured Jev request limit is ${ARTICLE_DECISION_STATE_MAX_BYTES} bytes.`)
  }
  return state
}

function decisionCandidates(candidates: ArticleResearchContext['candidates']): ArticleResearchContext['candidates'] {
  return candidates.map((candidate) => {
    const { decisionSummary, ...profile } = candidate
    return { ...profile, summary: decisionSummary ?? articleCandidateDecisionSummary(candidate.summary) }
  })
}

function assertContextCoverage(context: ArticleResearchContext): void {
  if (context.coverageFailures.length > 0) {
    throw new ArticleResearchHold(
      context.coverageFailureKind === 'transient' ? 'context_coverage_transient' : 'context_coverage_unavailable',
      `Article placement is held because catalogue/history coverage failed: ${context.coverageFailures.join('; ')}`,
    )
  }
}

function relationshipHistoryItem(item: { id: string, source: 'legacy' | 'managed', title: string, summary: string, eventAt: string }) {
  // Legacy records can use their full summary as a title. Bound only the
  // decision's title field; preserve the stored item and full writing context.
  return { ...item, title: articleHistoryDecisionTitle(item.title) }
}

function noveltyHistoryItem(item: { id: string, source: 'legacy' | 'managed', title: string, summary: string, eventAt: string }) {
  return { ...item, title: articleHistoryDecisionTitle(item.title), summary: excerpt(item.summary, 500) }
}

function excerpt(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 14))} [excerpted]`
}
