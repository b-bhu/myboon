/**
 * #308 patch 5B source-controlled article placement fixtures.
 *
 * PLUMBING, NOT MODEL ACCURACY: every provider answer this module produces is
 * a fixture value from a mocked classification gateway. The accompanying tests
 * pin request wiring of prepareArticlePlacement — dispatch order, decision
 * versions, durable item ids and dates, and the deterministic judgment flow —
 * they are not evidence that any provider or model classifies articles well.
 */
import type { ArticleResearchContext } from '../research-gate/managed-context-reader'
import { SIGNAL_SCHEMA_VERSION, type Signal } from '../signal-platform/contracts'
import type { ClassificationRequest, ClassificationResult, JevAnswer } from '../inference-gateway/classification-types'
import {
  articleCatalogueBatchDefinition,
  articleNoveltyDefinition,
  articleRelationshipBatchDefinition,
} from '../inference-gateway/classification-definitions'
import { v4ClassificationResult } from './v4-test-fixtures'

/** Fixture observation/publication time for every #308 article capture. */
export const ARTICLE_308_OBSERVED_AT = '2026-10-03T08:00:00.000Z'
/** Fixture durable event time for the supplied prior developments. */
export const ARTICLE_308_PRIOR_AT = '2026-10-01T00:00:00Z'

export interface Article308HistoryItem { id: string, source: 'legacy' | 'managed', title: string, summary: string, eventAt: string }

/** Supplied prior developments with pinned durable ids, origins and dates. */
export const ARTICLE_308_PRIORS: Record<string, Article308HistoryItem> = {
  conflictProposal: { id: 'conflict-1', source: 'managed', title: 'U.S. proposal sent to Iran through Qatar', summary: 'A U.S. proposal for ending the U.S.–Iran conflict was delivered through Qatari mediation.', eventAt: ARTICLE_308_PRIOR_AT },
  iranPosture: { id: 'iran-posture-1', source: 'managed', title: 'Iran rejects talks without sanctions relief', summary: 'An earlier Iranian negotiating posture statement.', eventAt: '2026-09-28T00:00:00Z' },
  usDraft: { id: 'us-draft-1', source: 'managed', title: 'United States drafts a conflict-ending proposal', summary: 'An earlier report on drafting the proposal.', eventAt: '2026-09-29T00:00:00Z' },
  qatarChannel: { id: 'qatar-channel-1', source: 'managed', title: 'Qatar opens a mediation channel', summary: 'An earlier report on the mediation channel.', eventAt: '2026-09-30T00:00:00Z' },
  btcAccumulation: { id: 'btc-1', source: 'managed', title: 'BlackRock begins accumulating Bitcoin', summary: 'BlackRock starts building a Bitcoin position.', eventAt: ARTICLE_308_PRIOR_AT },
  brAllocation: { id: 'br-1', source: 'legacy', title: 'BlackRock announces Bitcoin allocation', summary: 'BlackRock announces a Bitcoin allocation program.', eventAt: ARTICLE_308_PRIOR_AT },
}

export function article308Signal(input: { title: string, signalId?: string, entities?: readonly string[], assets?: readonly string[] }): Signal {
  const slug = input.signalId ?? (input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'article-308')
  return {
    schemaVersion: SIGNAL_SCHEMA_VERSION, signalId: `signal-${slug}`, sourceType: 'news', sourceId: `native-${slug}`,
    contentKind: 'article', content: { schemaVersion: 'myboon.signal_content.article.v1' },
    title: input.title, visibleSummary: input.title, canonicalUrl: `https://example.com/${slug}`,
    observedAt: ARTICLE_308_OBSERVED_AT, publishedAt: ARTICLE_308_OBSERVED_AT,
    provenance: { provider: 'fixture', upstreamSource: 'Attributed fixture', rawPayloadRef: `raw-${slug}` },
    media: { imageUrl: null, attribution: 'Fixture' },
    sourceHints: { entities: [...(input.entities ?? [])], assets: [...(input.assets ?? [])], eventId: null, deadline: null },
    idempotencyKey: `key-${slug}`,
  } as Signal
}

