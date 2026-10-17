import { Buffer } from 'node:buffer'
import type {
  ArticleChoiceDecision, ArticleDecisionV2, ArticleEntityCreationProposal, ArticleEntityProposal, ArticleV2EntityProposal, Signal,
} from '../signal-platform/contracts'
import type { ClassificationGateway, ClassificationResult, JevAnswer } from '../inference-gateway'
import {
  ARTICLE_CATALOGUE_BATCH_HERMES_FALLBACK_VERSION,
  ARTICLE_CATALOGUE_BATCH_MAX_CANDIDATES,
  ARTICLE_CATALOGUE_BATCH_VERSION,
  ARTICLE_CATALOGUE_BATCH_WORKLOAD,
  ARTICLE_ENTITY_PLACEMENT_VERSION,
  ARTICLE_ENTITY_PLACEMENT_HERMES_FALLBACK_VERSION,
  ARTICLE_ENTITY_PLACEMENT_WORKLOAD,
  ARTICLE_ENTITY_PROPOSAL_VALIDATION_VERSION,
  ARTICLE_ENTITY_PROPOSAL_VALIDATION_HERMES_FALLBACK_VERSION,
  ARTICLE_ENTITY_PROPOSAL_VALIDATION_WORKLOAD,
  ARTICLE_RELATIONSHIP_BATCH_HERMES_FALLBACK_VERSION,
  ARTICLE_RELATIONSHIP_BATCH_MAX_ENTITIES,
  ARTICLE_RELATIONSHIP_BATCH_VERSION,
  ARTICLE_RELATIONSHIP_BATCH_WORKLOAD,
  ARTICLE_RELATED_MEMBERSHIP_VERSION,
  ARTICLE_RELATED_MEMBERSHIP_HERMES_FALLBACK_VERSION,
  ARTICLE_RELATED_MEMBERSHIP_WORKLOAD,
  ARTICLE_NOVELTY_VERSION,
  ARTICLE_NOVELTY_HERMES_FALLBACK_VERSION,
  ARTICLE_NOVELTY_WORKLOAD,
  ARTICLE_STORY_RELATIONSHIP_VERSION,
  ARTICLE_STORY_RELATIONSHIP_HERMES_FALLBACK_VERSION,
  ARTICLE_STORY_RELATIONSHIP_WORKLOAD,
  type ArticleCatalogueBatchDecision,
  type ArticleEntityPlacementDecision,
  type ArticleEntityProposalValidationDecision,
  type ArticleRelatedMembershipDecision,
  type ArticleNoveltyDecision,
  type ArticleRelationshipBatchDecision,
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

/** Certain-grade Jev confidence floors for article placement outcomes. */
export interface ArticlePlacementConfidenceFloors {
  primaryPlacement: number
  priorItemLink: number
}

/** Environment variable overriding the primary-placement floor. */
export const ARTICLE_PLACEMENT_PRIMARY_FLOOR_ENV = 'ARTICLE_PLACEMENT_PRIMARY_FLOOR'
/** Environment variable overriding the prior-item link floor. */
export const ARTICLE_PLACEMENT_LINK_FLOOR_ENV = 'ARTICLE_PLACEMENT_LINK_FLOOR'

/**
 * A Jev decision below a floor holds the article as uncertain instead of
 * saving it as certain. Each floor defaults to this value, is overridden by
 * its ARTICLE_PLACEMENT_PRIMARY_FLOOR or ARTICLE_PLACEMENT_LINK_FLOOR
 * environment variable, then by the per-call input. A decision without a
 * numeric confidence score — for example a Hermes fallback decision — counts
 * as below the floor and holds the article as uncertain.
 */
export const ARTICLE_PLACEMENT_CONFIDENCE_FLOORS: Readonly<ArticlePlacementConfidenceFloors> = Object.freeze({ primaryPlacement: 0.6, priorItemLink: 0.5 })

/**
 * Read the placement floors from the environment: ARTICLE_PLACEMENT_PRIMARY_FLOOR
 * for the primary placement and ARTICLE_PLACEMENT_LINK_FLOOR for the prior-item
 * link. An unset or blank variable keeps its default; every other value must be
 * a plain finite decimal number in [0, 1] or this throws.
 */
export function parseArticlePlacementConfidenceFloors(env: Readonly<Record<string, string | undefined>> = process.env): ArticlePlacementConfidenceFloors {
  const parse = (name: string, fallback: number): number => {
    const raw = env[name]
    if (raw === undefined) return fallback
    const value = raw.trim()
    if (value === '') return fallback
    if (!/^\d+(\.\d+)?$|^\.\d+$/.test(value) || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1) {
      throw new Error(`Invalid ${name}=${JSON.stringify(raw)}: expected a number between 0 and 1.`)
    }
    return Number(value)
  }
  return {
    primaryPlacement: parse(ARTICLE_PLACEMENT_PRIMARY_FLOOR_ENV, ARTICLE_PLACEMENT_CONFIDENCE_FLOORS.primaryPlacement),
    priorItemLink: parse(ARTICLE_PLACEMENT_LINK_FLOOR_ENV, ARTICLE_PLACEMENT_CONFIDENCE_FLOORS.priorItemLink),
  }
}

/** Merge the input's optional floors over the environment-configured floors; every provided value must be a finite number in [0, 1]. */
function confidenceFloors(input: ArticlePlacementInput): ArticlePlacementConfidenceFloors {
  const provided = input.confidenceFloors
  if (!provided || (provided.primaryPlacement === undefined && provided.priorItemLink === undefined)) {
    return parseArticlePlacementConfidenceFloors()
  }
  const envFloors = parseArticlePlacementConfidenceFloors()
  const merged: ArticlePlacementConfidenceFloors = {
    primaryPlacement: provided.primaryPlacement ?? envFloors.primaryPlacement,
    priorItemLink: provided.priorItemLink ?? envFloors.priorItemLink,
  }
  for (const [key, value] of Object.entries(merged)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`Invalid confidence floor ${key} ${String(value)}: a floor must be a finite number in [0, 1].`)
    }
  }
  return merged
}

