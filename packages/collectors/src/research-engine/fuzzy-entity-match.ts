import { entityIdentityKey } from '../entity-manager/identity-key'
import { legacyEntityTypeToKindV1, type EntityKindV1 } from '../entity-manager/entity-knowledge-context'

/**
 * #342 PR-2: fuzzy duplicate guard for article entity creation.
 *
 * Runs only after the exact name/alias lookup found nothing. Similarity is the
 * pg_trgm score on name_key (no spaces) from
 * managed_knowledge_private.fuzzy_entity_candidates_v1. Bands (CTO, #342):
 *   >= FUZZY_ATTACH_MIN_SIMILARITY  -> offer the candidate to placement again
 *                                      (attach only if placement selects it)
 *   >= FUZZY_HOLD_MIN_SIMILARITY    -> always a hold, never an attach
 *   below                           -> normal creation
 * Guard rails: keys shorter than FUZZY_MIN_KEY_LENGTH are skipped (normal
 * creation); an attach-band match with an incompatible type is a hold; two or
 * more attach-band matches are a hold. Constants so Bucket can tune them.
 */
export const FUZZY_ATTACH_MIN_SIMILARITY = 0.85
export const FUZZY_HOLD_MIN_SIMILARITY = 0.6
export const FUZZY_MIN_KEY_LENGTH = 6

export interface FuzzyEntityCandidate {
  id: string
  name: string
  aliases: string[]
  summary: string | null
  type: string | null
  status: string | null
  nameKey: string
  similarity: number
}

export type FuzzyEntityDecision =
  | { kind: 'none', reason: 'no_candidate' | 'short_key' }
  | { kind: 'attach_candidate', candidate: FuzzyEntityCandidate }
  | { kind: 'hold', reason: string, candidates: FuzzyEntityCandidate[] }

/** Grounding's rule (entity-grounding.ts typesAreCompatible) after legacyEntityTypeToKindV1. */
export function fuzzyTypesCompatible(proposalType: string | null | undefined, candidateType: string | null | undefined): boolean {
  const hint: EntityKindV1 | null = proposalType && proposalType.trim() ? legacyEntityTypeToKindV1(proposalType) : null
  const entity: EntityKindV1 = candidateType && candidateType.trim() ? legacyEntityTypeToKindV1(candidateType) : 'unclassified'
  return hint === null || hint === 'unclassified' || entity === 'unclassified' || hint === entity
}

export function decideFuzzyEntityMatch(
  proposal: { name: string, type: string | null | undefined },
  candidates: readonly FuzzyEntityCandidate[],
): FuzzyEntityDecision {
  const proposalKey = entityIdentityKey(proposal.name)
  if (proposalKey.length < FUZZY_MIN_KEY_LENGTH) return { kind: 'none', reason: 'short_key' }
  const scored = candidates
    .filter((candidate) => candidate.nameKey !== proposalKey && candidate.nameKey.length >= FUZZY_MIN_KEY_LENGTH)
    .filter((candidate) => candidate.similarity >= FUZZY_HOLD_MIN_SIMILARITY)
    .sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id))
  if (scored.length === 0) return { kind: 'none', reason: 'no_candidate' }
  const attachBand = scored.filter((candidate) => candidate.similarity >= FUZZY_ATTACH_MIN_SIMILARITY)
  const label = (candidate: FuzzyEntityCandidate) => `${candidate.name} (${candidate.id}, similarity ${candidate.similarity.toFixed(2)})`
  if (attachBand.length > 1) {
    return { kind: 'hold', candidates: attachBand, reason: `creation proposal for ${proposal.name} is a near-duplicate of several entities: ${attachBand.map(label).join('; ')}` }
  }
  if (attachBand.length === 1) {
    const candidate = attachBand[0]!
    if (!fuzzyTypesCompatible(proposal.type, candidate.type)) {
      return { kind: 'hold', candidates: [candidate], reason: `creation proposal for ${proposal.name} (type ${proposal.type ?? 'unknown'}) is a near-duplicate of ${label(candidate)} with an incompatible type ${candidate.type ?? 'unknown'}` }
    }
    return { kind: 'attach_candidate', candidate }
  }
  return { kind: 'hold', candidates: scored, reason: `creation proposal for ${proposal.name} may duplicate ${scored.slice(0, 3).map(label).join('; ')}` }
}