export const ARTICLE_308_IRAN_TITLE = 'Iran reviewing a US proposal delivered through Qatar'
export const ARTICLE_308_IRAN_TEXT = 'Iran says it is reviewing a U.S. proposal delivered through Qatar. The proposal concerns ending the ongoing U.S.–Iran conflict. Qatar conveyed the proposal as mediator.'
export const ARTICLE_308_IRAN_SIGNAL = article308Signal({ title: ARTICLE_308_IRAN_TITLE, signalId: 'article-308-iran', entities: ['United States', 'Iran', 'Qatar'] })

export const ARTICLE_308_CRYPTO_TITLE = 'BlackRock added $1.5 billion in Bitcoin holdings.'
export const ARTICLE_308_CRYPTO_SIGNAL = article308Signal({ title: ARTICLE_308_CRYPTO_TITLE, signalId: 'article-308-blackrock-bitcoin', entities: ['BlackRock'], assets: ['Bitcoin'] })

const ARTICLE_308_IRAN_CANDIDATES: ArticleResearchContext['candidates'] = [
  { id: 'conflict', name: 'U.S.–Iran Conflict', aliases: ['U.S.–Iran war', 'US Iran conflict'], summary: 'Ongoing bilateral U.S.–Iran conflict and diplomacy.', scope: { category: 'bilateral_conflict', domain: 'diplomacy', parties: ['United States', 'Iran'] } },
  { id: 'iran', name: 'Iran', aliases: [], summary: 'Iranian state and government.', scope: { category: 'country' } },
  { id: 'us', name: 'United States', aliases: ['US', 'U.S.'], summary: 'United States government.', scope: { category: 'country' } },
  { id: 'qatar', name: 'Qatar', aliases: [], summary: 'Qatari state and mediation.', scope: { category: 'country', role: 'mediator' } },
]

const ARTICLE_308_CRYPTO_CANDIDATES: ArticleResearchContext['candidates'] = [
  { id: 'bitcoin', name: 'Bitcoin', aliases: ['BTC'], summary: 'Bitcoin network and asset news.', scope: { category: 'asset' } },
  { id: 'blackrock', name: 'BlackRock', aliases: [], summary: 'BlackRock asset management.', scope: { category: 'organization' } },
]

function article308Context(
  input: { candidates: ArticleResearchContext['candidates'], history: Record<string, Article308HistoryItem[]> },
  picks?: readonly string[],
): ArticleResearchContext {
  const candidates = picks ? input.candidates.filter((candidate) => picks.includes(candidate.id)) : [...input.candidates]
  const ids = new Set(candidates.map((candidate) => candidate.id))
  const historyByEntity = new Map<string, Article308HistoryItem[]>()
  for (const [entityId, items] of Object.entries(input.history)) {
    if (ids.has(entityId)) historyByEntity.set(entityId, items.map((item) => ({ ...item })))
  }
  return { candidates, historyByEntity, coverageFailures: [] }
}

/** Iran catalogue: primary conflict plus independent country memberships. */
export function article308IranContext(picks?: readonly string[]): ArticleResearchContext {
  return article308Context({
    candidates: ARTICLE_308_IRAN_CANDIDATES,
    history: {
      conflict: [ARTICLE_308_PRIORS.conflictProposal],
      iran: [ARTICLE_308_PRIORS.iranPosture],
      us: [ARTICLE_308_PRIORS.usDraft],
      qatar: [ARTICLE_308_PRIORS.qatarChannel],
    },
  }, picks)
}

/** Crypto catalogue: Bitcoin and BlackRock with the supplied 2026-10-01 priors. */
export function article308CryptoContext(picks?: readonly string[]): ArticleResearchContext {
  return article308Context({
    candidates: ARTICLE_308_CRYPTO_CANDIDATES,
    history: { bitcoin: [ARTICLE_308_PRIORS.btcAccumulation], blackrock: [ARTICLE_308_PRIORS.brAllocation] },
  }, picks)
}

