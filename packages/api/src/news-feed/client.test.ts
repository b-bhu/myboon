import assert from 'node:assert/strict'
import test from 'node:test'
import {
  NEWS_FEED_MAX_LIMIT,
  NewsFeedError,
  fetchArticles,
  fetchFeed,
  fetchPosts,
} from './client.js'

const API_KEY = 'test-key'

/** A real CoinGecko-half item, trimmed from a live 2026-08-13 response. */
const ARTICLE_ITEM = {
  title: 'Bitcoin shows early signs of bottom despite lingering market stress',
  url: 'https://www.fxstreet.com/cryptocurrencies/news/bitcoin-shows-early-signs',
  image: 'https://assets.coingecko.com/articles/images/108111529/large/open-uri.png',
  author: '',
  posted_at: '2026-08-12T23:17:40Z',
  type: 'news',
  source_name: 'FXStreet',
  related_coin_ids: ['bitcoin'],
  feed_source: 'coingecko',
}

/** A real X-half item, trimmed from the same response. */
const POST_ITEM = {
  title: 'JUST IN: The SEC is reportedly preparing to unveil an innovation exemption.',
  url: 'https://x.com/tokens/status/2087674305119400055',
  image: 'https://pbs.twimg.com/profile_images/2032113495899250688/y28Aaesb_normal.jpg',
  author: 'tokens',
  posted_at: '2026-08-12T22:55:16.000Z',
  type: 'news',
  source_name: '@tokens',
  related_coin_ids: [],
  feed_source: 'x',
}

function feedResponse(items: unknown[], meta: Record<string, unknown> = {}) {
  return {
    items,
    meta: {
      mode: 'global',
      source: 'news',
      coin_id: null,
      terms: [],
      limit: 10,
      tweet_reserve: 3,
      counts: { items: items.length, coingecko_candidates: items.length, x_candidates: 0 },
      ...meta,
    },
  }
}

function stubFetch(body: unknown, onCall?: (url: string, init?: RequestInit) => void) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    onCall?.(String(input), init)
    return Response.json(body)
  }) as typeof fetch
}

function failingFetch(status: number, onCall?: () => void) {
  return (async () => {
    onCall?.()
    return new Response('upstream said no', { status })
  }) as typeof fetch
}

test('normalizes an article into our shape', async () => {
  const result = await fetchArticles({
    apiKey: API_KEY,
    fetchImpl: stubFetch(feedResponse([ARTICLE_ITEM])),
  })

  assert.equal(result.items.length, 1)
  assert.deepEqual(result.items[0], {
    kind: 'article',
    title: 'Bitcoin shows early signs of bottom despite lingering market stress',
    url: 'https://www.fxstreet.com/cryptocurrencies/news/bitcoin-shows-early-signs',
    publishedAt: '2026-08-12T23:17:40.000Z',
    outlet: 'FXStreet',
    author: null, // upstream sent '' — an empty author is absent, not blank
    imageUrl: 'https://assets.coingecko.com/articles/images/108111529/large/open-uri.png',
    relatedCoinIds: ['bitcoin'],
  })
})

test('normalizes a post into our shape', async () => {
  const result = await fetchPosts({
    apiKey: API_KEY,
    fetchImpl: stubFetch(feedResponse([POST_ITEM])),
  })

  assert.equal(result.items.length, 1)
  assert.deepEqual(result.items[0], {
    kind: 'post',
    text: 'JUST IN: The SEC is reportedly preparing to unveil an innovation exemption.',
    url: 'https://x.com/tokens/status/2087674305119400055',
    postedAt: '2026-08-12T22:55:16.000Z',
    handle: '@tokens',
    imageUrl: 'https://pbs.twimg.com/profile_images/2032113495899250688/y28Aaesb_normal.jpg',
    relatedCoinIds: [],
  })
})

test('fetches the blended feed and preserves article/post order', async () => {
  let url = ''
  const result = await fetchFeed({
    apiKey: API_KEY,
    fetchImpl: stubFetch(
      feedResponse([POST_ITEM, ARTICLE_ITEM], {
        source: 'all',
        counts: { items: 2, coingecko_candidates: 1, x_candidates: 1 },
      }),
      (called) => { url = called },
    ),
  })

  assert.match(url, /source=all/)
  assert.deepEqual(result.items.map((item) => item.kind), ['post', 'article'])
  assert.equal(result.meta.coingeckoCandidates, 1)
  assert.equal(result.meta.xCandidates, 1)
})

