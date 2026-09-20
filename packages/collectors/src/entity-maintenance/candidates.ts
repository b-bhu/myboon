import type {
  EntityCandidateSignal,
  EntityCandidateSignalKind,
  EntityCatalogProfile,
  EntityMaintenanceCandidate,
} from './contracts'

interface LabelMember {
  profile: EntityCatalogProfile
  source: 'name' | 'alias'
  label: string
}

interface CandidateAccumulator {
  left: EntityCatalogProfile
  right: EntityCatalogProfile
  signals: Map<string, EntityCandidateSignal>
}

const MAX_ALIAS_ONLY_BUCKET = 10
const MIN_FUZZY_LABEL_LENGTH = 5
const SIMILAR_NAME_THRESHOLD = 0.86
const SIMILAR_SLUG_THRESHOLD = 0.9
const MEMORY_TITLE_OVERLAP_THRESHOLD = 0.6
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with',
])

/**
 * Scans every supplied Entity while emitting only plausible pair candidates.
 * Hermes never receives the complete catalogue in one prompt.
 */
export function buildEntityMaintenanceCandidates(
  profiles: readonly EntityCatalogProfile[],
): EntityMaintenanceCandidate[] {
  const uniqueProfiles = uniqueById(profiles)
  const accumulators = new Map<string, CandidateAccumulator>()
  const buckets = identityBuckets(uniqueProfiles)

  for (const [label, members] of buckets) {
    const byEntity = uniqueMembers(members)
    const hasCanonicalName = byEntity.some((member) => member.source === 'name')
    if (!hasCanonicalName && byEntity.length > MAX_ALIAS_ONLY_BUCKET) continue

    for (let leftIndex = 0; leftIndex < byEntity.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < byEntity.length; rightIndex += 1) {
        const left = byEntity[leftIndex]!
        const right = byEntity[rightIndex]!
        if (left.profile.id === right.profile.id) continue
        const kind: EntityCandidateSignalKind = left.source === 'name' && right.source === 'name'
          ? 'exact_name'
          : left.source === 'name' || right.source === 'name'
            ? 'name_alias'
            : 'shared_alias'
        addSignal(accumulators, left.profile, right.profile, { kind, label })
      }
    }
  }

  // 1,652 Entities is small enough for a deterministic canonical-name pass;
  // this remains local and does not increase inference context.
  for (let leftIndex = 0; leftIndex < uniqueProfiles.length; leftIndex += 1) {
    const left = uniqueProfiles[leftIndex]!
    for (let rightIndex = leftIndex + 1; rightIndex < uniqueProfiles.length; rightIndex += 1) {
      const right = uniqueProfiles[rightIndex]!
      const leftName = normalizedIdentity(left.name)
      const rightName = normalizedIdentity(right.name)
      if (leftName.length >= MIN_FUZZY_LABEL_LENGTH && rightName.length >= MIN_FUZZY_LABEL_LENGTH) {
        const nameScore = diceCoefficient(leftName, rightName)
        if (nameScore >= SIMILAR_NAME_THRESHOLD) {
          addSignal(accumulators, left, right, { kind: 'similar_name', score: rounded(nameScore) })
        }
      }

      const leftSlug = normalizedIdentity(left.slug)
      const rightSlug = normalizedIdentity(right.slug)
      if (leftSlug.length >= MIN_FUZZY_LABEL_LENGTH && rightSlug.length >= MIN_FUZZY_LABEL_LENGTH) {
        const slugScore = diceCoefficient(leftSlug, rightSlug)
        if (slugScore >= SIMILAR_SLUG_THRESHOLD) {
          addSignal(accumulators, left, right, { kind: 'similar_slug', score: rounded(slugScore) })
        }
      }
    }
  }

  for (const accumulator of accumulators.values()) {
    const overlap = recentTitleOverlap(accumulator.left, accumulator.right)
    if (overlap >= MEMORY_TITLE_OVERLAP_THRESHOLD) {
      addSignal(accumulators, accumulator.left, accumulator.right, {
        kind: 'memory_title_overlap',
        score: rounded(overlap),
      })
    }
  }

  return [...accumulators.entries()]
    .map(([pairKey, value]) => ({
      pairKey,
      left: value.left,
      right: value.right,
      signals: [...value.signals.values()].sort(compareSignals),
    }))
    .sort((left, right) => left.pairKey.localeCompare(right.pairKey))
}

