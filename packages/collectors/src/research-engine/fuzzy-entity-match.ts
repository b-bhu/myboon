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
 * PR-4: one trailing legal-suffix token (Inc/Ltd/Corp/Labs, with or without
 * the dot, after spaces or commas) is removed from the NAME before keying —
 * 'Metaplanet Inc.' keys the same as 'Metaplanet' even though the PG trigram
 * score on the stored keys stays in the hold band — and a candidate whose
 * fuzzyCompareKey equals the proposal's is treated as similarity 1 (attach
 * band), still subject to type compatibility (#342 PR-4 CTO). The stored
 * name_key and entity_name_key_v1 are deliberately unchanged.
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

/**
 * #342 PR-4: ONE trailing legal-suffix token (inc, ltd, corp, labs — with
 * optional punctuation such as a trailing '.') is removed from the NAME before
 * keying, but only when a non-empty base remains ('Inc.' keeps itself). Fused
 * words ('Xinc') and multi-line names are untouched: the suffix must be its own
 * whitespace/comma-delimited trailing token.
 */
export function stripLegalSuffixKey(name: string): string {
  const stripped = name.replace(/[\s,]+(?:inc|ltd|corp|labs)\.?$/i, '')
  return stripped.trim().length > 0 ? stripped : name
}

/** entityIdentityKey over the suffix-stripped name, without touching the stored name_key. */
export function fuzzyCompareKey(name: string): string {
  return entityIdentityKey(stripLegalSuffixKey(name))
}

export function decideFuzzyEntityMatch(
  proposal: { name: string, type: string | null | undefined },
  candidates: readonly FuzzyEntityCandidate[],
): FuzzyEntityDecision {
  const proposalKey = entityIdentityKey(proposal.name)
  if (proposalKey.length < FUZZY_MIN_KEY_LENGTH) return { kind: 'none', reason: 'short_key' }
  // #342 PR-4: a candidate whose compare key equals the proposal's compare key
  // (one trailing legal-suffix token stripped) counts as similarity 1 — attach
  // band, still subject to type compatibility. The raw name_key equals row stays
  // the exact path: it is excluded below exactly as the SQL candidate query does.
  const compareKeyEqual = (candidate: FuzzyEntityCandidate) =>
    candidate.nameKey !== proposalKey && fuzzyCompareKey(candidate.name) === fuzzyCompareKey(proposal.name)
  const effectiveSimilarity = (candidate: FuzzyEntityCandidate) => compareKeyEqual(candidate) ? 1 : candidate.similarity
  const scored = candidates
    .filter((candidate) => candidate.nameKey !== proposalKey && candidate.nameKey.length >= FUZZY_MIN_KEY_LENGTH)
    .filter((candidate) => effectiveSimilarity(candidate) >= FUZZY_HOLD_MIN_SIMILARITY)
    .sort((a, b) => effectiveSimilarity(b) - effectiveSimilarity(a) || a.id.localeCompare(b.id))
  if (scored.length === 0) return { kind: 'none', reason: 'no_candidate' }
  const attachBand = scored.filter((candidate) => effectiveSimilarity(candidate) >= FUZZY_ATTACH_MIN_SIMILARITY)
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
