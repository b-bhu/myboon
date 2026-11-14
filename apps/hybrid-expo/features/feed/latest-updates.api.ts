import type { LatestUpdate, LatestUpdateSource } from '@myboon/shared/latest-updates';
import { fetchWithTimeout, resolveApiBaseUrl } from '@/lib/api';

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 30;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * GET /latest-updates. An empty `updates` array is a successful response
 * (nothing live yet) and is not an error. A bad status or a payload that
 * is not the contract throws, which the segment shows as unavailable.
 */
export async function fetchLatestUpdates(options?: {
  signal?: AbortSignal;
  limit?: number;
}): Promise<LatestUpdate[]> {
  const limit = clamp(Math.floor(options?.limit ?? DEFAULT_LIMIT), 1, MAX_LIMIT);
  const response = await fetchWithTimeout(
    `${resolveApiBaseUrl()}/latest-updates?limit=${limit}`,
    { signal: options?.signal },
  );
  if (!response.ok) {
    throw new Error(`Latest updates request failed (${response.status})`);
  }
  const payload = (await response.json()) as unknown;
  return parseLatestUpdatesPayload(payload);
}

export function parseLatestUpdatesPayload(payload: unknown): LatestUpdate[] {
  if (!isRecord(payload) || !Array.isArray(payload.updates)) {
    throw new Error('Invalid latest updates response');
  }
  const updates = payload.updates.flatMap((value) => {
    const update = parseLatestUpdate(value);
    return update ? [update] : [];
  });
  if (payload.updates.length > 0 && updates.length === 0) {
    throw new Error('Invalid latest updates response');
  }
  return updates;
}

function parseLatestUpdate(value: unknown): LatestUpdate | null {
  if (!isRecord(value)) return null;
  if (
    !nonEmptyString(value.id)
    || !nonEmptyString(value.entitySlug)
    || !nonEmptyString(value.entityName)
    || !nonEmptyString(value.entityType)
    || !nonEmptyString(value.headline)
    || !nonEmptyString(value.whatHappened)
    || !nonEmptyString(value.howWeGotHere)
    || !nonEmptyString(value.whatToWatch)
    || !nonEmptyString(value.publishedAt)
    || !Number.isFinite(Date.parse(value.publishedAt))
    || !Array.isArray(value.sources)
  ) {
    return null;
  }
  return {
    id: value.id.trim(),
    entitySlug: value.entitySlug.trim(),
    entityName: value.entityName.trim(),
    entityType: value.entityType.trim(),
    headline: value.headline.trim(),
    whatHappened: value.whatHappened.trim(),
    howWeGotHere: value.howWeGotHere.trim(),
    whatToWatch: value.whatToWatch.trim(),
    sources: value.sources.flatMap((source) => {
      const parsed = parseSource(source);
      return parsed ? [parsed] : [];
    }),
    publishedAt: value.publishedAt,
  };
}

function parseSource(value: unknown): LatestUpdateSource | null {
  if (!isRecord(value)) return null;
  const link = httpUrlOrNull(value.link);
  if (
    !link
    || !nonEmptyString(value.itemId)
    || !nonEmptyString(value.title)
    || !nonEmptyString(value.occurredAt)
    || !Number.isFinite(Date.parse(value.occurredAt))
  ) {
    return null;
  }
  return {
    itemId: value.itemId.trim(),
    title: value.title.trim(),
    link,
    occurredAt: value.occurredAt,
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

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
