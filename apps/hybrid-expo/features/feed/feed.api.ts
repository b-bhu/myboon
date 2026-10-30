import type { FeedItem } from '@/features/feed/feed.types';
import { resolveApiBaseUrl, fetchWithTimeout } from '@/lib/api';

interface PublishedNarrativeListItem {
  updateKey: string;
  title: string;
  summary: string;
  publishedAt: string;
  imageUrl?: string | null;
  imageKind?: 'content' | 'source_avatar' | null;
  imageAttribution?: string | null;
  sourceName?: string | null;
}

const MAX_SOURCE_NAME_LENGTH = 120;

export function reportSourceName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\s+/g, ' ').trim();
  if (!name || name.length > MAX_SOURCE_NAME_LENGTH) return null;
  return name;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}


export function toRelativeTime(iso: string): string {
  const createdAt = new Date(iso).getTime();
  if (Number.isNaN(createdAt)) return 'now';

  const diffMs = Math.max(0, Date.now() - createdAt);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < hour) return `${Math.max(1, Math.floor(diffMs / minute))}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  return `${Math.floor(diffMs / day)}d ago`;
}

export function toShortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function mapNarrativeToFeedItem(item: PublishedNarrativeListItem, index: number, offset: number): FeedItem {
  return {
    id: item.updateKey,
    category: 'feed',
    createdAt: item.publishedAt,
    headline: item.title,
    description: item.summary,
    isTop: offset + index === 0,
    actions: [],
    imageUrl: httpUrlOrNull(item.imageUrl),
    imageKind: item.imageKind === 'content' || item.imageKind === 'source_avatar' ? item.imageKind : null,
    imageAttribution: typeof item.imageAttribution === 'string' && item.imageAttribution.trim()
      ? item.imageAttribution.trim()
      : null,
    sourceName: reportSourceName(item.sourceName),
  };
}

export async function fetchFeedItems(limit = 20, offset = 0, options?: { signal?: AbortSignal }): Promise<FeedItem[]> {
  const clamped = clamp(limit, 1, 50);
  const baseUrl = resolveApiBaseUrl();
  const response = await fetchWithTimeout(`${baseUrl}/narratives?limit=${clamped}&offset=${offset}`, { signal: options?.signal });

  if (!response.ok) {
    throw new Error(`Feed request failed (${response.status})`);
  }

  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) {
    throw new Error('Invalid feed response');
  }

  return payload
    .filter((row): row is PublishedNarrativeListItem => typeof row === 'object' && row !== null && 'updateKey' in row)
    .map((item, index) => mapNarrativeToFeedItem(item, index, offset));
}

export interface NarrativeDetail {
  updateKey: string;
  title: string;
  summary: string;
  content: string;
  publishedAt: string;
  imageUrl: string | null;
  imageKind: 'content' | 'source_avatar' | null;
  imageAttribution: string | null;
}

function httpUrlOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export async function fetchNarrativeDetail(id: string, options?: { signal?: AbortSignal }): Promise<NarrativeDetail> {
  const baseUrl = resolveApiBaseUrl();
  const response = await fetchWithTimeout(`${baseUrl}/narratives/${encodeURIComponent(id)}`, { signal: options?.signal });

  if (!response.ok) {
    throw new Error(`Narrative detail request failed (${response.status})`);
  }

  const payload = (await response.json()) as unknown;
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid narrative detail response');
  }

  return payload as NarrativeDetail;
}
