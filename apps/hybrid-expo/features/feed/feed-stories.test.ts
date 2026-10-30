import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORY_SAMPLE,
  showAllStoriesLink,
  splitStories,
  storyAge,
  storyCountLabel,
  storyHref,
  storyMeta,
  storySample,
  timelineEvents,
  timelineLabel,
} from './feed-stories';
import type { StoryEvent, StorySummary } from './feed.types';

const story = (slug: string, hoursAgo: number): StorySummary => ({
  storySlug: slug,
  name: `Story ${slug}`,
  latestDevelopment: 'Latest development',
  eventCount: 3,
  updatedAt: new Date(Date.UTC(2026, 9, 30, 12, 0) - hoursAgo * 3_600_000).toISOString(),
  imageUrl: null,
  imageKind: null,
  imageAttribution: null,
});

const event = (text: string, eventAt: string): StoryEvent => ({
  text,
  eventAt,
  imageUrl: null,
  imageKind: null,
  imageAttribution: null,
});

const iso = new Date('2026-10-30T12:00:00Z');
const ago = (hours: number) => new Date(iso.getTime() - hours * 3_600_000).toISOString();

test('splitStories keeps the 7-day window: exactly 7 days past, 6d23h active', () => {
  const week = { ...story('week', 0), updatedAt: ago(24 * 7) };
  const almostWeek = { ...story('almost', 0), updatedAt: ago(24 * 6 + 23) };
  const split = splitStories([week, almostWeek], iso);
  assert.deepEqual(split.active.map((item) => item.storySlug), ['almost']);
  assert.deepEqual(split.past.map((item) => item.storySlug), ['week']);
});

test('splitStories sorts both lists newest first with storySlug ascending ties', () => {
  const stories = [
    story('bravo', 5),
    story('alpha', 5), // Ties with bravo: slug ascending keeps alpha first.
    story('charlie', 1),
    story('delta', 48),
    story('echo', 24 * 10),
  ];
  const split = splitStories(stories, iso);
  assert.deepEqual(split.active.map((item) => item.storySlug), ['charlie', 'alpha', 'bravo', 'delta']);
  assert.deepEqual(split.past.map((item) => item.storySlug), ['echo']);
  // The input list is never reordered in place.
  assert.deepEqual(stories.map((item) => item.storySlug), ['bravo', 'alpha', 'charlie', 'delta', 'echo']);
});

test('splitStories files invalid dates under past', () => {
  const broken = { ...story('broken', 3), updatedAt: 'not-a-date' };
  const split = splitStories([broken, story('live', 2)], iso);
  assert.deepEqual(split.active.map((item) => item.storySlug), ['live']);
  assert.deepEqual(split.past.map((item) => item.storySlug), ['broken']);
  // Unusable stamps always sort behind (or among themselves, by slug).
  assert.deepEqual(splitStories([broken], iso).past.map((item) => item.storySlug), ['broken']);
});

test('storyCountLabel pluralises only the non-singular counts', () => {
  assert.equal(storyCountLabel(1), '1 update');
  assert.equal(storyCountLabel(12), '12 updates');
  assert.equal(storyCountLabel(0), '0 updates');
});

test('storyAge buckets ages from just now to hours', () => {
  const now = new Date(2026, 9, 30, 12, 0);
  assert.equal(storyAge(new Date(now.getTime() - 30_000).toISOString(), now), 'just now');
  assert.equal(storyAge(new Date(now.getTime() - 40 * 60_000).toISOString(), now), '40m ago');
  assert.equal(storyAge(new Date(now.getTime() - 2 * 3_600_000).toISOString(), now), '2h ago');
});

test('storyAge reads the previous local day as Yesterday and older days as dates', () => {
  const now = new Date(2026, 9, 30, 12, 0);
  // 25h back, still yesterday's calendar day.
  assert.equal(storyAge(new Date(2026, 9, 29, 11, 0).toISOString(), now), 'Yesterday');
  // 23.5h back reads in hours: the hour buckets run to a full day.
  assert.equal(storyAge(new Date(2026, 9, 29, 12, 30).toISOString(), now), '23h ago');
  // 26 Oct 2026 is a Monday (same fixture as feed-home.test.ts).
  assert.equal(storyAge(new Date(2026, 9, 26, 12, 0).toISOString(), now), 'Mon 26 Oct');
});