/**
 * A Jev decision below the floor holds the article instead of saving a certain
 * outcome; a decision without a numeric confidence score — for example a Hermes
 * fallback decision — counts as below the floor and also holds.
 */
function assertConfidenceFloor(decision: Decision, floor: number, what: string): void {
  const confidence = 'confidence' in decision && typeof decision.confidence === 'number' ? decision.confidence : null
  if (confidence === null) {
    throw new ArticleResearchHold('entity_resolution_uncertain', `${what} has no confidence score (provider ${'provider' in decision ? decision.provider : 'unknown'}); it counts as below the ${floor} floor and the article is held as uncertain.`)
  }
  if (confidence < floor) {
    throw new ArticleResearchHold('entity_resolution_uncertain', `${what} confidence ${confidence} is below the ${floor} floor; the article is held as uncertain instead of saved as certain.`)
  }
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
  /**
   * Opt-in staged batching (#308 patch 5A): the catalogue stage answers
   * placement plus every related membership in one dispatch, and the
   * relationship stage answers all selected entities in one dispatch.
   * Novelty stays its own later call. Off by default the legacy per-question
   * dispatch sequence runs byte-identically.
   */
  useBatching?: boolean
  /**
   * Overrides merged over the ARTICLE_PLACEMENT_PRIMARY_FLOOR and
   * ARTICLE_PLACEMENT_LINK_FLOOR environment values (the defaults apply when
   * unset). A Jev decision below a floor holds the article as uncertain
   * instead of saving it as certain; a decision without a numeric confidence
   * score — for example a Hermes fallback decision — also holds.
   */
  confidenceFloors?: Partial<ArticlePlacementConfidenceFloors>
}

export async function prepareArticlePlacement(input: ArticlePlacementInput & { useHermesFallbackVersions?: false, useBatching?: false }): Promise<ArticlePlacementPreparationV1>
export async function prepareArticlePlacement(input: ArticlePlacementInput & { useHermesFallbackVersions: true } & { useBatching?: boolean }): Promise<ArticlePlacementPreparationV2>
export async function prepareArticlePlacement(input: ArticlePlacementInput & { useBatching: true }): Promise<ArticlePlacementPreparationV1 | ArticlePlacementPreparationV2>
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
  if (input.useBatching === true) return prepareBatchedArticlePlacement(input)
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
  // The primary placement decision is computed once and floored before any
  // related-membership classify call happens; the no-match/creation path above
  // is not floored. Floors resolve once per prepare call — environment-backed
  // unless the input overrides them — and are shared by every membership below.
  const primaryPlacement = decision(placement, 'placement', placement.value.entityId ?? placement.value.disposition)
  const floors = confidenceFloors(input)
  assertConfidenceFloor(primaryPlacement, floors.primaryPlacement, 'Primary placement')
  const relatedCandidates = candidates.filter((candidate) => candidate.id !== entity.id)
  const related = relatedCandidates.length === 0 ? null : await input.gateway.classify<ArticleRelatedMembershipDecision>({
    workload: ARTICLE_RELATED_MEMBERSHIP_WORKLOAD,
    decisionVersion: version(ARTICLE_RELATED_MEMBERSHIP_VERSION, ARTICLE_RELATED_MEMBERSHIP_HERMES_FALLBACK_VERSION),
    state: articleDecisionState('related memberships', { article: { title: input.signal.title, text: input.sourceText }, primary: { id: entity.id, name: entity.name }, candidates: decisionCandidates(relatedCandidates) }),
    trace: { stableDecisionKey: `${input.stableDecisionKey}:related-memberships`, correlationIds: { signalId: input.signal.signalId, entityId: entity.id } },
  })
  const memberships: Membership[] = []
  // A related candidate must additionally be mentioned in the article (title
  // plus captured text); an unmentioned candidate is rejected regardless of
  // its disposition and never holds the article.
  const articleText = `${input.signal.title}\n${input.sourceText}`
  // An uncertain related-membership judgment from Hermes (fallback versions)
  // is a hold, never a silently omitted membership. Jev's uncertain answers
  // are validated choices that the flag-off route keeps omitting unchanged.
  if (fallbackVersions && related?.value.dispositions) {
    const uncertainId = Object.entries(related.value.dispositions)
      .find(([candidateId, outcome]) => outcome === 'uncertain'
        && relatedCandidates.some((candidate) => candidate.id === candidateId && articleMentionsEntity(articleText, candidate)))?.[0]
    if (uncertainId) {
      throw new ArticleResearchHold('entity_resolution_uncertain', `Related membership for ${uncertainId} is uncertain; membership is held instead of omitted.`)
    }
  }
  // Related candidates Jev selected but the article never mentions are
  // rejected before they join the memberships; their ids surface in one
  // placement log line after the membership loop.
  const rejectedRelatedIds = relatedCandidates
    .filter((candidate) => related?.value.dispositions[candidate.id] === 'related'
      && !articleMentionsEntity(articleText, candidate))
    .map((candidate) => candidate.id)
  for (const candidate of relatedCandidates) {
    if (related?.value.dispositions[candidate.id] !== 'related') continue
    if (!articleMentionsEntity(articleText, candidate)) continue
    memberships.push(await membership(input, candidate, 'related', related !== null && related.fallbackUsed
      ? decision(related, relatedQuestion(candidate.id), 'related')
      : decision(related, relatedQuestion(candidate.id), related.value.dispositions[candidate.id] ?? 'uncertain'), floors))
  }
  logRelatedMentionRejections('single', input, rejectedRelatedIds)
  memberships.unshift(await membership(input, entity, 'primary', primaryPlacement, floors))
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
  floors: ArticlePlacementConfidenceFloors,
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
  // The validators demote a Hermes duplicate to this uncertain value; novelty
  // must never save the suppressed duplicate as new information over it. When
  // the final relationship decision came from Hermes — an explicit fallback
  // result, or a result with no raw Jev answer for the question — placement
  // holds before novelty/synthesis instead of accepting the uncertain
  // relationship. Jev keeps its validated uncertain choices unchanged.
  if (input.useHermesFallbackVersions === true && relationship.value.relationship === 'uncertain'
    && (relationship.fallbackUsed || rawJevAnswer(relationship, 'relationship') === undefined)) {
    throw new ArticleResearchHold('entity_resolution_uncertain', `Hermes story relationship for ${entity.id} is uncertain; the article is held instead of saving a default.`)
  }
  const fallback = input.useHermesFallbackVersions === true
  const relationshipDecision = decide(relationship, 'relationship', fallback, relationship.value.relationship)
  const priorItemDecision = decide(relationship, 'prior_item', fallback, relationship.value.priorItemId ?? 'none')
  return membershipFromRelationship(input, entity, role, placement, relationship, relationshipHistory, { relationshipDecision, priorItemDecision }, floors)
}

