import type { StoryDetail, StoryEvent, StorySummary } from '@/features/feed/feed.types';
import { fetchWithTimeout, resolveApiBaseUrl } from '@/lib/api';

interface StoriesResponse {
  stories: unknown;
}

interface StoryDetailResponse {
  story: unknown;
  events: unknown;
}

export async function fetchStories(): Promise<StorySummary[]> {
  const response = await fetchWithTimeout(`${resolveApiBaseUrl()}/stories`);
  if (!response.ok) throw new Error(`Stories request failed (${response.status})`);

  const payload = (await response.json()) as StoriesResponse;
  if (!payload || !Array.isArray(payload.stories)) {
    throw new Error('Invalid Stories response');
  }

  return payload.stories.flatMap((value) => {
    const story = parseStorySummary(value);
    return story ? [story] : [];
  });
}

export async function fetchStoryDetail(storySlug: string): Promise<StoryDetail> {
  const response = await fetchWithTimeout(
    `${resolveApiBaseUrl()}/stories/${encodeURIComponent(storySlug)}`,
  );
  if (!response.ok) throw new Error(`Story request failed (${response.status})`);

  const payload = (await response.json()) as StoryDetailResponse;
  const story = parseStorySummary(payload?.story);
  if (!story || !Array.isArray(payload?.events)) {
    throw new Error('Invalid Story response');
  }

  const events = payload.events.flatMap((value) => {
    const event = parseStoryEvent(value);
    return event ? [event] : [];
  });

  return { story, events };
}

function parseStorySummary(value: unknown): StorySummary | null {
  if (!isRecord(value)) return null;
  if (
    !nonEmptyString(value.storySlug)
    || !nonEmptyString(value.name)
    || !nonEmptyString(value.latestDevelopment)
    || !nonEmptyString(value.updatedAt)
    || typeof value.eventCount !== 'number'
    || !Number.isInteger(value.eventCount)
    || value.eventCount < 1
    || !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    return null;
  }

  return {
    storySlug: value.storySlug.trim(),
    name: value.name.trim(),
    latestDevelopment: value.latestDevelopment.trim(),
    eventCount: value.eventCount,
    updatedAt: value.updatedAt,
    imageUrl: httpUrlOrNull(value.imageUrl),
    imageKind: imageKindOrNull(value.imageKind),
    imageAttribution: optionalString(value.imageAttribution),
  };
}

function parseStoryEvent(value: unknown): StoryEvent | null {
  if (!isRecord(value)) return null;
  if (
    !nonEmptyString(value.text)
    || !nonEmptyString(value.eventAt)
    || !Number.isFinite(Date.parse(value.eventAt))
  ) {
    return null;
  }

  return {
    text: value.text.trim(),
    eventAt: value.eventAt,
    imageUrl: httpUrlOrNull(value.imageUrl),
    imageKind: imageKindOrNull(value.imageKind),
    imageAttribution: optionalString(value.imageAttribution),
  };
}

function httpUrlOrNull(value: unknown): string | null {
  if (!nonEmptyString(value)) return null;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function imageKindOrNull(value: unknown): 'content' | 'source_avatar' | null {
  return value === 'content' || value === 'source_avatar' ? value : null;
}

function optionalString(value: unknown): string | null {
  return nonEmptyString(value) ? value.trim() : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
