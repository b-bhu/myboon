import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useFeedSection } from './use-feed-section';
import { useReportPages } from './use-report-pages';
import { fetchCalendar } from './calendar.api';
import { useStoryDetail } from './use-story-detail';
import { FEED_HOME_STORAGE_KEYS } from './feed-section-cache';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// AsyncStorage is a native module and cannot load under `tsx`: stub it before
// the first persistence call, the features/chain/activation.test.ts way. The
// backing is a real key/value map, not a spy.
const disk = new Map<string, string>();
let failNextRead = false;
const asyncStorageId = require.resolve('@react-native-async-storage/async-storage');
require.cache[asyncStorageId] = {
  id: asyncStorageId,
  filename: asyncStorageId,
  loaded: true,
  exports: {
    __esModule: true,
    default: {
      getItem: async (key: string) => {
        if (failNextRead) {
          failNextRead = false;
          throw new Error('simulated storage read failure');
        }
        return disk.get(key) ?? null;
      },
      setItem: async (key: string, value: string) => { disk.set(key, value); },
      removeItem: async (key: string) => { disk.delete(key); },
    },
  },
} as never;

/** Persists an envelope the way the app writes one, ready for a hook mount to read. */
function seedSaved(key: string, payload: unknown, savedAt = Date.now()) {
  disk.set(key, JSON.stringify({ version: 1, savedAt, payload }));
}

/** Drains the read-then-fetch microtask chain of a mount inside act. */
async function settle() {
  for (let hop = 0; hop < 20; hop += 1) await Promise.resolve();
}

test('module polls queue changes; errors retain readable data; late cancelled results cannot replace it', async () => {
  let next: () => Promise<string[]> = async () => ['old'];
  const fetcher = () => next();
  let section!: ReturnType<typeof useFeedSection<string[]>>;
  function Harness() { section = useFeedSection(fetcher); return null; }
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(Harness)); });
  assert.deepEqual(section.data, ['old']);
  next = async () => ['new', 'old'];
  await act(async () => { await section.load(true); });
  assert.deepEqual(section.data, ['old']);
  assert.deepEqual(section.pending, ['new', 'old']);
  await act(async () => { section.apply(); });
  assert.deepEqual(section.data, ['new', 'old']);
  next = async () => { throw new Error('offline'); };
  await act(async () => { await section.load(); });
  assert.deepEqual(section.data, ['new', 'old']);
  assert.equal(section.error, 'offline');
  let resolveOld!: (value: string[]) => void;
  next = () => new Promise((resolve) => { resolveOld = resolve; });
  let oldRequest!: Promise<void>;
  await act(async () => { oldRequest = section.load(); });
  next = async () => ['recovered'];
  await act(async () => { await section.load(); resolveOld(['obsolete']); await oldRequest; });
  assert.deepEqual(section.data, ['recovered']);
  assert.equal(section.error, null);
  await act(async () => renderer.unmount());
});

test('report polling keeps the wider latest-updates page, deduplicates overlap, and retries a failed tail', async () => {
  const original = globalThis.fetch;
  let total = 30;
  let failWider = false;
  const limits: number[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.match(url.pathname, /\/latest-updates$/);
    assert.equal(url.searchParams.get('offset'), null);
    const limit = Number(url.searchParams.get('limit'));
    limits.push(limit);
    if (limit > 20 && failWider) return new Response('nope', { status: 503 });
    const count = Math.min(total, limit);
    const updates = Array.from({ length: count }, (_, index) => {
      const id = total - index;
      return {
        id: String(id),
        entitySlug: `entity-${id}`,
        entityName: `Entity ${id}`,
        entityType: 'asset',
        headline: `Report ${id}`,
        whatHappened: 'Summary',
        howWeGotHere: 'Background',
        whatToWatch: 'Next',
        publishedAt: new Date(Date.UTC(2026, 9, 6) + id * 1000).toISOString(),
        sources: [],
      };
    });
    return Response.json({ updates });
  };
  let pages!: ReturnType<typeof useReportPages>;
  function Harness() { pages = useReportPages(); return null; }
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(createElement(Harness)); });
    assert.equal(pages.items.length, 20);
    assert.equal(pages.items[0]?.id, '30');
    await act(async () => { await pages.loadMore(); });
    assert.equal(pages.items.length, 30);
    total = 32;
    await act(async () => { await pages.refresh(true); });
    assert.equal(pages.items[0]?.id, '30');
    assert.equal(pages.pending?.[0]?.id, '32');
    await act(async () => pages.apply());
    assert.equal(pages.items.length, 32);
    assert.equal(pages.items[0]?.id, '32');
    failWider = true;
    await act(async () => { await pages.loadMore(); });
    assert.ok(pages.olderError);
    assert.equal(pages.items.length, 32);
    failWider = false;
    await act(async () => { await pages.loadMore(); });
    assert.equal(pages.olderError, null);
    assert.equal(pages.items.length, 32);
    assert.equal(new Set(pages.items.map((item) => item.id)).size, 32);
    assert.deepEqual(limits, [20, 30, 20, 30, 30]);
  } finally { if (renderer) await act(async () => renderer.unmount()); globalThis.fetch = original; }
});