/**
 * Shared relationship-tail for the legacy and batched routes: the same
 * duplicate/continuation target holds, the same membership record, computed
 * from one resolved relationship result and its authoritative history.
 */
function membershipFromRelationship(
  input: ArticlePlacementInput,
  entity: ArticleResearchContext['candidates'][number],
  role: 'primary' | 'related',
  placement: Decision,
  relationship: ClassificationResult<ArticleStoryRelationshipDecision>,
  relationshipHistory: ReadonlyArray<{ id: string, source: 'legacy' | 'managed', title: string, summary: string, eventAt: string }>,
  decisions: { relationshipDecision: Decision, priorItemDecision: Decision },
  floors: ArticlePlacementConfidenceFloors,
): Membership {
  // A membership that links to a prior item is a certain-grade link: below the
  // prior-item floor it holds instead of saving the link, and a decision
  // without a numeric confidence score counts as below the floor, so a Hermes
  // fallback link is held as uncertain too.
  if (['duplicate', 'direct_continuation', 'related_story_branch'].includes(relationship.value.relationship)) {
    assertConfidenceFloor(decisions.relationshipDecision, floors.priorItemLink, 'Prior-item relationship')
    assertConfidenceFloor(decisions.priorItemDecision, floors.priorItemLink, 'Prior-item link')
  }
  const prior = relationship.value.priorItemId === null ? null : relationshipHistory.find((item) => item.id === relationship.value.priorItemId
    && (!relationship.value.priorItemSource || item.source === relationship.value.priorItemSource)) ?? null
  if (relationship.value.relationship === 'duplicate' && !prior) {
    throw new ArticleResearchHold('entity_resolution_uncertain', 'A story relationship marked a duplicate without a valid durable historical target.')
  }
  if ((relationship.value.relationship === 'direct_continuation' || relationship.value.relationship === 'related_story_branch') && !prior) {
    throw new ArticleResearchHold('entity_resolution_uncertain', 'A relationship selected a continuation or story branch without a valid durable historical target.')
  }
  return {
    entityId: entity.id, placementDisposition: 'selected', role, name: entity.name, type: null, aliases: [...entity.aliases], summary: entity.summary,
    scope: { ...entity.scope }, creationProposal: null, creationDecision: null, placement,
    relationship: relationship.value.relationship, relationshipDecision: decisions.relationshipDecision,
    priorItemDecision: decisions.priorItemDecision,
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
 * the model; a Hermes result records the validated decision value and why the
 * dispatch ran on Hermes, never fabricated probabilities or confidence.
 *
 * Provenance follows the dispatch's actual data, not the fallback flag alone:
 * a disabled Jev lifecycle dispatches Hermes directly with fallbackUsed: false
 * and no raw Choice answers, so a result without its Jev distribution for the
 * question — or an explicitly Hermes fallback result — encodes a valid Hermes
 * v2 decision instead of failing the Jev branch.
 */
function decide<T>(
  result: ClassificationResult<T>, question: string, fallbackVersions: boolean, hermesChoice: string, project?: (key: string) => string,
): Decision {
  if (!fallbackVersions) return choice(result, question, project)
  const rawJev = rawJevAnswer(result, question)
  if (!result.fallbackUsed && rawJev) {
    return { provider: 'jev', ...choice(result, question, project), model: result.actualModel }
  }
  if (!hermesChoice.trim()) throw new ArticleResearchHold('entity_resolution_uncertain', `Hermes fallback ${question} returned no decision value.`)
  return {
    provider: 'hermes', choice: hermesChoice, decisionId: result.decisionId, decisionVersion: result.decisionVersion,
    model: result.actualModel, fallbackReason: result.fallbackReason ?? (result.fallbackUsed ? 'unspecified' : 'jev_disabled'),
  }
}

/** The raw Jev Choice answer `choice()` consumes, or undefined when the result carries no Jev answer for the question. */
function rawJevAnswer<T>(result: ClassificationResult<T>, question: string): JevAnswer | undefined {
  const answer = result.answers?.[question]
  if (answer) return answer
  if (['relationship', 'prior_item'].includes(question)) return result.answers?.relationship_target
  return undefined
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

/**
 * Normalised mention form: accent-stripped, casefolded, with every run of
 * non-letters/digits collapsed to a single space.
 */
export function normaliseMentionText(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}+/gu, '').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/**
 * Whether the article text mentions the entity by name or any alias as a
 * standalone normalised token. Gates related memberships only; the primary
 * placement entity is never mention-filtered.
 */
export function articleMentionsEntity(articleText: string, entity: { name: string, aliases: readonly string[] }): boolean {
  const haystack = ` ${normaliseMentionText(articleText)} `
  for (const term of [entity.name, ...entity.aliases]) {
    const normalised = normaliseMentionText(term)
    if (normalised !== '' && haystack.includes(` ${normalised} `)) return true
  }
  return false
}

function relatedQuestion(entityId: string): string { return `related_${entityId}` }

/**
 * Staged batching (#308 patch 5A). The candidate catalogue is kept whole: the
 * full article dispatches once per stage instead of once per question. Stage 1
 * answers primary placement plus every independent related membership in one
 * batched catalogue call; stage 2 answers the joint relationship/origin/target
 * question for all selected entities in one call. The older targeted duplicate
 * lookup stays a separate bounded call that runs only when an entity needs it,
 * and novelty remains its own later dispatch after duplicate targets are known.
 * Off the flag none of this runs.
 */
type RelationshipHistoryItem = { id: string, source: 'legacy' | 'managed', title: string, summary: string, eventAt: string }

function batchedStateBytes(state: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(state), 'utf8') }
  catch { return Number.POSITIVE_INFINITY }
}