test('storyAge returns empty for invalid dates', () => {
  assert.equal(storyAge('not-a-date', new Date()), '');
});

test('storyMeta joins the update count and the age, dropping the age when unusable', () => {
  const now = new Date(2026, 9, 30, 12, 0);
  const fresh = { ...story('meta', 0), updatedAt: new Date(now.getTime() - 40 * 60_000).toISOString() };
  assert.equal(storyMeta(fresh, now), '3 updates · 40m ago');
  assert.equal(storyMeta({ ...fresh, eventCount: 1 }, now), '1 update · 40m ago');
  assert.equal(storyMeta({ ...fresh, updatedAt: 'not-a-date' }, now), '3 updates');
});

test('storyHref encodes the slug into the story route', () => {
  assert.equal(storyHref('us-iran'), '/story/us-iran');
  assert.equal(storyHref('us iran'), '/story/us%20iran');
  assert.equal(storyHref('a/b'), '/story/a%2Fb');
});

test('timelineEvents orders newest first, keeps timestamp ties stable, sinks invalid dates', () => {
  const rows = [
    event('oldest', ago(72)),
    event('broken', 'not-a-date'),
    event('tie-b', ago(24)),
    event('newest', ago(1)),
    event('tie-a', ago(24)),
  ];
  const out = timelineEvents(rows);
  assert.deepEqual(out.map((item) => item.text), ['newest', 'tie-b', 'tie-a', 'oldest', 'broken']);
  // The input list is never reordered in place.
  assert.deepEqual(rows.map((item) => item.text), ['oldest', 'broken', 'tie-b', 'newest', 'tie-a']);
});

test('timelineEvents on an empty list stays empty', () => {
  assert.deepEqual(timelineEvents([]), []);
});

test('timelineLabel renders the D MMM date in capitals with AGO only while fresh', () => {
  const now = new Date(2026, 9, 30, 12, 0);
  const monday = new Date(2026, 9, 26, 12, 0).toISOString();
  assert.equal(timelineLabel(monday, now, false), '26 OCT');
  // Days-old events get no AGO suffix even on the latest slot.
  assert.equal(timelineLabel(monday, now, true), '26 OCT');
  const fresh = new Date(now.getTime() - 40 * 60_000).toISOString();
  assert.equal(timelineLabel(fresh, now, true), '30 OCT · 40M AGO');
  assert.equal(timelineLabel(fresh, now, false), '30 OCT');
  const hours = new Date(now.getTime() - 2 * 3_600_000).toISOString();
  assert.equal(timelineLabel(hours, now, true), '30 OCT · 2H AGO');
});

test('timelineLabel skips the AGO suffix for NOW and yesterday forms, empty when invalid', () => {
  const now = new Date(2026, 9, 30, 12, 0);
  const nowish = new Date(now.getTime() - 20_000).toISOString();
  assert.equal(timelineLabel(nowish, now, true), '30 OCT');
  assert.equal(timelineLabel(new Date(2026, 9, 29, 11, 0).toISOString(), now, true), '29 OCT');
  assert.equal(timelineLabel('not-a-date', now, true), '');
});

test('STORY_SAMPLE carries three catch-up points and three key numbers', () => {
  assert.equal(STORY_SAMPLE.catchUp.length, 3);
  assert.equal(STORY_SAMPLE.keyNumbers.length, 3);
  assert.ok(STORY_SAMPLE.catchUp.every((point) => typeof point === 'string' && point.length > 0));
  assert.ok(STORY_SAMPLE.keyNumbers.every((box) =>
    typeof box.label === 'string' && typeof box.value === 'string' && typeof box.note === 'string'));
});

test('storySample gates the bundle on the mocks flag: null when off, the bundle itself when on', () => {
  assert.equal(storySample(false), null);
  assert.equal(storySample(true), STORY_SAMPLE);
});
test('showAllStoriesLink hides the Home link when there are no stories', () => {
  assert.equal(showAllStoriesLink(null), false);
  assert.equal(showAllStoriesLink(undefined), false);
  assert.equal(showAllStoriesLink([]), false);
  assert.equal(showAllStoriesLink([{ storySlug: 'a', name: 'A', latestDevelopment: 'x', eventCount: 1, updatedAt: '2026-10-01T00:00:00.000Z', imageUrl: null, imageKind: null, imageAttribution: null }]), true);
});