test('calendar adapter distinguishes 503 unavailable from a successful empty period and rejects a wrong range', async () => {
  const original = globalThis.fetch;
  const result = { range: { from: '2026-10-06', to: '2026-10-06', timeZone: 'UTC' }, events: [], sources: [], status: 'unavailable' };
  try {
    globalThis.fetch = async () => Response.json(result, { status: 503 });
    assert.equal((await fetchCalendar('2026-10-06', '2026-10-06')).status, 'unavailable');
    globalThis.fetch = async () => Response.json({ ...result, status: 'ready' });
    assert.equal((await fetchCalendar('2026-10-06', '2026-10-06')).status, 'ready');
    await assert.rejects(fetchCalendar('2026-10-07', '2026-10-07'), /could not be loaded/);
  } finally { globalThis.fetch = original; }
});

test('closing/switching/retrying Story aborts older-page requests and cannot leak their failures into the new view', async () => {
  const original = globalThis.fetch;
  let resolveEarlier!: (value: Response) => void;
  let oldSignal!: AbortSignal;
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    const slug = url.pathname.split('/').at(-1)!;
    if (url.searchParams.get('offset') === '20') {
      oldSignal = options?.signal as AbortSignal;
      return new Promise((resolve) => { resolveEarlier = resolve; });
    }
    return Response.json({ story: { storySlug: slug, name: slug, latestDevelopment: 'Latest', eventCount: 21, updatedAt: '2026-10-06T12:00:00Z' },
      events: [{ text: `Event ${slug}`, eventAt: '2026-10-06T12:00:00Z' }], pagination: { limit: 20, offset: 0, total: 21, hasMore: true, nextOffset: 20 } });
  };
  let story!: ReturnType<typeof useStoryDetail>;
  function Harness({ slug }: { slug?: string }) { story = useStoryDetail(slug); return null; }
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(createElement(Harness, { slug: 'a' })); });
    let pending!: Promise<void>;
    await act(async () => { pending = story.loadEarlierMemories(); });
    await act(async () => { renderer.update(createElement(Harness, { slug: 'b' })); });
    assert.equal(oldSignal.aborted, true);
    await act(async () => { resolveEarlier(new Response('{}', { status: 503 })); await pending; });
    assert.equal(story.detail?.story.storySlug, 'b');
    assert.equal(story.loadMoreError, false);
    assert.equal(story.loadingMore, false);
    await act(async () => { pending = story.loadEarlierMemories(); });
    await act(async () => { story.retry(); });
    assert.equal(oldSignal.aborted, true);
    await act(async () => { resolveEarlier(new Response('{}', { status: 503 })); await pending; });
    assert.equal(story.detail?.events.length, 1);
    assert.equal(story.loadMoreError, false);
    await act(async () => { pending = story.loadEarlierMemories(); });
    await act(async () => { renderer.update(createElement(Harness, {})); });
    assert.equal(oldSignal.aborted, true);
    await act(async () => { resolveEarlier(new Response('{}', { status: 503 })); await pending; });
    assert.equal(story.detail, null);
    assert.equal(story.loadMoreError, false);
  } finally { if (renderer) await act(async () => renderer.unmount()); globalThis.fetch = original; }
});

