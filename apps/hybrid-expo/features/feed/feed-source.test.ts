import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fetchFeedItems, reportSourceName } from './feed.api';

function update(id: string, publishedAt: string, sourceTitle?: string, imageUrl?: string | null) {
  return {
    id,
    entitySlug: id,
    entityName: id,
    entityType: 'asset',
    headline: id,
    whatHappened: 'Summary',
    howWeGotHere: `${id} background`,
    whatToWatch: `${id} next`,
    publishedAt,
    imageUrl,
    sources: sourceTitle === undefined ? [] : [{
      itemId: `${id}-source`,
      title: sourceTitle,
      link: `https://example.com/${id}`,
      occurredAt: publishedAt,
    }],
  };
}

test('report items keep a trimmed outlet and drop a blank, missing, or oversized source', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.match(url.pathname, /\/latest-updates$/);
    return Response.json({
      updates: [
        update('1', '2026-10-06T12:00:00Z', '  CoinDesk  ', 'https://assets.coingecko.com/coins/images/1/large/bitcoin.png'),
        update('2', '2026-10-06T11:00:00Z', '   ', null),
        update('3', '2026-10-06T10:00:00Z', undefined, 'http://example.com/not-secure.png'),
        update('4', '2026-10-06T09:00:00Z', 'A'.repeat(121)),
      ],
    });
  };
  try {
    const items = await fetchFeedItems();
    assert.deepEqual(items.map((item) => item.sourceName), ['CoinDesk', null, null, null]);
    assert.equal(items[0]?.imageUrl, 'https://assets.coingecko.com/coins/images/1/large/bitcoin.png');
    assert.equal(items[0]?.imageKind, 'content');
    assert.equal(items[0]?.howWeGotHere, '1 background');
    assert.equal(items[0]?.whatToWatch, '1 next');
    assert.equal(items[1]?.imageUrl, null);
    assert.equal(items[1]?.imageKind, null);
    assert.equal(items[2]?.imageUrl, null);
    assert.equal(reportSourceName(null), null);
    assert.equal(reportSourceName(12), null);
  } finally {
    globalThis.fetch = original;
  }
});

/** Every .ts(x) file under features/feed, nested directories included. */
function feedSourceFiles(): string[] {
  const root = new URL('.', import.meta.url).pathname;
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(path);
    }
  };
  walk(root);
  return files;
}

test('feed features read story prices and candles only from the MyBoon API', () => {
  const self = new URL('.', import.meta.url);
  const offenders = feedSourceFiles().filter((file) => {
    // This test names the forbidden modules itself, so it is skipped.
    if (file.startsWith(self.pathname)) return false;
    const source = readFileSync(file, 'utf8');
    return source.includes('@/features/perps/phoenix.api') || source.includes('api.hyperliquid.xyz');
  });
  assert.deepEqual(
    offenders.map((file) => relative(self.pathname, file)),
    [],
    'features/feed must not call Phoenix or Hyperliquid directly',
  );
});

test('tiles and the details price section no longer use topicMarket; only the trade dock does', () => {
  const root = new URL('.', import.meta.url).pathname;
  for (const file of ['components/TopicMosaic.tsx', 'components/StoryMarketsSection.tsx']) {
    const source = readFileSync(join(root, file), 'utf8');
    assert.equal(source.includes('topicMarket'), false, `${file} still references topicMarket`);
  }
  const screen = readFileSync(join(root, 'StoryScreen.tsx'), 'utf8');
  // The retired price block is gone; the pinned trade dock keeps its own path.
  assert.equal(screen.includes('TopicMarketSection'), false);
  assert.match(screen, /const link = story \? topicMarket\(story\.storySlug\) : null;/);
  assert.match(screen, /\/markets\/phoenix\/\[symbol\]/);
  // The details price section renders from the story's linked markets.
  assert.match(screen, /StoryMarketsSection/);
  assert.match(screen, /story\.markets\.length > 0/);
});
