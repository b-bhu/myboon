import { isStoryActive, withMock } from './feed-mocks';
import { dayLabel, updateAge } from './feed-updates';
import type { StoryEvent, StorySummary } from './feed.types';

/**
 * Pure helpers for the story page and the "All stories" list
 * (issue #497, markup per docs/mockups/design-language/feed-mock.html
 * #s-story / #s-allstories, DESIGN.md sections 7, 9).
 *
 * Deliberately react-free and side-effect free so plain-node tooling
 * (node:test) can exercise every branch, mirroring feed-home.ts.
 */

/** Split stories into the ACTIVE and PAST tab lists of the "All stories" screen. */
export function splitStories(stories: StorySummary[], now: Date): { active: StorySummary[]; past: StorySummary[] } {
  const newestFirst = (a: StorySummary, b: StorySummary) => updatedOrder(a, b);
  return {
    active: stories.filter((story) => isStoryActive(story.updatedAt, now)).sort(newestFirst),
    // isStoryActive also rejects invalid dates, so unusable stamps land here.
    past: stories.filter((story) => !isStoryActive(story.updatedAt, now)).sort(newestFirst),
  };
}

/** Newest first; ties read slug ascending, invalid stamps sink by slug too. */
function updatedOrder(a: StorySummary, b: StorySummary): number {
  const aMs = Date.parse(a.updatedAt);
  const bMs = Date.parse(b.updatedAt);
  const aValid = !Number.isNaN(aMs);
  const bValid = !Number.isNaN(bMs);
  if (aValid !== bValid) return aValid ? -1 : 1;
  if (aValid && aMs !== bMs) return bMs - aMs;
  return a.storySlug.localeCompare(b.storySlug);
}

/** '1 update' / '12 updates'. */
export function storyCountLabel(count: number): string {
  return count === 1 ? '1 update' : `${count} updates`;
}

// Same local month abbreviations as todayLabel in feed-home.ts.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Local calendar-day distance in whole days (negative when the date is ahead of now). */
function calendarDayDistance(iso: string, now: Date): number | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((startOf(now) - startOf(date)) / 86_400_000);
}

/**
 * 'just now' (<1m), '40m ago' and '2h ago' within the first day, then
 * 'Yesterday' for the previous local calendar day and 'Mon 26 Oct' beyond —
 * the same date shape as dayLabel. Empty when the stamp is unusable.
 */
export function storyAge(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const ageMs = now.getTime() - date.getTime();
  if (ageMs < 60_000) return 'just now';
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  if (ageMs < 24 * 3_600_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
  const days = calendarDayDistance(iso, now);
  if (days === 1) return 'Yesterday';
  // distance 0 cannot follow a full day here, so dayLabel never reads 'Today'.
  return dayLabel(iso, now);
}

/** Meta line for a story row, e.g. '12 updates · 40m ago'; count only when the age is unusable. */
export function storyMeta(story: StorySummary, now: Date): string {
  const count = storyCountLabel(story.eventCount);
  const age = storyAge(story.updatedAt, now);
  return age ? `${count} · ${age}` : count;
}

/** Story route for a slug; encoding keeps spaces and slashes one segment deep. */
export function storyHref(slug: string): string {
  return `/story/${encodeURIComponent(slug)}`;
}

/**
 * Timeline rows for the story page, newest first and stable for equal
 * stamps; events with unusable dates keep their input order at the end.
 */
export function timelineEvents(events: StoryEvent[]): StoryEvent[] {
  const order = (a: StoryEvent, b: StoryEvent) => eventOrder(a, b);
  return events.slice().sort(order);
}

function eventOrder(a: StoryEvent, b: StoryEvent): number {
  const aMs = Date.parse(a.eventAt);
  const bMs = Date.parse(b.eventAt);
  const aValid = !Number.isNaN(aMs);
  const bValid = !Number.isNaN(bMs);
  if (aValid !== bValid) return aValid ? -1 : 1;
  // Both valid: newest first; both invalid: keep the input order.
  if (aValid && aMs !== bMs) return bMs - aMs;
  return 0;
}

/**
 * Mono-capital timeline marker, e.g. '26 OCT'; the newest event adds the
 * short age from updateAge when it reads in minutes or hours ('40M AGO').
 */
export function timelineLabel(iso: string, now: Date, isLatest: boolean): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const base = `${date.getDate()} ${MONTHS[date.getMonth()]}`.toUpperCase();
  if (!isLatest) return base;
  const age = updateAge(iso, now);
  // Only the minute/hour forms ('5M', '2H') read with AGO; NOW and date
  // forms already say it all (updateAge's YDA and '26 OCT').
  return /^\d+[MH]$/.test(age) ? `${base} · ${age} AGO` : base;
}

export interface StoryKeyNumber {
  label: string;
  value: string;
  note: string;
}

interface StorySampleBundle {
  catchUp: [string, string, string];
  keyNumbers: [StoryKeyNumber, StoryKeyNumber, StoryKeyNumber];
}

/**
 * Prototype-only story page content (mock #s-story 'Catch me up · 30 sec'
 * and key numbers). Generic placeholders — claims only ever come from the API.
 */
export const STORY_SAMPLE: StorySampleBundle = {
  catchUp: [
    'Sample point one: a fresh update restarted the story this week.',
    'Sample point two: the follow-up ended without an agreement.',
    'Sample point three: the next step waits on a pending decision.',
  ],
  keyNumbers: [
    { label: 'Sample metric', value: '12.4%', note: 'sample window' },
    { label: 'Sample share', value: '48%', note: 'sample market' },
    { label: 'Sample count', value: '3', note: 'sample rounds' },
  ],
};

/** Sample story page content only when mocks are active; null otherwise. */
export function storySample(enabled?: boolean): StorySampleBundle | null {
  return withMock(STORY_SAMPLE, enabled);
}