/**
 * Rank, then sort by candidate id: batch membership is deterministic and
 * every ranked candidate survives a split, never a truncation.
 */
function batchedRankedCandidates(
  input: ArticlePlacementInput,
  extraCandidates: ArticleResearchContext['candidates'] = [],
  lookupTerms: readonly string[] = articleLookupTerms(input.signal),
): ArticleResearchContext['candidates'] {
  return [...rankEntityCandidates([...input.context.candidates, ...extraCandidates], lookupTerms)]
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** Split the whole catalogue into bounded batched states; nothing is dropped. */
function batchedCatalogueBatches(
  input: ArticlePlacementInput,
  extraCandidates: ArticleResearchContext['candidates'] = [],
  lookupTerms: readonly string[] = articleLookupTerms(input.signal),
): Array<{ candidates: ArticleResearchContext['candidates'], state: unknown }> {
  const catalogueState = (candidates: ArticleResearchContext['candidates']) =>
    ({ article: { title: input.signal.title, text: input.sourceText }, candidates: decisionCandidates(candidates) })
  const batches: Array<{ candidates: ArticleResearchContext['candidates'], state: unknown }> = []
  let current: ArticleResearchContext['candidates'] = []
  for (const candidate of batchedRankedCandidates(input, extraCandidates, lookupTerms)) {
    const next = [...current, candidate]
    const oversize = current.length > 0
      && batchedStateBytes(catalogueState(next)) > ARTICLE_DECISION_STATE_MAX_BYTES
    if (next.length > ARTICLE_CATALOGUE_BATCH_MAX_CANDIDATES || oversize) {
      batches.push({ candidates: current, state: catalogueState(current) })
      current = [candidate]
    } else {
      current = next
    }
  }
  // An empty catalogue still dispatches one empty batch so the placement
  // question is answered exactly like the unbatched route.
  batches.push({ candidates: current, state: catalogueState(current) })
  return batches
}

type BatchedCatalogueStage = {
  selected: string | null
  uncertain: boolean
  orderedCandidates: ArticleResearchContext['candidates']
  dispositionByCandidate: Map<string, {
    outcome: 'related' | 'not_related' | 'uncertain'
    result: ClassificationResult<ArticleCatalogueBatchDecision>
  }>
  firstResult: ClassificationResult<ArticleCatalogueBatchDecision>
}

/** Stage 1: every candidate answers the placement and its own membership question. */
async function batchedCatalogueStage(
  input: ArticlePlacementInput,
  extraCandidates: ArticleResearchContext['candidates'] = [],
  lookupTerms: readonly string[] = articleLookupTerms(input.signal),
): Promise<BatchedCatalogueStage> {
  const fallbackVersions = input.useHermesFallbackVersions === true
  const batches = batchedCatalogueBatches(input, extraCandidates, lookupTerms)
  const batchPlacements: Array<{ selectedId: string | null, uncertain: boolean }> = []
  let uncertain = false
  const orderedCandidates: ArticleResearchContext['candidates'] = []
  const dispositionByCandidate: BatchedCatalogueStage['dispositionByCandidate'] = new Map()
  let firstResult: ClassificationResult<ArticleCatalogueBatchDecision> | null = null
  for (const [index, batch] of batches.entries()) {
    const result = await input.gateway.classify<ArticleCatalogueBatchDecision>({
      workload: ARTICLE_CATALOGUE_BATCH_WORKLOAD,
      decisionVersion: fallbackVersions ? ARTICLE_CATALOGUE_BATCH_HERMES_FALLBACK_VERSION : ARTICLE_CATALOGUE_BATCH_VERSION,
      state: articleDecisionState('batched catalogue', batch.state),
      trace: {
        stableDecisionKey: batches.length > 1
          ? `${input.stableDecisionKey}:catalogue-batch:${index}`
          : `${input.stableDecisionKey}:catalogue`,
        correlationIds: { signalId: input.signal.signalId },
      },
    })
    if (firstResult === null) firstResult = result
    orderedCandidates.push(...batch.candidates)
    for (const candidate of batch.candidates) {
      const outcome = result.value.dispositions[candidate.id]
      if (outcome) dispositionByCandidate.set(candidate.id, { outcome, result })
    }
    batchPlacements.push({
      selectedId: result.value.disposition === 'selected' && result.value.entityId ? result.value.entityId : null,
      uncertain: result.value.disposition === 'uncertain',
    })
    if (result.value.disposition === 'uncertain') uncertain = true
  }
  // A split catalogue answers placement once per batch; the primary is chosen
  // only from the pooled placements. Batches that disagree on the selected
  // entity, or a selection made while another batch could not resolve its own
  // placement, are a hold — never a first-selected-batch win.
  const selectedIds = [...new Set(batchPlacements.map((item) => item.selectedId).filter((id): id is string => id !== null))]
  if (selectedIds.length > 1) {
    throw new ArticleResearchHold('entity_resolution_uncertain', `The batched catalogue selected conflicting primaries (${selectedIds.sort().join(', ')}) across batches; entity resolution is held instead of choosing one.`)
  }
  if (selectedIds.length === 1 && batchPlacements.some((item) => item.uncertain)) {
    throw new ArticleResearchHold('entity_resolution_uncertain', 'The batched catalogue selected a primary while another batch was uncertain; entity resolution is held instead of choosing one.')
  }
  return { selected: selectedIds[0] ?? null, uncertain, orderedCandidates, dispositionByCandidate, firstResult: firstResult! }
}

/** Stage 2: joint relationship/target dispatches over the selected entities. */
async function batchedRelationshipStages(
  input: ArticlePlacementInput,
  selected: ReadonlyArray<{ id: string, name: string }>,
  historyById: ReadonlyMap<string, RelationshipHistoryItem[]>,
): Promise<Array<{ entities: ReadonlyArray<{ id: string, name: string }>, result: ClassificationResult<ArticleRelationshipBatchDecision> }>> {
  const fallbackVersions = input.useHermesFallbackVersions === true
  const relationshipState = (entities: ReadonlyArray<{ id: string, name: string }>) => ({
    article: { title: input.signal.title, sourceText: input.sourceText, publishedAt: input.signal.publishedAt, observedAt: input.signal.observedAt },
    entities: entities.map((entity) => ({
      id: entity.id, name: entity.name,
      recentItems: (historyById.get(entity.id) ?? []).map(relationshipHistoryItem),
    })),
  })
  const ordered = [...selected].sort((a, b) => a.id.localeCompare(b.id))
  const chunks: Array<Array<{ id: string, name: string }>> = []
  let current: Array<{ id: string, name: string }> = []
  for (const entity of ordered) {
    const next = [...current, entity]
    if (next.length > ARTICLE_RELATIONSHIP_BATCH_MAX_ENTITIES
      || (current.length > 0 && batchedStateBytes(relationshipState(next)) > ARTICLE_DECISION_STATE_MAX_BYTES)) {
      chunks.push(current)
      current = [entity]
    } else {
      current = next
    }
  }
  if (current.length > 0 || chunks.length === 0) chunks.push(current)
  const stages: Array<{ entities: ReadonlyArray<{ id: string, name: string }>, result: ClassificationResult<ArticleRelationshipBatchDecision> }> = []
  for (const [index, chunk] of chunks.entries()) {
    const result = await input.gateway.classify<ArticleRelationshipBatchDecision>({
      workload: ARTICLE_RELATIONSHIP_BATCH_WORKLOAD,
      decisionVersion: fallbackVersions ? ARTICLE_RELATIONSHIP_BATCH_HERMES_FALLBACK_VERSION : ARTICLE_RELATIONSHIP_BATCH_VERSION,
      state: articleDecisionState('batched relationships', relationshipState(chunk)),
      trace: {
        stableDecisionKey: chunks.length > 1
          ? `${input.stableDecisionKey}:relationships:${index}`
          : `${input.stableDecisionKey}:relationships`,
        correlationIds: { signalId: input.signal.signalId },
      },
    })
    stages.push({ entities: chunk, result })
  }
  return stages
}

async function prepareBatchedArticlePlacement(
  input: ArticlePlacementInput,
): Promise<ArticlePlacementPreparationV1 | ArticlePlacementPreparationV2> {
  let stage = await batchedCatalogueStage(input)
  // One expanded catalogue pass after an unresolved placement, exactly like
  // the unbatched route; an unchanged merged catalogue is not re-dispatched.
  if (!stage.selected && input.context.widenCandidates) {
    const widened = await input.context.widenCandidates(articleLookupTerms(input.signal, input.sourceText))
    assertContextCoverage(input.context)
    const merged = batchedRankedCandidates(input, widened)
    const changed = merged.length !== stage.orderedCandidates.length
      || merged.some((candidate, index) => candidate.id !== stage.orderedCandidates[index]?.id)
    if (changed) stage = await batchedCatalogueStage(input, widened)
  }
  if (stage.selected) return batchedSelectedPreparation(input, stage)
  if (stage.uncertain) {
    throw new ArticleResearchHold('entity_resolution_uncertain', 'Placement could not safely resolve article placement after bounded catalogue retrieval.')
  }
  return batchedCreationFallback(input, stage)
}

async function batchedSelectedPreparation(
  input: ArticlePlacementInput, stage: BatchedCatalogueStage,
): Promise<ArticlePlacementPreparationV1 | ArticlePlacementPreparationV2> {
  const fallbackVersions = input.useHermesFallbackVersions === true
  const primary = stage.orderedCandidates.find((candidate) => candidate.id === stage.selected)
  if (!primary) throw new Error('Batched placement selected an entity outside the bounded candidate catalogue')
  // The primary placement decision is computed once and floored before any
  // history load or relationship dispatch; the membership loop reuses it.
  const observedPrimary = stage.dispositionByCandidate.get(primary.id)
  if (!observedPrimary) throw new ArticleResearchHold('entity_resolution_uncertain', `The batched catalogue answered no membership for ${primary.id}.`)
  const primaryPlacementDecision = decide(observedPrimary.result, 'placement', fallbackVersions, primary.id)
  // Floors resolve once per prepare call — environment-backed unless the input
  // overrides them — and are shared by every membership below.
  const floors = confidenceFloors(input)
  assertConfidenceFloor(primaryPlacementDecision, floors.primaryPlacement, 'Primary placement')
  const placementDecision = (candidate: ArticleResearchContext['candidates'][number]): Decision => {
    if (candidate.id === primary.id) return primaryPlacementDecision
    const observed = stage.dispositionByCandidate.get(candidate.id)
    if (!observed) throw new ArticleResearchHold('entity_resolution_uncertain', `The batched catalogue answered no membership for ${candidate.id}.`)
    return observed.result.fallbackUsed
      ? decide(observed.result, relatedQuestion(candidate.id), fallbackVersions, 'related')
      : decide(observed.result, relatedQuestion(candidate.id), fallbackVersions, observed.outcome)
  }
  // The article text a related membership must mention (title plus captured
  // text); an unmentioned candidate is rejected regardless of its disposition.
  const articleText = `${input.signal.title}\n${input.sourceText}`
  // Membership questions judge candidates independently of the primary; the
  // primary is excluded from related-membership consideration code-side. With
  // Hermes fallback versions an uncertain membership judgment is a hold,
  // never a silently omitted membership; Jev's validated uncertain choices
  // keep the flag-off behaviour of omitting the membership.
  if (fallbackVersions) {
    const uncertainMemberships = stage.orderedCandidates.filter((candidate) => candidate.id !== primary.id
      && stage.dispositionByCandidate.get(candidate.id)?.outcome === 'uncertain'
      && articleMentionsEntity(articleText, candidate))
    if (uncertainMemberships.length > 0) {
      throw new ArticleResearchHold('entity_resolution_uncertain', `Batched related membership for ${uncertainMemberships.map((candidate) => candidate.id).join(', ')} is uncertain; membership is held instead of omitted.`)
    }
  }
  // Related candidates the batch marked related but the article never
  // mentions are rejected before they join the selected entities; their ids
  // surface in one placement log line.
  const rejectedRelatedIds = stage.orderedCandidates
    .filter((candidate) => candidate.id !== primary.id
      && stage.dispositionByCandidate.get(candidate.id)?.outcome === 'related'
      && !articleMentionsEntity(articleText, candidate))
    .map((candidate) => candidate.id)
  const selected = [primary, ...stage.orderedCandidates.filter((candidate) => candidate.id !== primary.id
    && stage.dispositionByCandidate.get(candidate.id)?.outcome === 'related'
    && articleMentionsEntity(articleText, candidate))]
  logRelatedMentionRejections('batched', input, rejectedRelatedIds)
  // The latest-five history for every selected entity is loaded once and stays
  // in the shared context for the novelty stage and the writing handoff.
  const historyById = new Map<string, RelationshipHistoryItem[]>()
  for (const entity of selected) {
    const allHistory = input.context.loadHistory
      ? await input.context.loadHistory(entity.id)
      : input.context.historyByEntity.get(entity.id) ?? []
    input.context.historyByEntity.set(entity.id, allHistory)
    historyById.set(entity.id, allHistory.slice(0, 5))
  }
  assertContextCoverage(input.context)
  const stages = await batchedRelationshipStages(input, selected.map((candidate) => ({ id: candidate.id, name: candidate.name })), historyById)
  const memberships: Membership[] = []
  for (const entity of selected) {
    const owned = stages.find((item) => item.entities.some((member) => member.id === entity.id))
    const target = owned?.result.value.targets.find((item) => item.entityId === entity.id)
    if (!owned || !target) {
      throw new ArticleResearchHold('entity_resolution_uncertain', `The batched relationship stage returned no judgment for ${entity.id}.`)
    }
    memberships.push(await batchedMembership(
      input, entity, entity.id === primary.id ? 'primary' : 'related',
      placementDecision(entity), target, owned.result, historyById, floors,
    ))
  }
  return <ArticlePlacementPreparationV1 | ArticlePlacementPreparationV2>{
    memberships,
    novelty: await novelty(input, memberships.map((membership) => membership.entityId).filter((id): id is string => id !== null), memberships),
    contextualHistory: contextualHistoryFor(input, memberships),
  }
}

/** One membership from the batched catalogue plus relationship stage results. */
async function batchedMembership(
  input: ArticlePlacementInput,
  entity: ArticleResearchContext['candidates'][number],
  role: 'primary' | 'related',
  placement: Decision,
  target: ArticleRelationshipBatchDecision['targets'][number],
  stage: ClassificationResult<ArticleRelationshipBatchDecision>,
  historyById: ReadonlyMap<string, RelationshipHistoryItem[]>,
  floors: ArticlePlacementConfidenceFloors,
): Promise<Membership> {
  const fallbackVersions = input.useHermesFallbackVersions === true
  let relationship: ClassificationResult<ArticleStoryRelationshipDecision> = {
    ...stage,
    value: { relationship: target.relationship, priorItemId: target.priorItemId, priorItemSource: target.priorItemSource ?? null },
  }
  let relationshipHistory: RelationshipHistoryItem[] = historyById.get(entity.id) ?? []
  // A target-relationship must resolve inside this entity's own history
  // before any marginal is computed; a tampered durable result naming an
  // unknown item holds instead of building a membership from it.
  const targetPreview = ['duplicate', 'direct_continuation', 'related_story_branch'].includes(target.relationship)
    ? relationshipHistory.find((item) => item.id === target.priorItemId
      && (!target.priorItemSource || item.source === target.priorItemSource)) ?? null
    : null
  if (target.relationship === 'duplicate' && !targetPreview) {
    throw new ArticleResearchHold('entity_resolution_uncertain', 'A story relationship marked a duplicate without a valid durable historical target.')
  }
  if ((target.relationship === 'direct_continuation' || target.relationship === 'related_story_branch') && !targetPreview) {
    throw new ArticleResearchHold('entity_resolution_uncertain', 'A relationship selected a continuation or story branch without a valid durable historical target.')
  }
  let fromOlderLookup = false
  // The latest five are narrative context only. A separate, bounded older
  // lookup is consulted exclusively to find a duplicate target; it never
  // redefines a branch/continuation relationship from the latest context.
  if (relationship.value.relationship !== 'duplicate' && input.context.lookupOlderDuplicate) {
    const older = await input.context.lookupOlderDuplicate(entity.id)
    assertContextCoverage(input.context)
    if (older.length > 0) {
      const targeted = await input.gateway.classify<ArticleStoryRelationshipDecision>({
        workload: ARTICLE_STORY_RELATIONSHIP_WORKLOAD,
        decisionVersion: fallbackVersions
          ? ARTICLE_STORY_RELATIONSHIP_HERMES_FALLBACK_VERSION : ARTICLE_STORY_RELATIONSHIP_VERSION,
        state: articleDecisionState('older duplicate relationship', { article: { title: input.signal.title, sourceText: input.sourceText, publishedAt: input.signal.publishedAt, observedAt: input.signal.observedAt }, entity: { id: entity.id, name: entity.name }, recentItems: older.map(relationshipHistoryItem) }),
        trace: { stableDecisionKey: `${input.stableDecisionKey}:older-duplicate:${entity.id}`, correlationIds: { signalId: input.signal.signalId, entityId: entity.id } },
      })
      if (targeted.value.relationship === 'duplicate') {
        relationship = targeted
        relationshipHistory = older
        fromOlderLookup = true
      }
    }
  }
  // Marginals retain the joint distribution in the existing packet fields; the
  // full joint answer remains in the durable classification record.
  // The validators demote a Hermes duplicate to uncertain and drop the target;
  // novelty must never save the suppressed duplicate as new information over
  // it. When the final relationship decision came from Hermes — an explicit
  // fallback result, or a result with no raw Jev answer for the question —
  // placement holds before novelty/synthesis. Jev's validated uncertain
  // choices keep the flag-off behaviour unchanged.
  if (fallbackVersions && relationship.value.relationship === 'uncertain'
    && (relationship.fallbackUsed || rawJevAnswer(relationship, fromOlderLookup ? 'relationship' : `relationship_target_${entity.id}`) === undefined)) {
    throw new ArticleResearchHold('entity_resolution_uncertain', `Hermes story relationship for ${entity.id} is uncertain; the article is held instead of saving a default.`)
  }
  const decisions = fromOlderLookup
    ? {
      relationshipDecision: decide(relationship, 'relationship', fallbackVersions, relationship.value.relationship),
      priorItemDecision: decide(relationship, 'prior_item', fallbackVersions, relationship.value.priorItemId ?? 'none'),
    }
    : {
      relationshipDecision: decide(stage, `relationship_target_${entity.id}`, fallbackVersions, relationship.value.relationship, key => key.split(':')[0]),
      priorItemDecision: decide(stage, `relationship_target_${entity.id}`, fallbackVersions, relationship.value.priorItemId ?? 'none', key => key.includes(':') ? key.split(':').slice(2).join(':') : 'none'),
    }
  return membershipFromRelationship(input, entity, role, placement, relationship, relationshipHistory, decisions, floors)
}

/**
 * One placement log line per route lists the related candidates Jev selected
 * but the article never mentions; the mention rejection itself stays silent.
 */
function logRelatedMentionRejections(route: 'single' | 'batched', input: ArticlePlacementInput, ids: string[]): void {
  if (ids.length === 0) return
  console.info(`[research-engine:placement] ${JSON.stringify({ event: 'related_mention_rejected', route, signalId: input.signal.signalId, rejected: ids.length, entityIds: ids })}`)
}

/** Batched no-match path: exact-identity recovery first, then the proposal validation. */
async function batchedCreationFallback(
  input: ArticlePlacementInput, stage: BatchedCatalogueStage,
): Promise<ArticlePlacementPreparationV1 | ArticlePlacementPreparationV2> {
  const fallbackVersions = input.useHermesFallbackVersions === true
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
      // One exact-identity batched catalogue over the merged candidates. An
      // exact identity the batch still cannot select is a hold, never a
      // duplicate creation.
      const retry = await batchedCatalogueStage(input, exact, [creationProposal.name, ...creationProposal.aliases])
      if (retry.selected) return batchedSelectedPreparation(input, retry)
      throw new ArticleResearchHold('entity_resolution_uncertain', 'An existing exact entity identity was found but placement could not resolve it; the identity will not be duplicated.')
    }
  }
  const creationValidation = await input.gateway.classify<ArticleEntityProposalValidationDecision>({
    workload: ARTICLE_ENTITY_PROPOSAL_VALIDATION_WORKLOAD,
    decisionVersion: fallbackVersions
      ? ARTICLE_ENTITY_PROPOSAL_VALIDATION_HERMES_FALLBACK_VERSION : ARTICLE_ENTITY_PROPOSAL_VALIDATION_VERSION,
    state: articleDecisionState('creation proposal validation', { article: { title: input.signal.title, text: input.sourceText }, proposal: creationProposal }),
    trace: { stableDecisionKey: `${input.stableDecisionKey}:creation-proposal`, correlationIds: { signalId: input.signal.signalId } },
  })
  if (creationValidation.value.disposition === 'uncertain') throw new ArticleResearchHold('entity_resolution_uncertain', 'Placement could not safely validate the source-grounded new-entity proposal.')
  if (creationValidation.value.disposition === 'reject') throw new ArticleResearchHold('entity_resolution_no_match', 'The source-grounded new-entity proposal was rejected; an actionable identity is required.')
  return <ArticlePlacementPreparationV1 | ArticlePlacementPreparationV2>{
    memberships: [{
      entityId: null, placementDisposition: 'no_match', role: 'primary', name: creationProposal.name, type: creationProposal.type, aliases: [...creationProposal.aliases],
      summary: creationProposal.summary, scope: { ...creationProposal.scope }, creationProposal,
      creationDecision: decide(creationValidation, 'proposal', fallbackVersions, creationValidation.value.disposition),
      placement: decide(stage.firstResult, 'placement', fallbackVersions, 'no_match'), relationship: null, relationshipDecision: null, priorItemDecision: null,
      priorItemId: null, priorItemSource: null, duplicateTarget: null,
    }] as Membership[],
    novelty: await novelty(input, [], []),
    contextualHistory: 'No existing entity placement was selected; Entity Manager must assess the bounded creation proposal.',
  }
}

/** Shared writing-context rendering for the legacy and batched routes. */
function contextualHistoryFor(input: ArticlePlacementInput, memberships: Membership[]): string {
  return memberships.map((membership) => {
    const prior = membership.priorItemId ? `linked to ${membership.priorItemSource} item ${membership.priorItemId}` : 'has no selected prior item'
    const history = (input.context.historyByEntity.get(membership.entityId ?? '') ?? []).slice(0, 5)
      .map((item) => `[${item.source}:${item.id}] ${item.eventAt} — ${item.title}: ${item.summary}`).join('\n')
    return `${membership.role} ${membership.name}: ${membership.relationship ?? 'placement unresolved'}; ${prior}.\nRecent connected history:\n${history || '(none)'}`
  }).join('\n')
}


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
