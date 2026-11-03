import { beforeEach, describe, expect, it } from 'vitest';
import { rawHash, signalId } from '@myboon/contracts';
import type { NewsFeedArticle, NewsFeedPost } from '@myboon/shared/news-feed';

import { readFileSync } from 'node:fs';
import { fetchFeed, type NewsFeedItem } from '@myboon/shared/news-feed';

import { feedItemToSignal, NEWS_SIGNAL_SOURCE } from './map.js';

const FETCHED_AT = new Date('2026-10-26T09:15:00.000Z');

/** Shaped like @myboon/shared/news-feed normalizes an upstream article. */
const article: NewsFeedArticle = {
  kind: 'article',
  feedSource: 'coingecko',
  title: 'Fed minutes hint at slower path; SOL and LINK swing on the news',
  url: 'https://www.fxstreet.com/analysis/fed-october-2026-minutes-rate-path-20261026',
  publishedAt: '2026-10-26T08:30:00.000Z',
  outlet: 'FXStreet',
  author: 'Dhwani Mehta',
  imageUrl: null,
  relatedCoinIds: ['solana', 'chainlink'],
};

/** Shaped like @myboon/shared/news-feed normalizes an upstream post. */
const post: NewsFeedPost = {
  kind: 'post',
  feedSource: 'x',
  author: null,
  text: 'New listings are up on the terminal: SOL-USD and LINK-USD live now, with more pairs landing this week.',
  url: 'https://x.com/myboontokens/status/1917764102417182721',
  postedAt: '2026-10-25T22:55:16.000Z',
  handle: '@myboontokens',
  imageUrl: null,
  relatedCoinIds: [],
};

describe('feedItemToSignal (article)', () => {
  const signal = feedItemToSignal(article, FETCHED_AT);

  it('maps an article to a valid news signal', () => {
    expect(signal.source).toBe(NEWS_SIGNAL_SOURCE);
    expect(signal.source_id).toBe(article.url);
    expect(signal.signal_id).toBe(signalId(NEWS_SIGNAL_SOURCE, article.url));
    expect(signal.type).toBe('news');
    expect(signal.schema_version).toBe(1);
    expect(signal.priority).toBe(0);
    expect(signal.numbers).toEqual({});
    expect(signal.text).toBe(article.title);
    expect(signal.excerpt).toBe(article.title);
    expect(signal.occurred_at).toBe(article.publishedAt);
    expect(signal.fetched_at).toBe(FETCHED_AT.toISOString());
    expect(signal.link).toBe(article.url);
    expect(signal.unusual_score).toBeNull();
    expect(signal.raw_hash).toBe(rawHash(JSON.stringify(article)));
    expect(signal.raw_ids).toEqual({
      coingecko: 'solana,chainlink',
      outlet: 'FXStreet',
      author: 'Dhwani Mehta',
      feed_source: 'coingecko',
    });
  });
});

describe('feedItemToSignal (post)', () => {
  const signal = feedItemToSignal(post, FETCHED_AT);

  it('maps a post to a valid post signal, with handle but no empty coingecko entry', () => {
    expect(signal.type).toBe('post');
    expect(signal.text).toBe(post.text);
    expect(signal.occurred_at).toBe(post.postedAt);
    expect(signal.raw_ids).toEqual({ handle: '@myboontokens', feed_source: 'x' });
    expect(signal.raw_hash).toBe(rawHash(JSON.stringify(post)));
  });

  it('omits outlet/handle keys that the item does not carry', () => {
    const noHandle: NewsFeedPost = { ...post, handle: null };
    expect(feedItemToSignal(noHandle, FETCHED_AT).raw_ids).toEqual({ feed_source: 'x' });
    expect(() => feedItemToSignal(noHandle, FETCHED_AT)).not.toThrow();
  });
});

