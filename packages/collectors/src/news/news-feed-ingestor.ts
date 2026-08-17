import {
  fetchFeed,
  type NewsFeedItem,
  type NewsFeedMeta,
  type NewsFeedResult,
  type NewsFeedFetchOptions,
} from '@myboon/shared/news-feed'
import { ingestDiscoveredNewsCandidates } from './ingestion'
import type { NewsStore } from './store'
import type { NewsCandidate, NewsSourceDescriptor, NewsSourceEndpoint } from './types'

export type NewsFeedFetcher = (
  options?: NewsFeedFetchOptions,
) => Promise<NewsFeedResult<NewsFeedItem>>

export interface NewsFeedIngestionResult {
  feedItemsFetched: number
  articlesFetched: number
  postsFetched: number
  candidatesFound: number
  candidatesNew: number
  candidatesUnchanged: number
  candidatesMateriallyChanged: number
  candidatesInvalid: number
  candidateObservationsInserted: number
  meta: NewsFeedMeta
}

export const STRUCTURED_NEWS_FEED_URL: NewsSourceEndpoint = {
  urlId: 'feed',
  label: 'Structured News Feed',
  url: 'https://api.tokens.xyz/v1/news/feed',
}

export async function runNewsFeedIngestionOnce(input: {
  store: NewsStore
  fetcher?: NewsFeedFetcher
  now?: Date
}): Promise<NewsFeedIngestionResult> {
  const observedAt = (input.now ?? new Date()).toISOString()
  const feed = await (input.fetcher ?? fetchFeed)({ limit: 50 })
  const discoveries = feed.items.map((item) => ({
    source: newsFeedSource(item),
    sourceUrl: STRUCTURED_NEWS_FEED_URL,
    candidate: newsFeedItemToCandidate(item, observedAt),
    observedAt,
  }))
  const ingestion = await ingestDiscoveredNewsCandidates({
    store: input.store,
    discoveries,
  })

  return {
    feedItemsFetched: feed.items.length,
    articlesFetched: feed.items.filter((item) => item.kind === 'article').length,
    postsFetched: feed.items.filter((item) => item.kind === 'post').length,
    candidatesFound: ingestion.candidatesFound,
    candidatesNew: ingestion.candidatesNew,
    candidatesUnchanged: ingestion.candidatesUnchanged,
    candidatesMateriallyChanged: ingestion.candidatesMateriallyChanged,
    candidatesInvalid: ingestion.candidatesInvalid,
    candidateObservationsInserted: ingestion.candidateObservationsInserted,
    meta: feed.meta,
  }
}

export function newsFeedItemToCandidate(
  item: NewsFeedItem,
  observedAt: string,
): NewsCandidate {
  if (item.kind === 'article') {
    return {
      headline: item.title,
      article_url: item.url,
      ...(item.publishedAt ? { published_at: item.publishedAt } : {}),
      observed_at: observedAt,
      ...(item.author ? { author: item.author } : {}),
      content_kind: 'article',
      provider_id: 'tokens_xyz',
      ...(item.outlet ? { upstream_source_name: item.outlet } : {}),
      ...(item.imageUrl ? { image_url: item.imageUrl } : {}),
      related_coin_ids: [...item.relatedCoinIds],
    }
  }

  return {
    headline: item.text,
    article_url: item.url,
    ...(item.postedAt ? { published_at: item.postedAt } : {}),
    observed_at: observedAt,
    ...(item.handle ? { author: item.handle } : {}),
    section: 'social_post',
    content_kind: 'social_post',
    provider_id: 'tokens_xyz',
    ...(item.handle ? { upstream_source_name: item.handle } : {}),
    ...(item.imageUrl ? { image_url: item.imageUrl } : {}),
    related_coin_ids: [...item.relatedCoinIds],
  }
}

function newsFeedSource(item: NewsFeedItem): NewsSourceDescriptor {
  return item.kind === 'article'
    ? {
      sourceId: 'news_feed:articles',
      sourceName: item.outlet || 'Structured News Feed',
      sourceType: 'curated_news',
    }
    : {
      sourceId: 'news_feed:social',
      sourceName: item.handle || '@tokens',
      sourceType: 'curated_news',
    }
}
