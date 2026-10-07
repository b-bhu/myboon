import { classifyNewsCandidate } from './dedupe'
import { canonicalArticleUrl } from './fingerprint'
import { adaptLiveNewsSignal } from '../signal-platform/adapters/news-live'
import {
  deliverCanonicalSignals,
  type SourceIntakeBatchReport,
  type SourceSignalIntakePort,
} from '../signal-platform/source-intake'
import type { Signal } from '../signal-platform/contracts'
import {
  drainSourceDeliveries,
  emptySourceDeliveryDrainReport,
  mergeSourceDeliveryDrainReports,
  type SourceDeliveryDrainReport,
} from '../signal-platform/source-delivery-outbox'
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
  canonicalIntake: SourceIntakeBatchReport
  delivery: SourceDeliveryDrainReport
  /** Obligations drained before the new feed was processed. */
  drainedBeforeFeed: SourceDeliveryDrainReport
}

/**
 * Provider-neutral handoff between structured discovery and the existing
 * NewsStore. A canonical source URL is the stable research identity.
 */
export async function ingestDiscoveredNewsCandidates(input: {
  store: NewsStore
  discoveries: DiscoveredNewsCandidate[]
  signalIntake?: SourceSignalIntakePort
}): Promise<IngestDiscoveredNewsCandidatesResult> {
  const intakeEnabled = input.signalIntake !== undefined && input.signalIntake.mode !== 'off'
  const retainSourceObservations = intakeEnabled || input.store.allowsLegacyQueueAdmission?.() === false
  // Older pending obligations are settled before the new feed is classified,
  // so a failed earlier delivery can never be hidden behind a fresh poll.
  const drainedBeforeFeed = intakeEnabled
    ? await drainSourceDeliveries({ store: input.store, intake: input.signalIntake! })
    : emptySourceDeliveryDrainReport()

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

  // The adapted Signal is derived before the insert so it can be persisted as
  // an obligation in the same transaction as its observation row.
  const signalByDedupeKey = new Map<string, Signal>()
  decisions.forEach(({ discovery, decision }, index) => {
    const fingerprint = decision.fingerprint
    if (!fingerprint || !stableIdentityWinners.has(index)) return
    const matchingPrior = (priorBySource.get(discovery.source.sourceId) ?? []).filter((prior) => (
      prior.articleIdentityKey === fingerprint.articleIdentityKey
    ))
    const exact = matchingPrior.some((prior) => (
      prior.headlineHash === fingerprint.headlineHash && prior.summaryHash === fingerprint.summaryHash
    ))
    if (exact) return
    signalByDedupeKey.set(
      fingerprint.observationDedupeKey,
      adaptLiveNewsSignal({
        discovery,
        fingerprint,
        materialChange: matchingPrior.length > 0,
      }),
    )
  })

  const insertInputs: NewsCandidateObservationInput[] = decisions
    .filter(({ decision }) => decision.fingerprint && (
      decision.outcome === 'new_candidate'
      || decision.outcome === 'known_materially_changed'
    ))
    .map(({ discovery, decision }) => {
      const fingerprint = decision.fingerprint!
      // Off intake enqueues nothing; observe/active owes every persisted
      // observation a delivery obligation.
      const deliverySignal = retainSourceObservations ? signalByDedupeKey.get(fingerprint.observationDedupeKey) : undefined
      return {
        source: discovery.source,
        sourceUrl: discovery.sourceUrl,
        candidate: discovery.candidate,
        fingerprint,
        dedupeOutcome: decision.outcome as 'new_candidate' | 'known_materially_changed',
        observedAt: discovery.observedAt,
        ...(deliverySignal ? { deliverySignal } : {}),
      }
    })

  const inserted = await input.store.insertCandidateObservations(insertInputs)
  const atomicallyRecordedDeliveryKeys = new Set(
    insertInputs
      .filter((candidate) => candidate.deliverySignal)
      .map((candidate) => candidate.fingerprint.observationDedupeKey),
  )
  // Some material source observations are intentionally not new legacy
  // research candidates (legacy dedupe has broader semantics than V4's
  // immutable source identity). Persist those payloads as source observations
  // in their own local outbox transaction so they are not silently discarded.
  if (retainSourceObservations) {
    await input.store.insertSourceDeliveryObservations(
      [...signalByDedupeKey.entries()]
        .filter(([dedupeKey]) => !atomicallyRecordedDeliveryKeys.has(dedupeKey))
        .map(([, signal]) => ({ signal, observedAt: signal.observedAt })),
    )
  }
  // Newly inserted obligations are delivered from the frozen payloads the
  // store just committed, not from a reconstruction of this poll.
  const delivery = intakeEnabled
    ? await drainSourceDeliveries({
      store: input.store,
      intake: input.signalIntake!,
      skipSignalIds: new Set(drainedBeforeFeed.failures.map((failure) => failure.signalId)),
    })
    : emptySourceDeliveryDrainReport()
  const canonicalIntake = await deliverCanonicalSignals(input.signalIntake, [])

  return {
    candidatesFound: decisions.length,
    candidatesNew: decisions.filter(({ decision }) => decision.outcome === 'new_candidate').length,
    candidatesUnchanged: decisions.filter(({ decision }) => decision.outcome === 'known_unchanged').length,
    candidatesMateriallyChanged: decisions.filter(({ decision }) => decision.outcome === 'known_materially_changed').length,
    candidatesInvalid: decisions.filter(({ decision }) => decision.outcome === 'ignored_invalid_candidate').length,
    candidateObservationsInserted: inserted.length,
    decisions,
    inserted,
    canonicalIntake: mergeDeliveryIntoIntakeReport(canonicalIntake, drainedBeforeFeed, delivery),
    delivery: mergeSourceDeliveryDrainReports(emptySourceDeliveryDrainReport(), drainedBeforeFeed, delivery),
    drainedBeforeFeed,
  }
}

/**
 * Delivery now flows through the durable outbox, so the legacy canonical
 * report is derived from drain outcomes rather than from direct delivery.
 */
function mergeDeliveryIntoIntakeReport(
  report: SourceIntakeBatchReport,
  ...drains: SourceDeliveryDrainReport[]
): SourceIntakeBatchReport {
  const merged = mergeSourceDeliveryDrainReports(emptySourceDeliveryDrainReport(), ...drains)
  report.attempted += merged.attempted
  report.insertedSignals += merged.delivered
  report.duplicateSignals += merged.duplicateDeliveries
  report.insertedDecisions += merged.insertedDecisions
  report.admittedWorkItems += merged.admittedWorkItems
  report.failures.push(...merged.failures.map((failure) => ({
    signalId: failure.signalId,
    sourceType: failure.sourceType,
    code: 'CANONICAL_SIGNAL_INTAKE_FAILED' as const,
  })))
  return report
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