/** Empty bounded catalogue for missing/ambiguous identity scenarios. */
export function article308EmptyContext(): ArticleResearchContext {
  return { candidates: [], historyByEntity: new Map(), coverageFailures: [] }
}

/** Exact identity used by the no-match recovery scenario. */
export const ARTICLE_308_EXACT_IDENTITY_CANDIDATE = { id: 'raoul-pal', name: 'Raoul Pal', aliases: ['Raoul'], summary: 'Macro commentator.', scope: {} }
export const ARTICLE_308_EXACT_IDENTITY_PROPOSAL = { name: 'Raoul Pal', type: 'person', aliases: ['Raoul'], summary: 'Macro commentator.', scope: {} }
/** Asserts complete name/alias label coverage and returns the exact existing identity. */
export function article308FindExactIdentity(labels: readonly string[]): ArticleResearchContext['candidates'] {
  if (!labels.includes('Raoul Pal') || !labels.includes('Raoul')) throw new Error('exact identity lookup did not receive the complete label set')
  return [{ ...ARTICLE_308_EXACT_IDENTITY_CANDIDATE }]
}

export type Article308PlacementJudgment = { entityId: string | null, disposition: 'selected' | 'no_match' | 'uncertain' }
export type Article308PlacementPlan = Article308PlacementJudgment | ((candidates: ReadonlyArray<{ id: string }>) => Article308PlacementJudgment)

export type Article308RelationshipOutcome = 'duplicate' | 'direct_continuation' | 'related_story_branch' | 'same_topic_only' | 'unrelated' | 'uncertain'

export interface Article308RelationshipJudgment {
  relationship: Article308RelationshipOutcome
  priorItemId?: string | null
  priorItemSource?: 'legacy' | 'managed' | null
  /** Raw durable decision value replayed verbatim; bypasses Jev answer decoding. */
  raw?: unknown
}

export interface Article308Plan {
  /** Catalogue placement plus (batched mode) the primary selection. */
  placement: Article308PlacementPlan
  /** Independent related-membership decisions keyed by candidate id. */
  related?: Record<string, 'related' | 'not_related' | 'uncertain'>
  /** Per-entity relationship decisions keyed by entity id. */
  relationships?: Record<string, Article308RelationshipJudgment>
  /** Novelty verdict for the first novelty dispatch. */
  novelty?: string
  /** Verdict for the bounded duplicate-reconciliation novelty dispatch. */
  noveltyReconcile?: { verdict: string, primaryRelationship?: string }
  /** Creation-proposal validation disposition. */
  proposal?: 'accept' | 'reject' | 'uncertain'
  /** Selects which dispatches resolve as Hermes fallback results. */
  hermes?: (request: ClassificationRequest) => boolean
}

export interface Article308MockGateway {
  recordPolicyOutcome(): void
  classify<Value>(request: ClassificationRequest): Promise<ClassificationResult<Value>>
}

/** Shared rubric answer format: a valid Jev Choice with a declared selected key. */
const jevChoice = (key: string): JevAnswer => ({ type: 'choice', choice: key, confidence: 0.95, probabilities: { [key]: 0.95, alternative: 0.05 } })

const jointChoice = (judgment: Article308RelationshipJudgment): string =>
  judgment.priorItemId ? `${judgment.relationship}:${judgment.priorItemSource}:${judgment.priorItemId}` : judgment.relationship

function resolvePlacementPlan(plan: Article308Plan, candidates: ReadonlyArray<{ id: string }>): Article308PlacementJudgment {
  return typeof plan.placement === 'function' ? plan.placement(candidates) : plan.placement
}

function requireRelationship(plan: Article308Plan, entityId: string): Article308RelationshipJudgment {
  const judgment = plan.relationships?.[entityId]
  if (!judgment) throw new Error(`article-308 fixture plan has no relationship judgment for entity ${entityId}`)
  return judgment
}

