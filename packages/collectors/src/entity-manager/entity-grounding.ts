import type { EntityHint, ResearchPacketV1 } from '../signal-platform/contracts'
import { legacyEntityTypeToKindV1, type EntityKindV1 } from './entity-knowledge-context'
import { normalizeSlug } from './normalization'
import type { EntityRecord } from './types'

export type EntityGroundingMatchKind = 'canonical_name' | 'canonical_slug' | 'alias'

export type EntityGroundingDecision =
  | 'authoritative_canonical'
  | 'authoritative_unique_alias'
  | 'ambiguous_canonical'
  | 'ambiguous_alias'
  | 'non_authoritative_alias'
  | 'suppressed_by_canonical'
  | 'incompatible_type'
  | 'non_authoritative_role'

export interface EntityGroundingMatchSupport {
  hintIndex: number
  /** The actual (or conservatively derived) hint label used for this match. */
  label: string
  labelSource: 'name' | 'name_base' | 'alias'
  matchKind: EntityGroundingMatchKind
  decision: EntityGroundingDecision
  primarySelectionAuthorized: boolean
  role: string | null
  hintType: EntityKindV1 | null
  entityType: EntityKindV1
  claimRefs: string[]
  evidenceRefs: string[]
}

export interface EntityGroundingSupport {
  entityId: string
  primarySelectionAuthorized: boolean
  /** Evidence linkage from authoritative matches only. */
  supportingClaimIds: string[]
  /** Evidence linkage from authoritative matches only. */
  supportingEvidenceIds: string[]
  matches: EntityGroundingMatchSupport[]
}

export interface EntityGroundingResult {
  /** Only candidates deterministically authorized for primary selection. */
  candidates: EntityRecord[]
  /** Audit metadata for every evidence-linked identity match, including rejected matches. */
  support: EntityGroundingSupport[]
}

interface CandidateState {
  entity: EntityRecord
  inputIndex: number
  matches: EntityGroundingMatchSupport[]
}

interface HintLabel {
  value: string
  source: EntityGroundingMatchSupport['labelSource']
}

interface IdentityMatch {
  state: CandidateState
  kind: EntityGroundingMatchKind
  entityType: EntityKindV1
  compatible: boolean
}

const NON_SUBJECT_ROLE_TOKENS = new Set([
  'not',
  'non',
  'publisher',
  'source',
  'venue',
  'example',
  'mentioned',
  'mention',
  'context',
])

/**
 * Grounds canon lookup results in the packet's evidence-linked Entity hints.
 *
 * Null roles deliberately fail closed: current packets may omit a role, but an
 * omission is not positive evidence that an Entity is the packet's subject.
 * Such identity matches remain visible in `support` and cannot enter
 * `candidates` until research emits an explicit subject/primary role.
 */
export function groundEntityCandidates(
  candidates: readonly EntityRecord[],
  entityHints: ResearchPacketV1['entityHints'],
): EntityGroundingResult {
  const states = uniqueCandidateStates(candidates)

  for (const [hintIndex, hint] of entityHints.entries()) {
    if (!isEvidenceLinked(hint)) continue

    const roleAuthorizes = entityHintAuthorizesPrimarySelection(hint.role)
    const hintType = normalizeGroundingType(hint.type)
    for (const label of hintLabels(hint)) {
      const matches = states.flatMap((state): IdentityMatch[] => {
        const kind = identityMatchKind(state.entity, label.value)
        if (!kind) return []
        const entityType = normalizeGroundingType(state.entity.type) ?? 'unclassified'
        return [{
          state,
          kind,
          entityType,
          compatible: typesAreCompatible(hintType, entityType),
        }]
      })
      const compatibleMatches = matches.filter((match) => match.compatible)
      const canonicalMatches = compatibleMatches.filter((match) => match.kind !== 'alias')
      const aliasMatches = compatibleMatches.filter((match) => match.kind === 'alias')

      for (const match of matches) {
        const decision = groundingDecision(match, canonicalMatches, aliasMatches, roleAuthorizes, label.value)
        match.state.matches.push({
          hintIndex,
          label: label.value,
          labelSource: label.source,
          matchKind: match.kind,
          decision,
          primarySelectionAuthorized: decision === 'authoritative_canonical'
            || decision === 'authoritative_unique_alias',
          role: cleanOptional(hint.role),
          hintType,
          entityType: match.entityType,
          claimRefs: uniqueNonEmpty(hint.claimRefs),
          evidenceRefs: uniqueNonEmpty(hint.evidenceRefs),
        })
      }
    }
  }

  const support = states
    .filter((state) => state.matches.length > 0)
    .map(toEntitySupport)
    .sort(compareSupport)
  const supportById = new Map(support.map((item) => [item.entityId, item]))
  const grounded = states
    .filter((state) => supportById.get(state.entity.id)?.primarySelectionAuthorized)
    .sort((left, right) => compareGroundedStates(left, right, supportById))
    .map((state) => state.entity)

  return { candidates: grounded, support }
}

