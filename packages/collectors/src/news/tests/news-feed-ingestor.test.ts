import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  NewsFeedArticle,
  NewsFeedItem,
  NewsFeedResult,
} from '@myboon/shared/news-feed'
import { SqliteNewsStore } from '../sqlite-store'
import {
  runNewsFeedIngestionOnce,
  newsFeedItemToCandidate,
  type NewsFeedFetcher,
} from '../news-feed-ingestor'

const now = new Date('2026-08-15T10:00:00.000Z')

const items: NewsFeedItem[] = [{
  kind: 'post',
  text: 'BREAKING: A public filing names Bitcoin as a treasury asset.',
  url: 'https://x.com/tokens/status/123',
  postedAt: '2026-08-15T09:55:00.000Z',
  handle: '@tokens',
  imageUrl: 'https://pbs.twimg.com/media/example.jpg',
  relatedCoinIds: ['bitcoin'],
}, {
  kind: 'article',
  title: 'Bitcoin treasury filing appears in public records',
  url: 'https://example.com/bitcoin-filing?utm_source=tokens',
  publishedAt: '2026-08-15T09:50:00.000Z',
  outlet: 'Example News',
  author: 'Reporter',
  imageUrl: 'https://example.com/image.jpg',
  relatedCoinIds: ['bitcoin', 'could'],
}]

const feed: NewsFeedResult<NewsFeedItem> = {
  items,
  meta: {
    mode: 'global',
    terms: [],
    limit: 50,
    coingeckoCandidates: 1,
    xCandidates: 1,
  },
}

function fetcher(result = feed): NewsFeedFetcher {
  return async (options) => {
    assert.equal(options?.limit, 50)
    return result
  }
}

function withStore(fn: (store: SqliteNewsStore) => Promise<void>): Promise<void> {
  const store = new SqliteNewsStore(':memory:')
  return fn(store).finally(() => store.close())
}

test('collection persists articles and posts through the existing NewsStore contract', async () => {
  await withStore(async (store) => {
    const result = await runNewsFeedIngestionOnce({
      store,
      fetcher: fetcher(),
      now,
    })
    const pending = await store.fetchPendingCandidateObservations(10)

    assert.equal(result.candidateObservationsInserted, 2)
    assert.equal(pending.length, 2)

    const post = pending.find((candidate) => candidate.sourceId === 'news_feed:social')
    assert.equal(post?.sourceName, '@tokens')
    assert.equal(post?.rawCandidate.content_kind, 'social_post')
    assert.equal(post?.rawCandidate.provider_id, 'tokens_xyz')
    assert.equal(post?.rawCandidate.image_url, 'https://pbs.twimg.com/media/example.jpg')

    const article = pending.find((candidate) => candidate.sourceId === 'news_feed:articles')
    assert.equal(article?.sourceName, 'Example News')
    assert.equal(article?.canonicalArticleUrl, 'https://example.com/bitcoin-filing')
    assert.equal(article?.rawCandidate.content_kind, 'article')
    assert.equal(article?.rawCandidate.provider_id, 'tokens_xyz')
    assert.deepEqual(article?.rawCandidate.related_coin_ids, ['bitcoin', 'could'])
  })
})

test('replaying the same feed does not create duplicate observations', async () => {
  await withStore(async (store) => {
    await runNewsFeedIngestionOnce({ store, fetcher: fetcher(), now })
    const replay = await runNewsFeedIngestionOnce({
      store,
      fetcher: fetcher(),
      now: new Date('2026-08-15T10:10:00.000Z'),
    })

    assert.equal(replay.candidatesUnchanged, 2)
    assert.equal(replay.candidateObservationsInserted, 0)
    assert.equal((await store.fetchPendingCandidateObservations(10)).length, 2)
  })
})

test('one feed response keeps only the preferred candidate for a duplicated canonical URL', async () => {
  await withStore(async (store) => {
    const duplicateFeed: NewsFeedResult<NewsFeedItem> = {
      ...feed,
      items: [{
        kind: 'article',
        title: '同一篇文章的标题',
        url: 'https://example.com/same-article',
        publishedAt: '2026-08-15T09:50:00.000Z',
        outlet: 'Example News',
        author: null,
        imageUrl: null,
        relatedCoinIds: [],
      }, {
        kind: 'article',
        title: 'The same article in English',
        url: 'https://example.com/same-article?utm_source=feed',
        publishedAt: '2026-08-15T09:50:00.000Z',
        outlet: 'Example News',
        author: null,
        imageUrl: 'https://example.com/preferred.jpg',
        relatedCoinIds: [],
      }],
    }

    const result = await runNewsFeedIngestionOnce({
      store,
      fetcher: fetcher(duplicateFeed),
      now,
    })
    const pending = await store.fetchPendingCandidateObservations(10)

    assert.equal(result.candidatesFound, 2)
    assert.equal(result.candidatesNew, 1)
    assert.equal(result.candidatesUnchanged, 1)
    assert.equal(result.candidateObservationsInserted, 1)
    assert.equal(pending[0].headline, 'The same article in English')
    assert.equal(pending[0].rawCandidate.image_url, 'https://example.com/preferred.jpg')
  })
})

test('later feed metadata changes do not create another research candidate for the same URL', async () => {
  await withStore(async (store) => {
    const firstArticle: NewsFeedArticle = {
      kind: 'article',
      title: 'COINDESK: Bitcoin ETF inflows rise',
      url: 'https://example.com/bitcoin-etf',
      publishedAt: '2026-08-15T09:50:00.000Z',
      outlet: 'Tree News',
      author: null,
      imageUrl: null,
      relatedCoinIds: ['bitcoin'],
    }
    const firstFeed: NewsFeedResult<NewsFeedItem> = {
      ...feed,
      items: [firstArticle],
    }
    const laterFeed: NewsFeedResult<NewsFeedItem> = {
      ...feed,
      items: [{
        ...firstArticle,
        title: 'Bitcoin ETF inflows rise',
        outlet: 'CoinDesk',
        imageUrl: 'https://example.com/bitcoin-etf.jpg',
      }],
    }

    await runNewsFeedIngestionOnce({ store, fetcher: fetcher(firstFeed), now })
    const replay = await runNewsFeedIngestionOnce({
      store,
      fetcher: fetcher(laterFeed),
      now: new Date('2026-08-15T10:10:00.000Z'),
    })

    assert.equal(replay.candidatesUnchanged, 1)
    assert.equal(replay.candidatesMateriallyChanged, 0)
    assert.equal(replay.candidateObservationsInserted, 0)
    assert.equal((await store.fetchPendingCandidateObservations(10)).length, 1)
  })
})

test('post mapping retains social kind and untrusted hints in raw candidate data', () => {
  const candidate = newsFeedItemToCandidate(items[0], now.toISOString())

  assert.equal(candidate.content_kind, 'social_post')
  assert.equal(candidate.section, 'social_post')
  assert.equal(candidate.author, '@tokens')
  assert.equal(candidate.provider_id, 'tokens_xyz')
  assert.deepEqual(candidate.related_coin_ids, ['bitcoin'])
})