function stage(plan: Article308Plan, request: ClassificationRequest): { value: unknown, answers?: Record<string, JevAnswer> } {
  switch (request.workload) {
    case 'research.article_entity_placement': {
      const judgment = resolvePlacementPlan(plan, (request.state as { candidates: Array<{ id: string }> }).candidates)
      const key = judgment.entityId ?? judgment.disposition
      return { value: { entityId: judgment.entityId, disposition: judgment.disposition }, answers: { placement: jevChoice(key) } }
    }
    case 'research.article_related_membership': {
      const candidates = (request.state as { candidates: Array<{ id: string }> }).candidates
      const answers: Record<string, JevAnswer> = {}
      const dispositions: Record<string, 'related' | 'not_related' | 'uncertain'> = {}
      for (const candidate of candidates) {
        const outcome = plan.related?.[candidate.id] ?? 'not_related'
        dispositions[candidate.id] = outcome
        answers[`related_${candidate.id}`] = jevChoice(outcome)
      }
      return { value: { dispositions }, answers }
    }
    case 'research.article_story_relationship': {
      const entityId = (request.state as { entity: { id: string } }).entity.id
      const judgment = requireRelationship(plan, entityId)
      if (judgment.raw !== undefined) return { value: judgment.raw }
      const priorItemId = judgment.priorItemId ?? null
      return {
        value: { relationship: judgment.relationship, priorItemId, priorItemSource: priorItemId ? judgment.priorItemSource ?? null : null },
        answers: { relationship_target: jevChoice(jointChoice(judgment)) },
      }
    }
    case 'research.article_catalogue_batch': {
      const judgment = resolvePlacementPlan(plan, (request.state as { candidates: Array<{ id: string }> }).candidates)
      const validated = articleCatalogueBatchDefinition().validateState(request.state)
      if (!validated.valid) throw new Error(`article-308 fixture batched catalogue state is invalid: ${validated.issues.join('; ')}`)
      const key = judgment.entityId ?? judgment.disposition
      const answers: Record<string, JevAnswer> = { placement: jevChoice(key) }
      for (const candidate of validated.value.candidates) {
        answers[`related_${candidate.id}`] = jevChoice(plan.related?.[candidate.id] ?? 'not_related')
      }
      const decoded = articleCatalogueBatchDefinition().decodeJev(answers, validated.value)
      if (!decoded.valid) throw new Error(`article-308 fixture batched catalogue answers are undecodable: ${decoded.issues.join('; ')}`)
      if (decoded.value.entityId !== judgment.entityId || decoded.value.disposition !== judgment.disposition) {
        throw new Error('article-308 fixture batched placement decode drifted from the plan')
      }
      return { value: decoded.value, answers }
    }
    case 'research.article_relationship_batch': {
      const validated = articleRelationshipBatchDefinition().validateState(request.state)
      if (!validated.valid) throw new Error(`article-308 fixture batched relationship state is invalid: ${validated.issues.join('; ')}`)
      const answers: Record<string, JevAnswer> = {}
      for (const entity of validated.value.entities) {
        const judgment = plan.relationships?.[entity.id]
        if (!judgment) throw new Error(`article-308 fixture plan has no batched relationship judgment for entity ${entity.id}`)
        if (judgment.raw !== undefined) throw new Error('raw relationship judgments cannot answer a batched dispatch; use a standalone story-relationship dispatch')
        answers[`relationship_target_${entity.id}`] = jevChoice(jointChoice(judgment))
      }
      const decoded = articleRelationshipBatchDefinition().decodeJev(answers, validated.value)
      if (!decoded.valid) throw new Error(`article-308 fixture batched relationship answers are undecodable: ${decoded.issues.join('; ')}`)
      for (const target of decoded.value.targets) {
        const judgment = plan.relationships![target.entityId]!
        if (target.relationship !== judgment.relationship || target.priorItemId !== (judgment.priorItemId ?? null)) {
          throw new Error('article-308 fixture batched relationship decode drifted from the plan')
        }
      }
      return { value: decoded.value, answers }
    }
    case 'research.article_entity_proposal_validation': {
      if (!plan.proposal) throw new Error('article-308 fixture plan received an unexpected creation-proposal validation dispatch')
      return { value: { disposition: plan.proposal }, answers: { proposal: jevChoice(plan.proposal) } }
    }
    case 'research.article_novelty': {
      const state = request.state as { reconciliation?: { priorVerdict: string } }
      if (state.reconciliation !== undefined) {
        if (!plan.noveltyReconcile) throw new Error('article-308 fixture plan received an unexpected duplicate reconciliation dispatch')
        const validated = articleNoveltyDefinition().validateState(request.state)
        if (!validated.valid) throw new Error(`article-308 fixture reconciliation state is invalid: ${validated.issues.join('; ')}`)
        const choiceKey = plan.noveltyReconcile.primaryRelationship
          ? `${plan.noveltyReconcile.verdict}:${plan.noveltyReconcile.primaryRelationship}`
          : plan.noveltyReconcile.verdict
        return {
          value: {
            verdict: plan.noveltyReconcile.verdict,
            ...(plan.noveltyReconcile.primaryRelationship ? { primaryRelationship: plan.noveltyReconcile.primaryRelationship } : {}),
          },
          answers: { novelty: jevChoice(choiceKey) },
        }
      }
      if (!plan.novelty) throw new Error('article-308 fixture plan has no novelty verdict')
      return { value: { verdict: plan.novelty }, answers: { novelty: jevChoice(plan.novelty) } }
    }
    default:
      throw new Error(`article-308 fixture gateway received an unexpected workload ${request.workload}`)
  }
}