export function normalizedIdentity(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function uniqueById(profiles: readonly EntityCatalogProfile[]): EntityCatalogProfile[] {
  const byId = new Map<string, EntityCatalogProfile>()
  for (const profile of profiles) if (!byId.has(profile.id)) byId.set(profile.id, profile)
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id))
}

function identityBuckets(profiles: readonly EntityCatalogProfile[]): Map<string, LabelMember[]> {
  const buckets = new Map<string, LabelMember[]>()
  for (const profile of profiles) {
    addBucketMember(buckets, profile, 'name', profile.name)
    for (const alias of profile.aliases) addBucketMember(buckets, profile, 'alias', alias)
  }
  return buckets
}

function addBucketMember(
  buckets: Map<string, LabelMember[]>,
  profile: EntityCatalogProfile,
  source: LabelMember['source'],
  rawLabel: string,
): void {
  const label = normalizedIdentity(rawLabel)
  if (label.length < 3 || STOP_WORDS.has(label)) return
  const current = buckets.get(label) ?? []
  current.push({ profile, source, label: rawLabel })
  buckets.set(label, current)
}

function uniqueMembers(members: readonly LabelMember[]): LabelMember[] {
  const byEntity = new Map<string, LabelMember>()
  for (const member of members) {
    const current = byEntity.get(member.profile.id)
    if (!current || (current.source === 'alias' && member.source === 'name')) {
      byEntity.set(member.profile.id, member)
    }
  }
  return [...byEntity.values()].sort((left, right) => left.profile.id.localeCompare(right.profile.id))
}

function addSignal(
  accumulators: Map<string, CandidateAccumulator>,
  first: EntityCatalogProfile,
  second: EntityCatalogProfile,
  signal: EntityCandidateSignal,
): void {
  const [left, right] = first.id < second.id ? [first, second] : [second, first]
  const pairKey = `${left.id}:${right.id}`
  const accumulator = accumulators.get(pairKey) ?? { left, right, signals: new Map() }
  const signalKey = `${signal.kind}:${signal.label ?? ''}:${signal.score ?? ''}`
  accumulator.signals.set(signalKey, signal)
  accumulators.set(pairKey, accumulator)
}

function diceCoefficient(left: string, right: string): number {
  if (left === right) return 1
  const leftBigrams = bigrams(left)
  const rightBigrams = bigrams(right)
  if (leftBigrams.size === 0 || rightBigrams.size === 0) return 0
  let intersection = 0
  const remaining = new Map(rightBigrams)
  for (const [gram, count] of leftBigrams) {
    const matched = Math.min(count, remaining.get(gram) ?? 0)
    intersection += matched
    if (matched > 0) remaining.set(gram, (remaining.get(gram) ?? 0) - matched)
  }
  const leftCount = [...leftBigrams.values()].reduce((sum, count) => sum + count, 0)
  const rightCount = [...rightBigrams.values()].reduce((sum, count) => sum + count, 0)
  return (2 * intersection) / (leftCount + rightCount)
}

function bigrams(value: string): Map<string, number> {
  const compact = value.replace(/\s+/g, ' ')
  const output = new Map<string, number>()
  for (let index = 0; index < compact.length - 1; index += 1) {
    const gram = compact.slice(index, index + 2)
    output.set(gram, (output.get(gram) ?? 0) + 1)
  }
  return output
}

function recentTitleOverlap(left: EntityCatalogProfile, right: EntityCatalogProfile): number {
  let maximum = 0
  for (const leftMemory of left.recentMemories) {
    const leftTokens = titleTokens(leftMemory.title)
    if (leftTokens.size === 0) continue
    for (const rightMemory of right.recentMemories) {
      const rightTokens = titleTokens(rightMemory.title)
      if (rightTokens.size === 0) continue
      const union = new Set([...leftTokens, ...rightTokens])
      let intersection = 0
      for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1
      maximum = Math.max(maximum, intersection / union.size)
    }
  }
  return maximum
}

function titleTokens(value: string): Set<string> {
  return new Set(normalizedIdentity(value).split(' ').filter((token) => token.length > 2 && !STOP_WORDS.has(token)))
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000
}

function compareSignals(left: EntityCandidateSignal, right: EntityCandidateSignal): number {
  return left.kind.localeCompare(right.kind)
    || (left.label ?? '').localeCompare(right.label ?? '')
    || (right.score ?? 0) - (left.score ?? 0)
}