function uniqueCandidateStates(candidates: readonly EntityRecord[]): CandidateState[] {
  const seen = new Set<string>()
  const output: CandidateState[] = []
  for (const [inputIndex, entity] of candidates.entries()) {
    if (seen.has(entity.id)) continue
    seen.add(entity.id)
    output.push({ entity, inputIndex, matches: [] })
  }
  return output
}

function isEvidenceLinked(hint: EntityHint): boolean {
  return uniqueNonEmpty(hint.claimRefs).length > 0 || uniqueNonEmpty(hint.evidenceRefs).length > 0
}

function hintLabels(hint: EntityHint): HintLabel[] {
  const output: HintLabel[] = []
  const seen = new Set<string>()
  const add = (value: string, source: HintLabel['source']): void => {
    const cleaned = cleanOptional(value)
    if (!cleaned || seen.has(cleaned)) return
    seen.add(cleaned)
    output.push({ value: cleaned, source })
  }

  add(hint.name, 'name')

  // Research commonly emits "Canonical Name (TICKER)" plus TICKER as an
  // explicit alias. Only derive the base when that exact ticker is corroborated
  // by the hint aliases; this lets Solana outrank a polluted `Solana` alias
  // without treating arbitrary parenthetical text as canonical identity.
  const parenthetical = cleanOptional(hint.name)?.match(/^(.+?)\s*\(([^()]+)\)$/)
  if (parenthetical) {
    const base = cleanOptional(parenthetical[1])
    const qualifier = cleanOptional(parenthetical[2])
    if (base && qualifier && isTickerLike(qualifier) && hint.aliases.some((alias) => cleanOptional(alias) === qualifier)) {
      add(base, 'name_base')
    }
  }

  for (const alias of hint.aliases) add(alias, 'alias')
  return output
}

/** Identity labels used by canon lookup and deterministic grounding. */
export function entityHintIdentityLabels(hint: EntityHint): string[] {
  return hintLabels(hint).map((label) => label.value)
}

/** Canonical-name labels only; aliases remain in the alias lookup channel. */
export function entityHintCanonicalLabels(hint: EntityHint): string[] {
  return hintLabels(hint)
    .filter((label) => label.source !== 'alias')
    .map((label) => label.value)
}

function identityMatchKind(entity: EntityRecord, label: string): EntityGroundingMatchKind | null {
  if (identityEquals(label, entity.name)) return 'canonical_name'
  // Do not case-fold a ticker through slugification: `SOL` is not authority for
  // an unrelated canonical Entity whose human name/slug is `Sol`/`sol`.
  if (!isTickerLike(normalizedIdentity(label))
    && normalizeSlug(undefined, label) === normalizeSlug(undefined, entity.slug)) return 'canonical_slug'
  if (entity.aliases.some((alias) => identityEquals(label, alias))) return 'alias'
  return null
}

function identityEquals(label: string, candidateLabel: string): boolean {
  const left = normalizedIdentity(label)
  const right = normalizedIdentity(candidateLabel)
  if (!left || !right) return false
  // Symbols/acronyms are identities, not ordinary case-insensitive words:
  // `SOL` must not match a polluted title-case `Sol` alias.
  if (isTickerLike(left)) return left === right
  return left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
}

function normalizedIdentity(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

function isTickerLike(value: string): boolean {
  return /^\$?[A-Z][A-Z0-9.-]{1,9}$/.test(value)
}

export function entityHintAuthorizesPrimarySelection(role: string | null): boolean {
  const normalized = cleanOptional(role)?.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, '_')
  if (!normalized) return false
  const tokens = normalized.split('_').filter(Boolean)
  // Negative/provenance qualifiers win over a stray `subject` token.
  if (tokens.some((token) => NON_SUBJECT_ROLE_TOKENS.has(token))) return false
  // Phrases such as "subject of report" are positive subject assertions.
  if (tokens.includes('subject')) return true
  return tokens.includes('primary')
}

function normalizeGroundingType(value: string | null): EntityKindV1 | null {
  const cleaned = cleanOptional(value)?.toLocaleLowerCase('en-US').replace(/[\s-]+/g, '_')
  if (!cleaned) return null
  switch (cleaned) {
    case 'blockchain':
    case 'blockchain_network':
    case 'chain':
    case 'layer_1':
    case 'layer1':
    case 'l1':
      return 'network'
    case 'app':
    case 'application':
      return 'product'
    case 'token':
    case 'coin':
    case 'cryptocurrency':
      return 'asset'
    default:
      return legacyEntityTypeToKindV1(cleaned)
  }
}