/**
 * Mocked classification gateway for the #308 fixtures. Jev answers carry raw
 * Choice evidence; batched catalogue/relationship answers are decoded through
 * the real registry definitions so the fixture proves the state and answer
 * wire format. Selected requests resolve as Hermes fallback results instead.
 */
export function article308Gateway(plan: Article308Plan): { gateway: Article308MockGateway, requests: ClassificationRequest[] } {
  const requests: ClassificationRequest[] = []
  const gateway: Article308MockGateway = {
    recordPolicyOutcome() {},
    async classify<Value>(request: ClassificationRequest): Promise<ClassificationResult<Value>> {
      requests.push(request)
      const value = stage(plan, request)
      const base = { ...v4ClassificationResult(value.value as Value), workload: request.workload, decisionVersion: request.decisionVersion }
      if (plan.hermes?.(request) === true) {
        return { ...base, answers: null, actualProvider: 'ollama-cloud', actualModel: 'glm-5.3-flash', fallbackUsed: true, fallbackReason: 'provider_billing' }
      }
      return { ...base, answers: value.answers ?? null, actualProvider: 'typesafe', actualModel: 'jev-1.13.0', fallbackUsed: false, fallbackReason: null }
    },
  }
  return { gateway, requests }
}

/** Iran plan: conflict primary continuing managed conflict-1, three independent related memberships. */
export function article308IranPlan(): Article308Plan {
  return {
    placement: { entityId: 'conflict', disposition: 'selected' },
    related: { conflict: 'not_related', iran: 'related', us: 'related', qatar: 'related' },
    relationships: {
      conflict: { relationship: 'direct_continuation', priorItemId: 'conflict-1', priorItemSource: 'managed' },
      iran: { relationship: 'same_topic_only' },
      us: { relationship: 'same_topic_only' },
      qatar: { relationship: 'same_topic_only' },
    },
    novelty: 'new_information',
  }
}

/** BlackRock plan: Bitcoin primary, BlackRock related, continuation on each supplied prior. */
export function article308BlackRockPlan(): Article308Plan {
  return {
    placement: { entityId: 'bitcoin', disposition: 'selected' },
    related: { bitcoin: 'not_related', blackrock: 'related' },
    relationships: {
      bitcoin: { relationship: 'direct_continuation', priorItemId: 'btc-1', priorItemSource: 'managed' },
      blackrock: { relationship: 'direct_continuation', priorItemId: 'br-1', priorItemSource: 'legacy' },
    },
    novelty: 'new_information',
  }
}