test('a successful Home-section fetch (empty included) is persisted and a fresh mount shows it before the network returns', async () => {
  disk.clear();
  const emptyFetcher = () => Promise.resolve([]); // stable identity, like the app's callers
  let first!: ReturnType<typeof useFeedSection<string[]>>;
  function EmptyHarness() { first = useFeedSection<string[]>(emptyFetcher, true, { storageKey: FEED_HOME_STORAGE_KEYS.updates }); return null; }
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(createElement(EmptyHarness)); await settle(); });
    // The empty result was persisted, not skipped.
    assert.deepEqual(first.data, []);
    assert.deepEqual((JSON.parse(disk.get(FEED_HOME_STORAGE_KEYS.updates)!) as { payload: string[] }).payload, []);
    await act(async () => renderer.unmount());

    // A cold mount reads the copy and shows it while the fresh fetch is still hanging.
    let releaseNetwork!: (value: string[]) => void;
    const blockedFetcher = () => new Promise<string[]>((resolve) => { releaseNetwork = resolve; });
    let second!: ReturnType<typeof useFeedSection<string[]>>;
    function SavedHarness() {
      second = useFeedSection<string[]>(blockedFetcher, true, { storageKey: FEED_HOME_STORAGE_KEYS.updates });
      return null;
    }
    await act(async () => { renderer = create(createElement(SavedHarness)); await settle(); });
    assert.deepEqual(second.data, []); // the saved copy, empty list and all
    assert.equal(second.loading, true); // the fetch is running, but no placeholder replaces the saved copy
    const savedEnvelope = JSON.parse(disk.get(FEED_HOME_STORAGE_KEYS.updates)!) as { payload: string[] };
    assert.deepEqual(savedEnvelope.payload, []); // a fetch that has not succeeded does not rewrite the copy

    // The first fresh response swaps in and is persisted.
    await act(async () => { releaseNetwork(['fresh']); await settle(); });
    assert.deepEqual(second.data, ['fresh']);
    assert.deepEqual((JSON.parse(disk.get(FEED_HOME_STORAGE_KEYS.updates)!) as { payload: string[] }).payload, ['fresh']);
  } finally { if (renderer) await act(async () => renderer.unmount()); }
});

test('after a saved copy the first queue=false load swaps in immediately and is persisted; a queued poll keeps data in place', async () => {
  disk.clear();
  seedSaved(FEED_HOME_STORAGE_KEYS.stories, ['saved']);
  let respond!: (value: string[]) => void; // resolver of the most recent request
  const fetcher = () => new Promise<string[]>((resolve) => { respond = resolve; });
  let section!: ReturnType<typeof useFeedSection<string[]>>;
  function Harness() { section = useFeedSection<string[]>(fetcher, true, { storageKey: FEED_HOME_STORAGE_KEYS.stories }); return null; }
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(createElement(Harness)); await settle(); });
    assert.deepEqual(section.data, ['saved']); // hydrated while the first fetch hangs

    // The first fresh fetch (queue=false) applies immediately and is persisted.
    await act(async () => { respond(['fresh']); await settle(); });
    assert.deepEqual(section.data, ['fresh']);
    assert.equal(section.pending, null);
    assert.deepEqual((JSON.parse(disk.get(FEED_HOME_STORAGE_KEYS.stories)!) as { payload: string[] }).payload, ['fresh']);

    // Later background refreshes keep today's behaviour: pending queues on change.
    await act(async () => { void section.load(true); await settle(); });
    await act(async () => { respond(['changed', 'fresh']); await settle(); });
    assert.deepEqual(section.data, ['fresh']);
    assert.deepEqual(section.pending, ['changed', 'fresh']);
    await act(async () => section.apply());
    assert.deepEqual(section.data, ['changed', 'fresh']);
  } finally { if (renderer) await act(async () => renderer.unmount()); }
});

test('a first-fresh payload arriving while the section is mid-press is not applied until the press ends', async () => {
  disk.clear();
  seedSaved(FEED_HOME_STORAGE_KEYS.stories, ['saved']);
  const hold = { current: false };
  let respond!: (value: string[]) => void;
  const fetcher = () => new Promise<string[]>((resolve) => { respond = resolve; });
  let section!: ReturnType<typeof useFeedSection<string[]>>;
  function Harness() { section = useFeedSection<string[]>(fetcher, true, { storageKey: FEED_HOME_STORAGE_KEYS.stories, holdRef: hold }); return null; }
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(createElement(Harness)); await settle(); });
    assert.deepEqual(section.data, ['saved']); // hydrated

    hold.current = true; // a tile is pressed
    await act(async () => { respond(['fresh']); await settle(); });
    assert.deepEqual(section.data, ['saved']); // the swap waits for the press
    assert.equal(section.pending, null); // the press hold does not light up the poll queue

    hold.current = false;
    await act(async () => { section.release(); await settle(); });
    assert.deepEqual(section.data, ['fresh']);
    // A successful fetch was persisted even though its swap was held.
    assert.deepEqual((JSON.parse(disk.get(FEED_HOME_STORAGE_KEYS.stories)!) as { payload: string[] }).payload, ['fresh']);

    // Releasing with nothing held is a no-op.
    await act(async () => { section.release(); await settle(); });
    assert.deepEqual(section.data, ['fresh']);
  } finally { if (renderer) await act(async () => renderer.unmount()); }
});

