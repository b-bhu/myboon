import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useFeedSection } from './use-feed-section';
import { useReportPages } from './use-report-pages';
import { fetchCalendar } from './calendar.api';
import { useStoryDetail } from './use-story-detail';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

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

test('report polling keeps older pages, deduplicates offset overlap, and retries the same failed cursor', async () => {
  const original = globalThis.fetch;
  let newest = 45;
  let failOlder = false;
  const offsets: number[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const offset = Number(url.searchParams.get('offset'));
    offsets.push(offset);
    if (offset > 0 && failOlder) return new Response('{}', { status: 503 });
    const rows = Array.from({ length: newest }, (_, index) => newest - index).slice(offset, offset + 20)
      .map((id) => ({ updateKey: String(id), title: `Report ${id}`, summary: 'Summary', publishedAt: new Date(Date.UTC(2026, 9, 6, 0, id)).toISOString() }));
    return Response.json(rows);
  };
  let pages!: ReturnType<typeof useReportPages>;
  function Harness() { pages = useReportPages(); return null; }
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(createElement(Harness)); });
    await act(async () => { await pages.loadMore(); });
    assert.equal(pages.items.length, 40);
    newest = 47;
    await act(async () => { await pages.refresh(true); });
    assert.equal(pages.items[0]?.id, '45');
    assert.equal(pages.pending?.[0]?.id, '47');
    await act(async () => pages.apply());
    assert.equal(pages.items.length, 42);
    failOlder = true;
    await act(async () => { await pages.loadMore(); });
    assert.ok(pages.olderError);
    assert.equal(pages.items.length, 42);
    failOlder = false;
    await act(async () => { await pages.loadMore(); await pages.loadMore(); });
    assert.equal(pages.olderError, null);
    assert.equal(pages.items.length, 47);
    assert.equal(new Set(pages.items.map((item) => item.id)).size, 47);
    assert.deepEqual(offsets, [0, 20, 0, 20, 20, 40]);
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
