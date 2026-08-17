import { classifyNewsCandidate } from './dedupe'
import { canonicalArticleUrl } from './fingerprint'
import type {
  NewsCandidateObservationInput,
  NewsCandidateObservationRow,
  NewsStore,
} from './store'
import type {
  NewsCandidateDedupeDecision,
  NewsCandidate,
  NewsSourceDescriptor,
  NewsSourceEndpoint,
  PriorNewsObservation,
} from './types'

export interface DiscoveredNewsCandidate {
  source: NewsSourceDescriptor
  sourceUrl: NewsSourceEndpoint
  candidate: NewsCandidate
  observedAt: string
}

export interface IngestDiscoveredNewsCandidatesResult {
  candidatesFound: number
  candidatesNew: number
  candidatesUnchanged: number
  candidatesMateriallyChanged: number
  candidatesInvalid: number
  candidateObservationsInserted: number
  decisions: Array<{
    discovery: DiscoveredNewsCandidate
    decision: NewsCandidateDedupeDecision
  }>
  inserted: NewsCandidateObservationRow[]
}

/**
 * Provider-neutral handoff between structured discovery and the existing
 * NewsStore. A canonical source URL is the stable research identity.
 */
export async function ingestDiscoveredNewsCandidates(input: {
  store: NewsStore
  discoveries: DiscoveredNewsCandidate[]
}): Promise<IngestDiscoveredNewsCandidatesResult> {
  const priorBySource = await fetchPriorBySource(input.store, input.discoveries)
  const stableIdentityWinners = preferredStableIdentityIndexes(input.discoveries)
  const decisions = input.discoveries.map((discovery, index) => {
    const decision = classifyNewsCandidate(
      discovery.source.sourceId,
      discovery.sourceUrl.urlId,
      discovery.candidate,
      priorBySource.get(discovery.source.sourceId) ?? [],
    )
    if (
      decision.fingerprint
      && !stableIdentityWinners.has(index)
    ) {
      return {
        discovery,
        decision: {
          ...decision,
          outcome: 'known_unchanged' as const,
          reason: 'duplicate canonical URL suppressed within the same discovery batch',
        },
      }
    }
    return { discovery, decision }
  })

  const insertInputs: NewsCandidateObservationInput[] = decisions
    .filter(({ decision }) => decision.fingerprint && (
      decision.outcome === 'new_candidate'
      || decision.outcome === 'known_materially_changed'
    ))
    .map(({ discovery, decision }) => ({
      source: discovery.source,
      sourceUrl: discovery.sourceUrl,
      candidate: discovery.candidate,
      fingerprint: decision.fingerprint!,
      dedupeOutcome: decision.outcome as 'new_candidate' | 'known_materially_changed',
      observedAt: discovery.observedAt,
    }))

  const inserted = await input.store.insertCandidateObservations(insertInputs)

  return {
    candidatesFound: decisions.length,
    candidatesNew: decisions.filter(({ decision }) => decision.outcome === 'new_candidate').length,
    candidatesUnchanged: decisions.filter(({ decision }) => decision.outcome === 'known_unchanged').length,
    candidatesMateriallyChanged: decisions.filter(({ decision }) => decision.outcome === 'known_materially_changed').length,
    candidatesInvalid: decisions.filter(({ decision }) => decision.outcome === 'ignored_invalid_candidate').length,
    candidateObservationsInserted: inserted.length,
    decisions,
    inserted,
  }
}

function preferredStableIdentityIndexes(discoveries: DiscoveredNewsCandidate[]): Set<number> {
  const preferredByIdentity = new Map<string, { index: number, score: number }>()
  for (let index = 0; index < discoveries.length; index += 1) {
    const discovery = discoveries[index]
    let canonicalUrl: string
    try {
      canonicalUrl = canonicalArticleUrl(discovery.candidate.article_url)
    } catch {
      continue
    }
    const identity = `${discovery.source.sourceId}:${canonicalUrl}`
    const score = stableCandidatePreference(discovery.candidate)
    const current = preferredByIdentity.get(identity)
    if (!current || score > current.score) {
      preferredByIdentity.set(identity, { index, score })
    }
  }
  return new Set([...preferredByIdentity.values()].map(({ index }) => index))
}

function stableCandidatePreference(candidate: NewsCandidate): number {
  const headline = typeof candidate.headline === 'string' ? candidate.headline.trim() : ''
  let score = headline ? 100 : 0
  if (candidate.image_url?.trim()) score += 20
  if (candidate.summary?.trim()) score += 5

  // When one canonical URL is returned in multiple languages, prefer the
  // predominantly ASCII variant because the current research/editor prompts
  // and product feed are English-first. A few curly quotes do not disqualify
  // an otherwise readable headline.
  if (headline) {
    const nonAscii = [...headline].filter((character) => character.codePointAt(0)! > 127).length
    if (nonAscii / [...headline].length <= 0.15) score += 10
    if (!/^[A-Z][A-Z0-9 .&'’-]{2,30}:\s/.test(headline)) score += 2
  }
  return score
}

async function fetchPriorBySource(
  store: NewsStore,
  discoveries: DiscoveredNewsCandidate[],
): Promise<Map<string, PriorNewsObservation[]>> {
  const urlsBySource = new Map<string, Set<string>>()
  for (const discovery of discoveries) {
    let canonicalUrl: string
    try {
      canonicalUrl = canonicalArticleUrl(discovery.candidate.article_url)
    } catch {
      continue
    }
    const urls = urlsBySource.get(discovery.source.sourceId) ?? new Set<string>()
    urls.add(canonicalUrl)
    urlsBySource.set(discovery.source.sourceId, urls)
  }

  const entries = await Promise.all([...urlsBySource.entries()].map(async ([sourceId, urls]) => (
    [sourceId, await store.fetchPriorObservations(sourceId, [...urls])] as const
  )))
  return new Map(entries)
}