test('the blended feed drops unknown feed sources instead of guessing a shape', async () => {
  const result = await fetchFeed({
    apiKey: API_KEY,
    fetchImpl: stubFetch(feedResponse([
      ARTICLE_ITEM,
      { ...ARTICLE_ITEM, feed_source: 'something-new' },
    ])),
  })

  assert.deepEqual(result.items.map((item) => item.kind), ['article'])
})

test('both halves normalize posted_at to the same ISO form', async () => {
  // CoinGecko sends '...Z', X sends '....000Z'. Downstream fingerprints must
  // not have to know which half an item came from.
  const articles = await fetchArticles({
    apiKey: API_KEY,
    fetchImpl: stubFetch(feedResponse([ARTICLE_ITEM])),
  })
  const posts = await fetchPosts({
    apiKey: API_KEY,
    fetchImpl: stubFetch(feedResponse([POST_ITEM])),
  })

  for (const stamp of [articles.items[0]?.publishedAt, posts.items[0]?.postedAt]) {
    assert.match(String(stamp), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  }
})

test('an unparseable timestamp becomes null rather than a fabricated date', async () => {
  const result = await fetchArticles({
    apiKey: API_KEY,
    fetchImpl: stubFetch(feedResponse([{ ...ARTICLE_ITEM, posted_at: 'sometime tuesday' }])),
  })

  assert.equal(result.items[0]?.publishedAt, null)
})

test('articles exclude X items even if the upstream sends them', async () => {
  const result = await fetchArticles({
    apiKey: API_KEY,
    fetchImpl: stubFetch(feedResponse([ARTICLE_ITEM, POST_ITEM])),
  })

  assert.equal(result.items.length, 1)
  assert.equal(result.items[0]?.kind, 'article')
})

test('posts exclude CoinGecko items even if the upstream sends them', async () => {
  const result = await fetchPosts({
    apiKey: API_KEY,
    fetchImpl: stubFetch(feedResponse([ARTICLE_ITEM, POST_ITEM])),
  })

  assert.equal(result.items.length, 1)
  assert.equal(result.items[0]?.kind, 'post')
})

test('drops items with no title or no url', async () => {
  const result = await fetchArticles({
    apiKey: API_KEY,
    fetchImpl: stubFetch(
      feedResponse([
        ARTICLE_ITEM,
        { ...ARTICLE_ITEM, title: '' },
        { ...ARTICLE_ITEM, url: '   ' },
        { ...ARTICLE_ITEM, title: undefined },
      ]),
    ),
  })

  assert.equal(result.items.length, 1)
})

test('sends source=news for articles and source=tweets for posts', async () => {
  let articleUrl = ''
  await fetchArticles({ apiKey: API_KEY, fetchImpl: stubFetch(feedResponse([]), (url) => { articleUrl = url }) })
  assert.match(articleUrl, /source=news/)

  let postUrl = ''
  await fetchPosts({ apiKey: API_KEY, fetchImpl: stubFetch(feedResponse([]), (url) => { postUrl = url }) })
  assert.match(postUrl, /source=tweets/)
})

test('NEWS_FEED_API_BASE accepts a base that already ends in /v1', async () => {
  const previous = process.env.NEWS_FEED_API_BASE
  process.env.NEWS_FEED_API_BASE = 'https://news-feed.test/v1/'
  try {
    let url = ''
    await fetchFeed({
      apiKey: API_KEY,
      fetchImpl: stubFetch(feedResponse([]), (called) => { url = called }),
    })
    assert.match(url, /^https:\/\/news-feed\.test\/v1\/news\/feed\?/)
    assert.doesNotMatch(url, /\/v1\/v1\//)
  } finally {
    if (previous == null) delete process.env.NEWS_FEED_API_BASE
    else process.env.NEWS_FEED_API_BASE = previous
  }
})

test('sends the api key as x-api-key', async () => {
  let seen: RequestInit | undefined
  await fetchArticles({
    apiKey: API_KEY,
    fetchImpl: stubFetch(feedResponse([]), (_url, init) => { seen = init }),
  })

  const headers = seen?.headers as Record<string, string>
  assert.equal(headers['x-api-key'], API_KEY)
})

test('clamps limit to the upstream ceiling instead of asking for more', async () => {
  let url = ''
  await fetchArticles({
    apiKey: API_KEY,
    limit: 500,
    fetchImpl: stubFetch(feedResponse([]), (called) => { url = called }),
  })

  assert.match(url, new RegExp(`limit=${NEWS_FEED_MAX_LIMIT}`))
})

test('clamps a below-range limit up to 1', async () => {
  let url = ''
  await fetchArticles({
    apiKey: API_KEY,
    limit: 0,
    fetchImpl: stubFetch(feedResponse([]), (called) => { url = called }),
  })

  assert.match(url, /limit=1/)
})

test('sends token filters and joins terms with commas', async () => {
  let url = ''
  await fetchArticles({
    apiKey: API_KEY,
    coinId: 'bitcoin',
    symbol: 'BTC',
    name: 'Bitcoin',
    terms: ['halving', ' etf ', ''],
    fetchImpl: stubFetch(feedResponse([]), (called) => { url = called }),
  })

  const query = new URLSearchParams(url.split('?')[1])
  assert.equal(query.get('coin_id'), 'bitcoin')
  assert.equal(query.get('symbol'), 'BTC')
  assert.equal(query.get('name'), 'Bitcoin')
  assert.equal(query.get('terms'), 'halving,etf')
})

test('omits token filters entirely when none are given', async () => {
  let url = ''
  await fetchArticles({ apiKey: API_KEY, fetchImpl: stubFetch(feedResponse([]), (called) => { url = called }) })

  const query = new URLSearchParams(url.split('?')[1])
  assert.equal(query.get('coin_id'), null)
  assert.equal(query.get('terms'), null)
})

test('surfaces upstream meta so an empty filter result is distinguishable', async () => {
  const result = await fetchArticles({
    apiKey: API_KEY,
    coinId: 'bitcoin',
    fetchImpl: stubFetch(
      feedResponse([], {
        mode: 'token',
        terms: ['Bitcoin', 'BTC'],
        limit: 5,
        counts: { items: 0, coingecko_candidates: 0, x_candidates: 0 },
      }),
    ),
  })

  assert.equal(result.items.length, 0)
  assert.equal(result.meta.mode, 'token')
  assert.deepEqual(result.meta.terms, ['Bitcoin', 'BTC'])
  assert.equal(result.meta.limit, 5)
})

test('throws rather than returning an empty feed when the key is missing', async () => {
  const previousProviderKey = process.env.TOKENS_API_KEY
  delete process.env.TOKENS_API_KEY
  try {
    await assert.rejects(
      () => fetchArticles({ fetchImpl: stubFetch(feedResponse([])) }),
      (error: unknown) => error instanceof NewsFeedError && /TOKENS_API_KEY/.test((error as Error).message),
    )
  } finally {
    if (previousProviderKey != null) process.env.TOKENS_API_KEY = previousProviderKey
  }
})

test('does not retry a 4xx — it will fail identically every time', async () => {
  let calls = 0
  await assert.rejects(
    () => fetchArticles({ apiKey: API_KEY, fetchImpl: failingFetch(401, () => { calls += 1 }) }),
    (error: unknown) => error instanceof NewsFeedError && error.status === 401,
  )

  assert.equal(calls, 1)
})

test('retries a 5xx and gives up with the status attached', async () => {
  let calls = 0
  await assert.rejects(
    () => fetchArticles({ apiKey: API_KEY, fetchImpl: failingFetch(503, () => { calls += 1 }) }),
    (error: unknown) => error instanceof NewsFeedError && error.status === 503,
  )

  assert.equal(calls, 3) // one attempt plus two retries
})

test('tolerates a body with no items array', async () => {
  const result = await fetchArticles({
    apiKey: API_KEY,
    fetchImpl: stubFetch({ meta: {} }),
  })

  assert.deepEqual(result.items, [])
  assert.equal(result.meta.mode, 'global')
})
