import { ARTICLE_UPDATED_ENTITY_SUMMARY_MAX_CHARS } from '../research-engine/structured-synthesizer'
import type { ArticleResearchPacketV1, ArticleResearchPacketV2 } from '../signal-platform/contracts'
import type { ManagedEntityBinding } from './postgres-knowledge-writer'

/** #341: re-uses the synthesizer's own ceiling for updatedEntitySummary prose. */
export const ENTITY_SUMMARY_MAX_CHARS = ARTICLE_UPDATED_ENTITY_SUMMARY_MAX_CHARS

export type EntitySummaryOutcome = 'update' | 'kept' | 'held_for_review'

export interface EntitySummaryDecision {
  entityId: string | null
  name: string
  role: 'primary' | 'related'
  outcome: EntitySummaryOutcome
  reason: string
  proposedSummary: string | null
}

export interface EntitySummaryUpdate { entityId: string, summary: string }

type ArticlePacket = ArticleResearchPacketV1 | ArticleResearchPacketV2
type ArticleMembership = ArticlePacket['memberships'][number]

/**
 * #341: Entity Manager stays a librarian — no model call. Deterministic gates
 * decide, per membership in packet order, whether the packet's
 * updatedEntitySummary may replace the managed entity summary: a selected
 * placement above the confident floor (no saved uncertainty), a non-duplicate
 * article, a continuing or branching relationship, new-or-contradicting
 * novelty, and a bounded non-empty summary about that entity that differs from
 * the current one. A contradicts_prior novelty holds the summary for review
 * instead of applying it; the persisted decisions are the durable audit trail.
 */
export function decideEntitySummaryUpdates(input: {
  packet: ArticlePacket
  entities: readonly ManagedEntityBinding[]
  duplicateTarget: { itemId: string, source: 'legacy' | 'managed', entityId: string } | null
  placementFloor: number
}): { updates: EntitySummaryUpdate[], decisions: EntitySummaryDecision[] } {
  const updates: EntitySummaryUpdate[] = []
  const decisions: EntitySummaryDecision[] = []
  const novelty = input.packet.novelty.choice
  for (const membership of input.packet.memberships) {
    const keep = (reason: string) => {
      decisions.push({ entityId: membership.entityId, name: membership.name, role: membership.role, outcome: 'kept', reason, proposedSummary: null })
    }
    // a. New or unresolved entities keep the creation summary they were born with.
    if (membership.placementDisposition !== 'selected') { keep('new_or_unresolved_entity'); continue }
    // b. Exact duplicate reuse never rewrites history.
    if (input.duplicateTarget !== null || membership.duplicateTarget !== null) { keep('duplicate'); continue }
    // c. Condition 1: certain placement at or above the confident floor.
    const placement = membership.placement as { confidence?: unknown }
    const confidence = typeof membership.placementConfidence === 'number'
      ? membership.placementConfidence
      : typeof placement.confidence === 'number' ? placement.confidence : null
    if (membership.placementUncertain === true) { keep('placement_uncertain'); continue }
    if (confidence === null) { keep('placement_unscored'); continue }
    if (confidence < input.placementFloor) { keep('placement_below_floor'); continue }
    // d. Condition 3: the article must continue or branch the entity's story.
    if (membership.relationship !== 'direct_continuation' && membership.relationship !== 'related_story_branch') {
      keep(`relationship_${membership.relationship ?? 'none'}`)
      continue
    }
    // e. Condition 2: the article must bring new information or contradict prior knowledge.
    if (novelty !== 'new_information' && novelty !== 'contradicts_prior') { keep(`novelty_${novelty}`); continue }
    // f. Condition 4: the proposed summary itself.
    const proposed = typeof membership.updatedEntitySummary === 'string' ? collapseWhitespace(membership.updatedEntitySummary) : null
    if (proposed === null) { keep('summary_missing'); continue }
    if (proposed === '') { keep('summary_empty'); continue }
    if (proposed.length > ENTITY_SUMMARY_MAX_CHARS) { keep('summary_too_long'); continue }
    const binding = membership.entityId === null ? undefined : input.entities.find((entity) => entity.id === membership.entityId)
    if (!binding) { keep('entity_binding_missing'); continue }
    if (!summaryNamesEntity(proposed, binding, membership)) { keep('summary_not_about_entity'); continue }
    if (collapseWhitespace(binding.summary ?? '') === proposed) { keep('summary_unchanged'); continue }
    // g. Condition 5: a contradiction is held for review; nothing is overwritten.
    if (novelty === 'contradicts_prior') {
      decisions.push({ entityId: binding.id, name: membership.name, role: membership.role, outcome: 'held_for_review', reason: 'novelty_contradicts_prior', proposedSummary: proposed })
      continue
    }
    // h. Apply the update once per entity.
    if (updates.some((update) => update.entityId === binding.id)) { keep('duplicate_entity_membership'); continue }
    updates.push({ entityId: binding.id, summary: proposed })
    decisions.push({ entityId: binding.id, name: membership.name, role: membership.role, outcome: 'update', reason: 'conditions_met', proposedSummary: proposed })
  }
  return { updates, decisions }
}

/**
 * #341: one durable audit line per membership decision. Persisted
 * summaryDecisions remain the review record; these logs make held_for_review
 * visible in the operator trace without a model call.
 */
export function logEntitySummaryDecisions(workId: string, decisions: readonly EntitySummaryDecision[]): void {
  for (const { entityId, name, role, outcome, reason } of decisions) {
    console.info(`[entity-manager:summary] ${JSON.stringify({ event: 'entity_summary_decision', workId, entityId, name, role, outcome, reason })}`)
  }
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function normalizeLabel(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function summaryNamesEntity(proposed: string, binding: ManagedEntityBinding, membership: ArticleMembership): boolean {
  const haystack = ` ${normalizeLabel(proposed)} `
  return [binding.name, ...binding.aliases, membership.name, ...membership.aliases].some((label) => {
    const normalized = normalizeLabel(label)
    return normalized.length >= 2 && haystack.includes(` ${normalized} `)
  })
}