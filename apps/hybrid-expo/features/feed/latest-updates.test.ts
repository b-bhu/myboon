import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseLatestUpdatesPayload, readLatestUpdateImageUrl } from './latest-updates.api';
import {
  isLatestUpdatesMockEnabled,
  sortLatestUpdatesNewestFirst,
} from './latest-updates';
import type { LatestUpdate } from '@myboon/shared/latest-updates';

function update(id: string, publishedAt: string, headline = id): LatestUpdate {
  return {
    id,
    entitySlug: id,
    entityName: id,
    entityType: 'asset',
    headline,
    whatHappened: `${headline} happened`,
    howWeGotHere: `${headline} background`,
    whatToWatch: `${headline} next`,
    sources: [{
      itemId: `${id}-source`,
      title: `${headline} source`,
      link: `https://example.com/${id}`,
      occurredAt: publishedAt,
    }],
    publishedAt,
  };
}

test('latest updates sort newest publishedAt first and keep a stable id tie-break', () => {
  const older = update('older', '2026-11-13T19:00:00.000Z');
  const newer = update('newer', '2026-11-14T16:00:00.000Z');
  const sameTimeB = update('b', '2026-11-14T16:00:00.000Z', 'tie b');
  const sorted = sortLatestUpdatesNewestFirst([older, sameTimeB, newer]);
  assert.deepEqual(sorted.map((row) => row.id), ['newer', 'b', 'older']);
});

test('the mock flag accepts only 1, true and on', () => {
  assert.equal(isLatestUpdatesMockEnabled(undefined), false);
  assert.equal(isLatestUpdatesMockEnabled(''), false);
  assert.equal(isLatestUpdatesMockEnabled('yes'), false);
  assert.equal(isLatestUpdatesMockEnabled('0'), false);
  assert.equal(isLatestUpdatesMockEnabled(' ON '), true);
  assert.equal(isLatestUpdatesMockEnabled('true'), true);
});

test('the payload parser keeps a valid update, drops a bad source link, and rejects a body with no usable rows', () => {
  const parsed = parseLatestUpdatesPayload({
    updates: [{
      ...update('bitcoin', '2026-11-14T16:00:00.000Z', 'Bitcoin headline'),
      sources: [
        { itemId: 'ok', title: 'Desk', link: 'https://example.com/desk', occurredAt: '2026-11-14T15:00:00.000Z' },
        { itemId: 'bad', title: 'Script', link: 'javascript:alert(1)', occurredAt: '2026-11-14T15:00:00.000Z' },
      ],
    }],
  });
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0]?.sources.map((source) => source.link), ['https://example.com/desk']);
  assert.equal(parsed[0]?.imageUrl, null);
  assert.equal(readLatestUpdateImageUrl('http://example.com/a.png'), null);
  assert.equal(readLatestUpdateImageUrl('javascript:alert(1)'), null);
  assert.equal(readLatestUpdateImageUrl(`https://example.com/${'a'.repeat(2048)}`), null);
  assert.equal(readLatestUpdateImageUrl(12), null);
  assert.throws(() => parseLatestUpdatesPayload({ updates: [{ id: 'nope' }] }), /Invalid latest updates response/);
  assert.throws(() => parseLatestUpdatesPayload(null), /Invalid latest updates response/);
  assert.deepEqual(parseLatestUpdatesPayload({ updates: [] }), []);
});

test('a row imageUrl survives parsing', () => {
  const parsed = parseLatestUpdatesPayload({
    updates: [{
      ...update('pictured', '2026-11-14T16:00:00.000Z', 'Pictured'),
      imageUrl: '  https://assets.coingecko.com/coins/images/1/large/bitcoin.png  ',
    }],
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.imageUrl, 'https://assets.coingecko.com/coins/images/1/large/bitcoin.png');
  assert.equal(parsed[0]?.headline, 'Pictured');
});

test('a null imageUrl stays null after parsing', () => {
  const parsed = parseLatestUpdatesPayload({
    updates: [{
      ...update('plain', '2026-11-14T16:00:00.000Z', 'Plain'),
      imageUrl: null,
    }],
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.imageUrl, null);
  assert.equal(parsed[0]?.headline, 'Plain');
});

test('the home renders the hero carousel above the stories mosaic and the calendar', () => {
  const rootImport = /from ['"]@myboon\/shared['"]/;
  const subpathImport = /from ['"]@myboon\/shared\/latest-updates['"]/;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const typedFiles = [
    'latest-updates.ts',
    'latest-updates.api.ts',
  ];
  for (const file of typedFiles) {
    const source = readFileSync(path.join(here, file), 'utf8');
    assert.equal(rootImport.test(source), false, file);
    assert.equal(subpathImport.test(source), true, file);
  }

  const home = readFileSync(path.join(here, '../home/components/HomeFeedOverview.tsx'), 'utf8');
  const carousel = home.indexOf('<TodayCarousel');
  const mosaic = home.indexOf('<TopicMosaic');
  const calendar = home.indexOf('<HomeCalendarCard');
  assert.ok(carousel !== -1 && mosaic !== -1 && calendar !== -1);
  assert.ok(carousel < mosaic && mosaic < calendar);
  assert.doesNotMatch(home, /LatestUpdateSegment|useLatestUpdates/);
  assert.match(home, /fetchStories/);
  assert.match(home, /fetchFeedItems/);
  assert.match(home, /feedItemDetail/);

  const feedApi = readFileSync(path.join(here, 'feed.api.ts'), 'utf8');
  assert.doesNotMatch(feedApi, /\/narratives/);
  assert.match(feedApi, /fetchLatestUpdates/);
  const stories = readFileSync(path.join(here, 'stories.api.ts'), 'utf8');
  assert.match(stories, /\/stories/);
});

test('no Expo app source outside tests still names the legacy publisher route', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, '../..');
  const skipDirs = new Set(['node_modules', '.expo', 'dist', 'web-build', 'coverage']);
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skipDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) continue;
      if (/\.test\.(?:ts|tsx|js|jsx|mjs)$/.test(entry.name)) continue;
      if (readFileSync(full, 'utf8').includes('/narratives')) offenders.push(path.relative(root, full));
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});
