import { normalizedIdentity } from './candidates'
import type {
  EntityCatalogProfile,
  EntityIdentityJudgment,
  EntityMaintenanceCandidate,
  EntityMaintenanceFindingInput,
  EntityMaintenanceRecommendedAction,
} from './contracts'

const AUTO_MERGE_CONFIDENCE = 0.995

export function findingFromJudgment(
  runId: string,
  candidate: EntityMaintenanceCandidate,
  judgment: EntityIdentityJudgment,
): EntityMaintenanceFindingInput {
  if (candidate.pairKey !== judgment.pairKey) throw new Error('Entity judgment pairKey mismatch.')
  const canonical = judgment.decision === 'same_entity'
    ? selectCanonicalEntity(candidate.left, candidate.right)
    : null
  return {
    runId,
    pairKey: candidate.pairKey,
    leftEntityId: candidate.left.id,
    rightEntityId: candidate.right.id,
    decision: judgment.decision,
    recommendedAction: recommendedAction(judgment),
    confidence: judgment.confidence,
    canonicalEntityId: canonical?.id ?? null,
    pollutedEntityId: judgment.pollutedEntityId,
    pollutedAlias: judgment.pollutedAlias,
    reason: judgment.reason,
    candidateSignals: candidate.signals,
    profileSnapshot: { left: candidate.left, right: candidate.right },
    autoApplyEligible: canonical !== null && autoMergeEligible(candidate, judgment),
  }
}

/** Code, not the model, chooses which stable ID survives a proposed merge. */
export function selectCanonicalEntity(
  left: EntityCatalogProfile,
  right: EntityCatalogProfile,
): EntityCatalogProfile {
  return [left, right].sort((first, second) => (
    Number(second.showInCarousel) - Number(first.showInCarousel)
    || second.memoryCount - first.memoryCount
    || second.sourceCount - first.sourceCount
    || timestamp(first.createdAt) - timestamp(second.createdAt)
    || identityQuality(second) - identityQuality(first)
    || first.id.localeCompare(second.id)
  ))[0]!
}

export function autoMergeEligible(
  candidate: EntityMaintenanceCandidate,
  judgment: EntityIdentityJudgment,
): boolean {
  if (judgment.decision !== 'same_entity' || judgment.confidence < AUTO_MERGE_CONFIDENCE) return false
  if (!candidate.signals.some((signal) => signal.kind === 'exact_name')) return false
  if (normalizedIdentity(candidate.left.type) !== normalizedIdentity(candidate.right.type)) return false
  if (candidate.left.status !== 'active' || candidate.right.status !== 'active') return false
  // Product-facing Entities always require a human decision even when labels
  // are exact; this avoids silently changing a live carousel lane.
  if (candidate.left.showInCarousel || candidate.right.showInCarousel) return false
  return true
}

function recommendedAction(judgment: EntityIdentityJudgment): EntityMaintenanceRecommendedAction {
  switch (judgment.decision) {
    case 'same_entity': return 'merge'
    case 'different_entities': return 'keep_separate'
    case 'polluted_alias': return 'quarantine_alias'
    case 'unsure': return 'review'
  }
}

function identityQuality(profile: EntityCatalogProfile): number {
  let score = 0
  if (normalizedIdentity(profile.name) === normalizedIdentity(profile.slug)) score += 2
  if (profile.summary) score += 1
  if (profile.aliases.length > 0) score += 1
  return score
}

function timestamp(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER
}