test('an error after a saved copy keeps the copy and surfaces the existing last-loaded path', async () => {
  disk.clear();
  seedSaved(FEED_HOME_STORAGE_KEYS.updates, ['saved']);
  let fail = false;
  const fetcher = () => fail ? Promise.reject(new Error('offline')) : Promise.resolve(['saved']);
  let section!: ReturnType<typeof useFeedSection<string[]>>;
  function Harness() { section = useFeedSection<string[]>(fetcher, true, { storageKey: FEED_HOME_STORAGE_KEYS.updates }); return null; }
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(createElement(Harness)); await settle(); });
    assert.deepEqual(section.data, ['saved']);
    assert.equal(section.error, null);

    fail = true;
    await act(async () => { await section.load(); await settle(); });
    assert.equal(section.error, 'offline');
    assert.deepEqual(section.data, ['saved']); // the last-loaded copy stays readable
    assert.equal(section.loading, false);
    // A thrown fetch never overwrites the saved copy.
    assert.deepEqual((JSON.parse(disk.get(FEED_HOME_STORAGE_KEYS.updates)!) as { payload: string[] }).payload, ['saved']);
  } finally { if (renderer) await act(async () => renderer.unmount()); }
});

test('a corrupt or expired saved copy is no copy: today\'s placeholder stays until the first response', async () => {
  const hangingFetcher = () => new Promise<string[]>(() => { /* the response never arrives */ });
  let section!: ReturnType<typeof useFeedSection<string[]>>;
  function Harness() { section = useFeedSection<string[]>(hangingFetcher, true, { storageKey: FEED_HOME_STORAGE_KEYS.updates }); return null; }
  let renderer!: ReactTestRenderer;
  try {
    disk.clear();
    disk.set(FEED_HOME_STORAGE_KEYS.updates, '{corrupt');
    await act(async () => { renderer = create(createElement(Harness)); await settle(); });
    assert.equal(section.data, null);
    assert.equal(section.loading, true); // the placeholder shows
    assert.equal(disk.has(FEED_HOME_STORAGE_KEYS.updates), false); // the corrupt entry was removed
    await act(async () => renderer.unmount());

    disk.clear();
    seedSaved(FEED_HOME_STORAGE_KEYS.updates, ['old'], Date.now() - 25 * 60 * 60 * 1000);
    await act(async () => { renderer = create(createElement(Harness)); await settle(); });
    assert.equal(section.data, null);
    assert.equal(section.loading, true);
    assert.equal(disk.has(FEED_HOME_STORAGE_KEYS.updates), false);
    await act(async () => renderer.unmount());

    // Nearly 24 hours old still shows (the exact boundary is covered in feed-section-cache.test.ts).
    disk.clear();
    seedSaved(FEED_HOME_STORAGE_KEYS.updates, ['edge'], Date.now() - 23 * 60 * 60 * 1000);
    await act(async () => { renderer = create(createElement(Harness)); await settle(); });
    assert.deepEqual(section.data, ['edge']);
  } finally { if (renderer) await act(async () => renderer.unmount()); }
});

test('callers with no storage key stay memory-only', async () => {
  disk.clear();
  const memoryFetcher = () => Promise.resolve(['m']);
  let section!: ReturnType<typeof useFeedSection<string[]>>;
  function Harness() { section = useFeedSection<string[]>(memoryFetcher, true); return null; }
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(createElement(Harness)); await settle(); });
    assert.deepEqual(section.data, ['m']);
    assert.equal(disk.size, 0); // nothing was persisted
    await act(async () => { section.release(); }); // no held payload, no-op
    assert.deepEqual(section.data, ['m']);
  } finally { if (renderer) await act(async () => renderer.unmount()); }
});