function typesAreCompatible(hintType: EntityKindV1 | null, entityType: EntityKindV1): boolean {
  return hintType === null
    || hintType === 'unclassified'
    || entityType === 'unclassified'
    || hintType === entityType
}

function groundingDecision(
  match: IdentityMatch,
  canonicalMatches: readonly IdentityMatch[],
  aliasMatches: readonly IdentityMatch[],
  roleAuthorizes: boolean,
  label: string,
): EntityGroundingDecision {
  if (!match.compatible) return 'incompatible_type'
  if (match.kind === 'alias' && canonicalMatches.length > 0) return 'suppressed_by_canonical'
  if (match.kind !== 'alias' && canonicalMatches.length > 1) return 'ambiguous_canonical'
  if (match.kind === 'alias' && aliasMatches.length > 1) return 'ambiguous_alias'
  if (!roleAuthorizes) return 'non_authoritative_role'
  if (
    match.kind === 'alias'
    && !isTickerLike(normalizedIdentity(label))
    && !entityAliasIsStructurallyRelated(label, match.state.entity.name)
  ) return 'non_authoritative_alias'
  return match.kind === 'alias' ? 'authoritative_unique_alias' : 'authoritative_canonical'
}

export function entityAliasIsStructurallyRelated(alias: string, canonicalName: string): boolean {
  const normalizedAlias = normalizedIdentity(alias).replace(/^@/, '').toLocaleLowerCase('en-US')
  const words = normalizedIdentity(canonicalName)
    .toLocaleLowerCase('en-US')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  if (normalizedAlias.length < 3) return false
  if (words.some((word) => word.startsWith(normalizedAlias))) return true
  const compactName = words.join('')
  const compactAlias = normalizedAlias.replace(/[^a-z0-9]+/g, '')
  if (compactAlias.length >= 3 && compactAlias === compactName) return true
  const acronym = words
    .filter((word) => !['a', 'an', 'and', 'for', 'of', 'the', 'to'].includes(word))
    .map((word) => word[0])
    .join('')
  return compactAlias.length >= 2 && compactAlias === acronym
}

function toEntitySupport(state: CandidateState): EntityGroundingSupport {
  const authoritative = state.matches.filter((match) => match.primarySelectionAuthorized)
  return {
    entityId: state.entity.id,
    primarySelectionAuthorized: authoritative.length > 0,
    supportingClaimIds: uniqueNonEmpty(authoritative.flatMap((match) => match.claimRefs)),
    supportingEvidenceIds: uniqueNonEmpty(authoritative.flatMap((match) => match.evidenceRefs)),
    matches: state.matches,
  }
}

function compareGroundedStates(
  left: CandidateState,
  right: CandidateState,
  supportById: ReadonlyMap<string, EntityGroundingSupport>,
): number {
  const leftSupport = supportById.get(left.entity.id)!
  const rightSupport = supportById.get(right.entity.id)!
  const strength = bestAuthorizedStrength(leftSupport) - bestAuthorizedStrength(rightSupport)
  if (strength !== 0) return strength
  const hint = firstAuthorizedHint(leftSupport) - firstAuthorizedHint(rightSupport)
  if (hint !== 0) return hint
  return left.inputIndex - right.inputIndex || left.entity.id.localeCompare(right.entity.id)
}

function compareSupport(left: EntityGroundingSupport, right: EntityGroundingSupport): number {
  if (left.primarySelectionAuthorized !== right.primarySelectionAuthorized) {
    return left.primarySelectionAuthorized ? -1 : 1
  }
  const strength = bestAuthorizedStrength(left) - bestAuthorizedStrength(right)
  if (strength !== 0) return strength
  return left.entityId.localeCompare(right.entityId)
}

function bestAuthorizedStrength(support: EntityGroundingSupport): number {
  const strengths = support.matches
    .filter((match) => match.primarySelectionAuthorized)
    .map((match) => match.matchKind === 'canonical_name' ? 0 : match.matchKind === 'canonical_slug' ? 1 : 2)
  return strengths.length > 0 ? Math.min(...strengths) : Number.MAX_SAFE_INTEGER
}

function firstAuthorizedHint(support: EntityGroundingSupport): number {
  const indexes = support.matches
    .filter((match) => match.primarySelectionAuthorized)
    .map((match) => match.hintIndex)
  return indexes.length > 0 ? Math.min(...indexes) : Number.MAX_SAFE_INTEGER
}

function cleanOptional(value: string | null): string | null {
  const cleaned = value?.normalize('NFKC').replace(/\s+/g, ' ').trim()
  return cleaned || null
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const output: string[] = []
  for (const value of values) {
    const cleaned = cleanOptional(value)
    if (!cleaned || seen.has(cleaned)) continue
    seen.add(cleaned)
    output.push(cleaned)
  }
  return output
}
