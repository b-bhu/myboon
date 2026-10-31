import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carouselIndex, developingStory, slideTag, todayLabel, todaySlides } from './feed-home';
import type { FeedItem, StorySummary } from './feed.types';

const row = (id: number, minutesAgo: number): FeedItem => ({
  id: String(id),
  category: 'feed',
  createdAt: new Date(Date.UTC(2026, 9, 30, 12, 0) - minutesAgo * 60_000).toISOString(),
  headline: `Report ${id}`,
  description: 'Published report',
  actions: [],
});

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

test('todaySlides sorts newest first with the API id tiebreak and caps at five', () => {
  // Rows 4 and 6 share a publication time: id descending keeps 6 ahead of 4.
  const items = [row(1, 300), row(2, 60), row(3, 120), row(4, 10), row(5, 30), row(6, 10)];
  const slides = todaySlides(items);
  assert.deepEqual(slides.map((item) => item.id), ['6', '4', '5', '2', '3']);
  assert.equal(slides.length, 5);
  // The source list is never reordered in place.
  assert.deepEqual(items.map((item) => item.id), ['1', '2', '3', '4', '5', '6']);
});
test('todaySlides keeps short lists as their same rows in newest-first order', () => {
  const items = [row(2, 120), row(1, 60)];
  const slides = todaySlides(items);
  assert.equal(slides.length, 2);
  assert.equal(slides[0], items[1]);
  assert.equal(slides[1], items[0]);
});
test('todaySlides on an empty list stays empty', () => {
  assert.deepEqual(todaySlides([]), []);
});

test('slideTag renames the generic feed category and capitalises the rest', () => {
  assert.equal(slideTag(row(1, 0)), 'Latest');
  assert.equal(slideTag({ ...row(1, 0), category: 'macro' }), 'Macro');
  assert.equal(slideTag({ ...row(1, 0), category: 'bitcoin' }), 'Bitcoin');
  assert.equal(slideTag({ ...row(1, 0), category: 'deFi' }), 'DeFi');
});

test('carouselIndex rounds the swipe offset and clamps to the slide range', () => {
  assert.equal(carouselIndex(0, 320, 5), 0);
  assert.equal(carouselIndex(320, 320, 5), 1);
  assert.equal(carouselIndex(340, 320, 5), 1);
  assert.equal(carouselIndex(480, 320, 5), 2);
  assert.equal(carouselIndex(4000, 320, 5), 4);
  assert.equal(carouselIndex(-50, 320, 5), 0);
});
test('carouselIndex falls back to zero for unusable widths or counts', () => {
  assert.equal(carouselIndex(100, 0, 5), 0);
  assert.equal(carouselIndex(100, -2, 5), 0);
  assert.equal(carouselIndex(100, 320, 0), 0);
});

const now = new Date('2026-10-30T12:00:00Z');

test('developingStory picks the most recently updated active story', () => {
  const stories = [story('older', 72), story('newer', 3)];
  assert.equal(developingStory(stories, now)?.storySlug, 'newer');
});
test('developingStory ignores stories outside the 7-day active window', () => {
  assert.equal(developingStory([story('stale', 24 * 8)], now), null);
  assert.equal(developingStory([story('stale', 24 * 8), story('fresh', 5)], now)?.storySlug, 'fresh');
});
test('developingStory ignores invalid dates and lists without stories', () => {
  const broken = { ...story('broken', 3), updatedAt: 'not-a-date' };
  assert.equal(developingStory([broken], now), null);
  assert.equal(developingStory([broken, story('good', 5)], now)?.storySlug, 'good');
  assert.equal(developingStory([], now), null);
});

test('todayLabel matches the mock date line with correct update counts', () => {
  const monday = new Date(2026, 9, 26, 12, 0);
  assert.equal(todayLabel(monday, 5), 'Mon 26 Oct · 5 updates');
  assert.equal(todayLabel(monday, 1), 'Mon 26 Oct · 1 update');
  assert.equal(todayLabel(monday, 0), 'Mon 26 Oct · 0 updates');
  assert.equal(todayLabel(new Date(2026, 9, 6, 9, 0), 2), 'Tue 6 Oct · 2 updates');
});