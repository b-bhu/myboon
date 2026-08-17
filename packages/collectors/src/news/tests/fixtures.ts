import type { NewsCandidate, NewsSourceDescriptor, NewsSourceEndpoint } from '../types'

export const TEST_NEWS_SOURCE_URL: NewsSourceEndpoint = {
  urlId: 'feed',
  label: 'Structured News Feed',
  url: 'https://api.tokens.xyz/v1/news/feed',
}

export const TEST_NEWS_SOURCE: NewsSourceDescriptor = {
  sourceId: 'news_feed:articles',
  sourceName: 'CoinDesk',
  sourceType: 'curated_news',
}

export function testNewsCandidate(overrides: Partial<NewsCandidate> = {}): NewsCandidate {
  return {
    headline: 'CoinDesk observes BTC treasury flows',
    article_url: 'https://www.coindesk.com/markets/2026/07/04/btc-treasury-flows?utm_source=x',
    summary: 'Observed article summary.',
    published_at: '2026-07-04T11:00:00.000Z',
    observed_at: '2026-07-04T12:00:00.000Z',
    author: 'CoinDesk Staff',
    content_kind: 'article',
    provider_id: 'tokens_xyz',
    upstream_source_name: 'CoinDesk',
    evidence: ['visible article card'],
    ...overrides,
  }
}
