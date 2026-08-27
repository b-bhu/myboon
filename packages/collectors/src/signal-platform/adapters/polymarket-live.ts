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
    candidateType: input.observation.candidateType,
    whatChanged: input.observation.whatChanged,
    score: input.observation.score,
    metrics: input.observation.metrics,
  })
  const materialFingerprint = stableContractId('market_material', materialFacts)
  const materialObservedAt = input.market.sourceUpdatedAt ?? input.observedAt
  const observationIdentity = stableContractId(
    'polymarket_observation', input.market.marketId, materialObservedAt, materialFingerprint,
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
      metrics: input.observation.metrics,
      evidenceRefs: input.observation.evidenceRefs,
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
      rawPayloadRef: `pipeline_watchlist:${input.area}:${input.market.slug}:${materialObservedAt}`,
    },
    idempotencyKey: observationIdentity,
  }) as PolymarketSignal
}
