import type { DiscoveredNewsCandidate } from '../../news/ingestion'
import type { NewsCandidateFingerprint } from '../../news/types'
import { SIGNAL_SCHEMA_VERSION, type NewsSignal } from '../contracts'
import { validateSignal } from '../validation'
import { stableContractId } from './identity'

export interface NewsLiveSignalInput {
  discovery: DiscoveredNewsCandidate
  fingerprint: NewsCandidateFingerprint
  materialChange: boolean
}

/** Adapts a live immutable observation without changing the legacy queue. */
export function adaptLiveNewsSignal(input: NewsLiveSignalInput): NewsSignal {
  const { discovery, fingerprint } = input
  const candidate = discovery.candidate
  return validateSignal({
    schemaVersion: SIGNAL_SCHEMA_VERSION,
    signalId: stableContractId('sig', 'news', fingerprint.observationDedupeKey),
    sourceType: 'news',
    contentKind: 'article',
    content: {
      schemaVersion: 'myboon.signal_content.article.v1',
      author: candidate.author ?? null,
      section: candidate.section ?? null,
      legacyContentKind: candidate.content_kind ?? 'article',
      headlineHash: fingerprint.headlineHash,
      summaryHash: fingerprint.summaryHash,
      contentHash: fingerprint.contentHash,
      materialChange: input.materialChange,
    },
    sourceId: fingerprint.articleIdentityKey,
    observedAt: discovery.observedAt,
    publishedAt: candidate.published_at ?? null,
    canonicalUrl: fingerprint.canonicalArticleUrl,
    title: candidate.headline,
    visibleSummary: candidate.summary?.trim() || null,
    media: { imageUrl: candidate.image_url ?? null, attribution: candidate.author ?? null },
    sourceHints: {
      entities: [], assets: candidate.related_coin_ids ?? [], eventId: null, deadline: null,
    },
    provenance: {
      provider: candidate.provider_id ?? 'legacy_news',
      upstreamSource: candidate.upstream_source_name ?? discovery.source.sourceName,
      rawPayloadRef: `news_discovery:${discovery.source.sourceId}:${discovery.sourceUrl.urlId}:${fingerprint.observationDedupeKey}`,
    },
    idempotencyKey: fingerprint.observationDedupeKey,
    migration: {
      legacyQueueMutation: false,
      limitations: candidate.content_kind === 'social_post'
        ? ['live_social_post_retained_as_article_until_x_source_migration'] : [],
    },
  }) as NewsSignal
}
