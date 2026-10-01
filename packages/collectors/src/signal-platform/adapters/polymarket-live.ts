import { canonicalJson } from '../canonical-json'
import {
  SIGNAL_SCHEMA_VERSION,
  type PolymarketSignal,
} from '../contracts'
import { validateSignal } from '../validation'
import { stableContractId } from './identity'

export interface PolymarketLiveSignalInput {
  observedAt: string
  area: string
  market: {
    marketId: string
    slug: string
    title: string
    tagSlug: string
    tagLabel: string | null
    endDate: string | null
    sourceUpdatedAt: string | null
  }
  observation: {
    candidateType: string
    whatChanged: string
    whyFlagged: string
    score: number
    scoreBreakdown: Record<string, number | string | boolean>
    metrics: Record<string, number | string | boolean | null>
    evidenceRefs: Array<Record<string, string | null>>
  }
}

/**
 * Adapts one material market observation rather than a mutable legacy thread.
 * Identity uses the upstream market update time plus canonical material facts,
 * not the local polling clock. Unchanged re-polls therefore dedupe, while a
 * source-native update or changed material facts remains addressable.
 */
export function adaptLivePolymarketSignal(input: PolymarketLiveSignalInput): PolymarketSignal {
  const materialFacts = canonicalJson({
    marketId: input.market.marketId,
    slug: input.market.slug,
    title: input.market.title,
    tagSlug: input.market.tagSlug,
    tagLabel: input.market.tagLabel,
    endDate: input.market.endDate,
    sourceUpdatedAt: input.market.sourceUpdatedAt,
    observation: {
      candidateType: input.observation.candidateType,
      whatChanged: input.observation.whatChanged,
      whyFlagged: input.observation.whyFlagged,
      score: input.observation.score,
      scoreBreakdown: input.observation.scoreBreakdown,
      metrics: withoutPollTimes(input.observation.metrics),
      evidenceRefs: stableEvidenceRefs(input.observation.evidenceRefs, input.market.sourceUpdatedAt),
    },
  })
  const materialFingerprint = stableContractId('market_material', materialFacts)
  const materialObservedAt = input.market.sourceUpdatedAt ?? input.observedAt
  const observationIdentity = stableContractId(
    'polymarket_observation',
    input.market.marketId,
    input.market.sourceUpdatedAt ?? 'upstream_revision_unavailable',
    materialFingerprint,
  )
  return validateSignal({
    schemaVersion: SIGNAL_SCHEMA_VERSION,
    signalId: stableContractId('sig', 'polymarket', observationIdentity),
    sourceType: 'polymarket',
    contentKind: 'market_event',
    content: {
      schemaVersion: 'myboon.signal_content.market_event.v1',
      marketId: input.market.marketId,
      slug: input.market.slug,
      candidateType: input.observation.candidateType,
      whatChanged: input.observation.whatChanged,
      whyFlagged: input.observation.whyFlagged,
      score: input.observation.score,
      scoreBreakdown: input.observation.scoreBreakdown,
      metrics: withoutPollTimes(input.observation.metrics),
      evidenceRefs: stableEvidenceRefs(input.observation.evidenceRefs, input.market.sourceUpdatedAt),
      materialFingerprint,
    },
    sourceId: `polymarket:market:${input.market.marketId}`,
    observedAt: materialObservedAt,
    publishedAt: null,
    canonicalUrl: `https://polymarket.com/event/${encodeURIComponent(input.market.slug)}`,
    title: input.market.title,
    visibleSummary: input.observation.whatChanged,
    media: { imageUrl: null, attribution: null },
    sourceHints: {
      entities: [],
      assets: [],
      eventId: input.market.marketId,
      deadline: input.market.endDate,
    },
    provenance: {
      provider: 'polymarket',
      upstreamSource: input.area,
      rawPayloadRef: `pipeline_watchlist:${input.area}:${input.market.slug}:${observationIdentity}`,
    },
    idempotencyKey: observationIdentity,
  }) as PolymarketSignal
}

/** Poll clocks describe when we saw a row, not a new source-material version. */
function withoutPollTimes(
  metrics: Record<string, number | string | boolean | null>,
): Record<string, number | string | boolean | null> {
  return Object.fromEntries(Object.entries(metrics).filter(([key]) => (
    key !== 'currentObservedAt' && key !== 'previousObservedAt'
  )))
}

/** Keep evidence identity stable across polls while retaining upstream revision time when available. */
function stableEvidenceRefs(
  evidenceRefs: Array<Record<string, string | null>>,
  sourceUpdatedAt: string | null,
): Array<Record<string, string | null>> {
  return evidenceRefs.map((reference) => {
    const stable: Record<string, string | null> = {}
    for (const [key, value] of Object.entries(reference)) {
      if (key !== 'observed_at' && key !== 'observedAt') stable[key] = value
    }
    if ('observed_at' in reference) stable.observed_at = sourceUpdatedAt
    if ('observedAt' in reference) stable.observedAt = sourceUpdatedAt
    return stable
  })
}