describe('feedItemToSignal (truncation and stability)', () => {
  it('truncates the excerpt to 500 chars and keeps text untruncated', () => {
    const longTitle =
      'Rate-cut odds shift as inflation data lands, moving SOL, LINK and the broader Solana and Chainlink complex - '
      + 'detail '.repeat(90);
    const item: NewsFeedArticle = { ...article, title: longTitle };
    const signal = feedItemToSignal(item, FETCHED_AT);

    expect(signal.text).toBe(longTitle);
    expect((signal.text ?? '')).toHaveLength(longTitle.length);
    expect(signal.excerpt).toBe(longTitle.slice(0, 500));
    expect(signal.excerpt).toHaveLength(500);
  });

  it('keeps signal_id and raw_hash stable across mappings at different times, while fetched_at tracks the fetch', () => {
    const first = feedItemToSignal(article, new Date('2026-10-26T09:15:00.000Z'));
    const second = feedItemToSignal(article, new Date('2026-10-26T10:15:00.000Z'));

    expect(first.signal_id).toBe(second.signal_id);
    expect(first.raw_hash).toBe(second.raw_hash);
    expect(first.fetched_at).toBe('2026-10-26T09:15:00.000Z');
    expect(second.fetched_at).toBe('2026-10-26T10:15:00.000Z');
  });
});
/** Real tokens.xyz GET /v1/news/feed responses captured Nov 3, 2026 (#561). */
async function liveSample(file: string): Promise<NewsFeedItem[]> {
  const body = readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8');
  const fetchImpl = (async () => new Response(body, { status: 200 })) as typeof fetch;
  const { items } = await fetchFeed({ apiKey: 'test-key', fetchImpl });
  return items;
}

describe('feedItemToSignal keeps image, author and feed_source (#561, live samples)', () => {
  it('coingecko article with image and author stores both plus feed_source=coingecko', async () => {
    const items = await liveSample('global_news_only.json');
    const item = items.find((i) => i.kind === 'article' && i.author && i.imageUrl);
    expect(item).toBeDefined();
    const ids = feedItemToSignal(item!, FETCHED_AT).raw_ids;
    expect(ids.feed_source).toBe('coingecko');
    expect(ids.image).toBe(item!.imageUrl);
    expect(ids.author).toBe((item as NewsFeedArticle).author);
    expect(ids.outlet).toBe((item as NewsFeedArticle).outlet);
  });

  it('coingecko article with author "" has no author key', async () => {
    const raw = JSON.parse(readFileSync(new URL('./fixtures/global_news_only.json', import.meta.url), 'utf8'));
    const emptyUrls = raw.items.filter((i: { author: string }) => i.author === '').map((i: { url: string }) => i.url);
    expect(emptyUrls.length).toBeGreaterThan(0);
    const items = await liveSample('global_news_only.json');
    for (const item of items.filter((i) => emptyUrls.includes(i.url))) {
      const ids = feedItemToSignal(item, FETCHED_AT).raw_ids;
      expect(ids).not.toHaveProperty('author');
      expect(ids.feed_source).toBe('coingecko');
    }
  });

  it('x post stores image, author=tokens, feed_source=x and keeps handle', async () => {
    const items = await liveSample('token_solana.json');
    const posts = items.filter((i): i is NewsFeedPost => i.kind === 'post');
    expect(posts.length).toBe(3);
    for (const p of posts) {
      const ids = feedItemToSignal(p, FETCHED_AT).raw_ids;
      expect(ids).toMatchObject({ author: 'tokens', feed_source: 'x', handle: '@tokens' });
      expect(ids.image).toMatch(/^https:\/\//);
    }
  });

  it('item with no image is still valid and has no image key', () => {
    const signal = feedItemToSignal({ ...article, imageUrl: null }, FETCHED_AT);
    expect(signal.raw_ids).not.toHaveProperty('image');
  });

  it('every item in all three live samples maps to a valid signal with feed_source', async () => {
    let n = 0;
    for (const f of ['global_all.json', 'global_news_only.json', 'token_solana.json']) {
      for (const item of await liveSample(f)) {
        const ids = feedItemToSignal(item, FETCHED_AT).raw_ids;
        expect(['coingecko', 'x']).toContain(ids.feed_source);
        for (const v of Object.values(ids)) expect(v).not.toBe('');
        n += 1;
      }
    }
    expect(n).toBe(25);
  });
});
