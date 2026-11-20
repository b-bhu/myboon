import type {
  HyperliquidCandlesResponse,
  MarketCandle,
  StoryMarket,
} from '@myboon/shared/stories';
import type { StoryDetail, StoryEvent, StoryPagination, StorySummary } from '@/features/feed/feed.types';
import { fetchWithTimeout, resolveApiBaseUrl } from '@/lib/api';

interface StoriesResponse {
  stories: unknown;
}

interface StoryDetailResponse {
  story: unknown;
  events: unknown;
  pagination?: unknown;
}

const DEFAULT_STORY_EVENT_LIMIT = 20;

export async function fetchStories(options?: { signal?: AbortSignal }): Promise<StorySummary[]> {
  const response = await fetchWithTimeout(`${resolveApiBaseUrl()}/stories`, { signal: options?.signal });
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

export async function fetchStoryDetail(
  storySlug: string,
  limit = DEFAULT_STORY_EVENT_LIMIT,
  offset = 0,
  options?: { readonly signal?: AbortSignal },
): Promise<StoryDetail> {
  const safeLimit = Math.min(50, Math.max(1, Math.floor(limit)));
  const safeOffset = Math.min(10_000, Math.max(0, Math.floor(offset)));
  const response = await fetchWithTimeout(
    `${resolveApiBaseUrl()}/stories/${encodeURIComponent(storySlug)}?limit=${safeLimit}&offset=${safeOffset}`,
    { signal: options?.signal },
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
  const pagination = parseStoryPagination(payload.pagination, story, events.length, safeLimit, safeOffset);

  return { story, events, pagination };
}

function parseStoryPagination(
  value: unknown,
  story: StorySummary,
  eventCount: number,
  fallbackLimit: number,
  fallbackOffset: number,
): StoryPagination {
  if (isRecord(value)) {
    const limit = nonNegativeInteger(value.limit) && value.limit > 0 ? value.limit : fallbackLimit;
    const offset = nonNegativeInteger(value.offset) ? value.offset : fallbackOffset;
    const total = nonNegativeInteger(value.total) ? value.total : story.eventCount;
    const nextOffset = nonNegativeInteger(value.nextOffset) ? value.nextOffset : null;
    return {
      limit,
      offset,
      total,
      hasMore: value.hasMore === true && nextOffset !== null,
      nextOffset,
    };
  }

  const nextOffset = fallbackOffset + eventCount;
  const hasMore = nextOffset < story.eventCount;
  return {
    limit: fallbackLimit,
    offset: fallbackOffset,
    total: story.eventCount,
    hasMore,
    nextOffset: hasMore ? nextOffset : null,
  };
}

export function parseStorySummary(value: unknown): StorySummary | null {
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
    markets: parseStoryMarkets(value.markets),
  };
}

/**
 * The story's linked Hyperliquid markets (#691). A missing or non-array value
 * gives `[]`; a malformed entry is dropped, never the story.
 */
function parseStoryMarkets(value: unknown): StoryMarket[] {
  if (!Array.isArray(value)) return [];
  const parsed = new Map<string, StoryMarket>();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if (
      !nonEmptyString(entry.symbol)
      || !nonEmptyString(entry.displaySymbol)
      || !nonEmptyString(entry.displayName)
      || (entry.rank !== 1 && entry.rank !== 2 && entry.rank !== 3)
    ) {
      continue;
    }
    const price = finiteOrNull(entry.price);
    const market: StoryMarket = {
      symbol: entry.symbol.trim(),
      displaySymbol: entry.displaySymbol.trim(),
      displayName: entry.displayName.trim(),
      rank: entry.rank,
      price,
      // The server nulls a change and its stamp whenever the price is stale.
      change24hPct: price === null ? null : finiteOrNull(entry.change24hPct),
      asOf: price === null ? null : isoOrNull(entry.asOf),
    };
    // A repeated symbol keeps its lowest-rank row.
    const existing = parsed.get(market.symbol);
    if (existing && existing.rank <= market.rank) continue;
    parsed.set(market.symbol, market);
  }
  return [...parsed.values()].sort((a, b) => a.rank - b.rank).slice(0, 3);
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isoOrNull(value: unknown): string | null {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value)) ? value.trim() : null;
}

/**
 * 1h candles for one Hyperliquid market, `count` bars oldest first. The
 * endpoint answers 400 (missing symbol or bad interval), 404 (unknown
 * market), 503 (no price snapshot) or 502 (candle upstream down).
 */
export async function fetchStoryMarketCandles(
  symbol: string,
  options?: { readonly signal?: AbortSignal },
): Promise<MarketCandle[]> {
  const response = await fetchWithTimeout(
    `${resolveApiBaseUrl()}/market/hyperliquid/candles?symbol=${encodeURIComponent(symbol)}&interval=1h&count=24`,
    { signal: options?.signal },
  );
  if (!response.ok) throw new Error(`Candles request failed (${response.status})`);

  const payload = (await response.json()) as HyperliquidCandlesResponse | null;
  if (!payload || !Array.isArray(payload.candles)) {
    throw new Error('Invalid Candles response');
  }
  return payload.candles;
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

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
