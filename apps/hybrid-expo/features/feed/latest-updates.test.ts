import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { parseLatestUpdatesPayload } from './latest-updates.api';
import {
  isLatestUpdatesMockEnabled,
  latestUpdateTime,
  LATEST_UPDATE_SAMPLES,
  presentLatestUpdates,
  sortLatestUpdatesNewestFirst,
  type LatestUpdatesPresentation,
} from './latest-updates';
import { useLatestUpdates } from './use-latest-updates';
import type { LatestUpdate } from '@myboon/shared/latest-updates';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const now = new Date('2026-11-14T18:00:00.000Z');

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

test('latestUpdateTime uses the Feed relative buckets', () => {
  assert.equal(latestUpdateTime('2026-11-14T17:59:30.000Z', now), '1m ago');
  assert.equal(latestUpdateTime('2026-11-14T17:55:00.000Z', now), '5m ago');
  assert.equal(latestUpdateTime('2026-11-14T16:00:00.000Z', now), '2h ago');
  assert.equal(latestUpdateTime('2026-11-12T18:00:00.000Z', now), '2d ago');
  assert.equal(latestUpdateTime('not-a-date', now), 'now');
});

test('an empty list hides, a failure stays unavailable, and the mock fills only a successful empty list', () => {
  assert.equal(presentLatestUpdates([], null, false).status, 'empty');
  assert.equal(presentLatestUpdates(null, null, false).status, 'loading');
  const failed = presentLatestUpdates(null, 'Latest updates request failed (503)', true);
  assert.equal(failed.status, 'unavailable');
  assert.equal(failed.sample, false);
  assert.equal(presentLatestUpdates([], 'offline', true).status, 'unavailable');

  const sample = presentLatestUpdates([], null, true);
  assert.equal(sample.status, 'ready');
  assert.equal(sample.sample, true);
  assert.equal(sample.updates[0]?.id, 'sample-bitcoin');
  assert.equal(sample.updates[1]?.id, 'sample-federal-reserve');
  assert.notEqual(LATEST_UPDATE_SAMPLES[0]?.id, 'sample-bitcoin');

  const live = presentLatestUpdates([update('live', '2026-11-14T12:00:00.000Z', 'Live headline')], null, true);
  assert.equal(live.sample, false);
  assert.equal(live.updates[0]?.headline, 'Live headline');
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
  assert.throws(() => parseLatestUpdatesPayload({ updates: [{ id: 'nope' }] }), /Invalid latest updates response/);
  assert.throws(() => parseLatestUpdatesPayload(null), /Invalid latest updates response/);
  assert.deepEqual(parseLatestUpdatesPayload({ updates: [] }), []);
});

test('the hook hides an empty list, shows retry after a failure, and refetches newest first', async () => {
  const original = globalThis.fetch;
  let mode: 'error' | 'empty' | 'rows' = 'error';
  let calls = 0;
  const older = update('older', '2026-11-13T19:00:00.000Z', 'Older headline');
  const newer = update('newer', '2026-11-14T16:00:00.000Z', 'Newer headline');
  globalThis.fetch = async (input) => {
    calls += 1;
    const url = new URL(String(input));
    assert.match(url.pathname, /\/latest-updates$/);
    assert.equal(url.searchParams.get('limit'), '12');
    if (mode === 'error') return new Response('nope', { status: 503 });
    if (mode === 'empty') return Response.json({ updates: [] });
    return Response.json({ updates: [older, newer] });
  };

  let latest!: ReturnType<typeof useLatestUpdates>;
  function Harness() {
    latest = useLatestUpdates(true, false);
    return null;
  }
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(createElement(Harness)); });
    assert.equal(latest.view.status, 'unavailable');
    assert.match(latest.view.message ?? '', /503/);
    const failedCalls = calls;

    mode = 'rows';
    await act(async () => { await latest.retry(); });
    assert.ok(calls > failedCalls);
    const ready = latest.view;
    assert.equal(ready.status, 'ready');
    assert.deepEqual(ready.updates.map((row) => row.headline), ['Newer headline', 'Older headline']);

    mode = 'empty';
    await act(async () => { await latest.load(); });
    assert.equal(latest.view.status, 'empty');
    assert.deepEqual(latest.view.updates, []);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    globalThis.fetch = original;
  }
});

test('the segment reads the shared subpath and sits under the stories mosaic', () => {
  const rootImport = /from ['"]@myboon\/shared['"]/;
  const subpathImport = /from ['"]@myboon\/shared\/latest-updates['"]/;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const typedFiles = [
    'latest-updates.ts',
    'latest-updates.api.ts',
    'components/LatestUpdateSegment.tsx',
  ];
  for (const file of typedFiles) {
    const source = readFileSync(path.join(here, file), 'utf8');
    assert.equal(rootImport.test(source), false, file);
    assert.equal(subpathImport.test(source), true, file);
  }
  const hook = readFileSync(path.join(here, 'use-latest-updates.ts'), 'utf8');
  assert.equal(hook.includes('@myboon/shared'), false);

  const home = readFileSync(path.join(here, '../home/components/HomeFeedOverview.tsx'), 'utf8');
  const mosaic = home.indexOf('<TopicMosaic');
  const segment = home.indexOf('<LatestUpdateSegment');
  const calendar = home.indexOf('<HomeCalendarCard');
  assert.ok(mosaic !== -1 && segment !== -1 && calendar !== -1);
  assert.ok(mosaic < segment && segment < calendar);
  assert.match(home, /fetchStories/);
  assert.match(home, /fetchFeedItems/);

  const narratives = readFileSync(path.join(here, 'feed.api.ts'), 'utf8');
  assert.match(narratives, /\/narratives/);
  const stories = readFileSync(path.join(here, 'stories.api.ts'), 'utf8');
  assert.match(stories, /\/stories/);
});

test('presentation type stays empty when there is nothing to show', () => {
  const hidden: LatestUpdatesPresentation = presentLatestUpdates([], null, false);
  assert.equal(hidden.status, 'empty');
  assert.equal(hidden.sample, false);
});
