import assert from 'node:assert/strict';
import test from 'node:test';
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
