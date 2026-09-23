import type { EntityHint, ResearchClaim } from './contracts'

/**
 * Adds code-owned claim references to Entity hints using explicit identity
 * mentions in claim text. Evidence overlap and model-owned attribution are
 * intentionally insufficient because either can connect unrelated claims.
 */
export function deriveEntityHintClaimRefs(
  hints: readonly EntityHint[],
  claims: readonly ResearchClaim[],
): EntityHint[] {
  const knownClaimIds = new Set(claims.map((claim) => claim.claimId))
  return hints.map((hint) => {
    const labels = hintCanonicalIdentityLabels(hint)
    const derived = claimRefsForIdentityLabels(labels, claims)
    return {
      ...hint,
      aliases: [...hint.aliases],
      // Recompute rather than trusting model-owned or historical claim links.
      claimRefs: derived.filter((claimId) => knownClaimIds.has(claimId)),
      evidenceRefs: [...hint.evidenceRefs],
    }
  })
}

export function claimRefsForIdentityLabels(
  labels: readonly string[],
  claims: readonly ResearchClaim[],
): string[] {
  const identities = unique(labels.map(clean).filter(Boolean))
  return claims
    .filter((claim) => identities.some((label) => claimConcernsLabel(claim, label)))
    .map((claim) => claim.claimId)
}

function hintCanonicalIdentityLabels(hint: EntityHint): string[] {
  const labels = [hint.name]
  const parenthetical = clean(hint.name).match(/^(.+?)\s*\(([^()]+)\)$/)
  if (parenthetical) {
    const base = clean(parenthetical[1])
    const qualifier = clean(parenthetical[2])
    if (base && isTickerLike(qualifier) && hint.aliases.some((alias) => clean(alias) === qualifier)) {
      labels.push(base)
    }
  }
  return unique(labels.map(clean).filter(Boolean))
}

function claimConcernsLabel(claim: ResearchClaim, label: string): boolean {
  return containsIdentity(claim.claim, label)
}

function containsIdentity(text: string, label: string): boolean {
  const ticker = isTickerLike(label)
  const haystack = ticker ? text : text.toLocaleLowerCase('en-US')
  const needle = ticker ? label : label.toLocaleLowerCase('en-US')
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`).test(haystack)
}

function isTickerLike(value: string): boolean {
  return /^\$?[A-Z][A-Z0-9.-]{1,9}$/.test(value)
}

function clean(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}
