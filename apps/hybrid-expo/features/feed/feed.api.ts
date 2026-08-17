import type { FeedItem, PredictOutcome } from '@/features/feed/feed.types';
import { resolveApiBaseUrl, fetchWithTimeout } from '@/lib/api';

interface PublishedNarrativeListItem {
  updateKey: string;
  title: string;
  summary: string;
  publishedAt: string;
  imageUrl?: string | null;
  imageKind?: 'content' | 'source_avatar' | null;
  imageAttribution?: string | null;
}

export function getApiBaseUrl(): string {
  return resolveApiBaseUrl();
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
  };
}

export async function fetchFeedItems(limit = 20, offset = 0): Promise<FeedItem[]> {
  const clamped = clamp(limit, 1, 50);
  const baseUrl = resolveApiBaseUrl();
  const response = await fetchWithTimeout(`${baseUrl}/narratives?limit=${clamped}&offset=${offset}`);

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

export interface SimpleExplanation {
  id?: string;
  explanation: string;
  cached: boolean;
  model?: string | null;
  createdAt?: string;
}

export async function fetchNarrativeDetail(id: string): Promise<NarrativeDetail> {
  const baseUrl = resolveApiBaseUrl();
  const response = await fetchWithTimeout(`${baseUrl}/narratives/${encodeURIComponent(id)}`);

  if (!response.ok) {
    throw new Error(`Narrative detail request failed (${response.status})`);
  }

  const payload = (await response.json()) as unknown;
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid narrative detail response');
  }

  return payload as NarrativeDetail;
}

export async function fetchSimpleExplanation(params: {
  contentId: string;
  contentType?: string;
  title?: string;
  content: string;
}): Promise<SimpleExplanation> {
  const baseUrl = resolveApiBaseUrl();
  const response = await fetchWithTimeout(`${baseUrl}/ai/explain-simply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload && typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : `Explain request failed (${response.status})`;
    throw new Error(message);
  }

  if (!payload || typeof payload !== 'object' || typeof (payload as { explanation?: unknown }).explanation !== 'string') {
    throw new Error('Invalid explanation response');
  }

  return payload as SimpleExplanation;
}

export interface PredictMarketData {
  slug: string;
  question: string | null;
  marketType: 'binary' | 'multi';
  // binary fields
  yesPrice: number | null;
  noPrice: number | null;
  // multi fields
  outcomes: PredictOutcome[];
  volume24h: number | null;
  // price change / resolve metadata
  endDateIso: string | null;
  oneDayPriceChange: number | null;
  oneWeekPriceChange: number | null;
}

const SPORT_PREFIXES = ['ucl', 'epl', 'lol', 'nba', 'nfl', 'ncaa'];

export function detectSlugType(slug: string): 'sports' | 'geo' {
  const prefix = slug.split('-')[0].toLowerCase();
  return SPORT_PREFIXES.includes(prefix) ? 'sports' : 'geo';
}

export function extractSport(slug: string): string {
  return slug.split('-')[0].toLowerCase();
}

function parseNullableNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export async function fetchPredictMarket(slug: string): Promise<PredictMarketData | null> {
  const type = detectSlugType(slug);

  if (type === 'sports') {
    return fetchSportsMarket(slug);
  }
  return fetchGeoMarket(slug);
}

async function fetchGeoMarket(slug: string): Promise<PredictMarketData | null> {
  const baseUrl = resolveApiBaseUrl();
  const response = await fetchWithTimeout(`${baseUrl}/polymarket/markets/${encodeURIComponent(slug)}`);

  if (!response.ok) {
    return null;
  }

  const raw = (await response.json()) as Record<string, unknown>;

  // The /polymarket/markets/:slug endpoint returns the raw Gamma market object.
  // We need to derive yesPrice/noPrice from outcomePrices or bestBid/bestAsk if available,
  // or fall back to the prices already embedded in the response from the all-markets endpoint
  // which fetches them via CLOB. For the single-slug route the API returns raw Gamma data,
  // so we parse outcomePrices[0] (Yes) and outcomePrices[1] (No) from the first market
  // in the markets array if present, otherwise from top-level outcomePrices.
  let yesPrice: number | null = null;
  let noPrice: number | null = null;

  // outcomePrices from Gamma is a JSON string e.g. "[\"0.295\", \"0.705\"]" — parse it
  let rawOutcomePrices: unknown[] = [];
  if (Array.isArray(raw.outcomePrices)) {
    rawOutcomePrices = raw.outcomePrices;
  } else if (typeof raw.outcomePrices === 'string') {
    try { rawOutcomePrices = JSON.parse(raw.outcomePrices); } catch { /* ignore */ }
  }
  if (rawOutcomePrices.length >= 2) {
    yesPrice = parseNullableNumber(rawOutcomePrices[0]);
    noPrice = parseNullableNumber(rawOutcomePrices[1]);
  }

  // If already computed by the all-markets route (it enriches yesPrice/noPrice), use those
  if (typeof raw.yesPrice === 'number' || typeof raw.yesPrice === 'string') {
    yesPrice = parseNullableNumber(raw.yesPrice);
  }
  if (typeof raw.noPrice === 'number' || typeof raw.noPrice === 'string') {
    noPrice = parseNullableNumber(raw.noPrice);
  }

  return {
    slug: typeof raw.slug === 'string' ? raw.slug : slug,
    question: typeof raw.question === 'string' ? raw.question : (typeof raw.title === 'string' ? raw.title : null),
    marketType: 'binary',
    yesPrice,
    noPrice,
    outcomes: [],
    volume24h: parseNullableNumber(raw.volume24hr ?? raw.volume_24h ?? raw.volume ?? null),
    endDateIso: typeof raw.endDateIso === 'string' ? raw.endDateIso : null,
    oneDayPriceChange: parseNullableNumber(raw.oneDayPriceChange),
    oneWeekPriceChange: parseNullableNumber(raw.oneWeekPriceChange),
  };
}

async function fetchSportsMarket(slug: string): Promise<PredictMarketData | null> {
  const sport = extractSport(slug);
  const baseUrl = resolveApiBaseUrl();
  const res = await fetchWithTimeout(`${baseUrl}/polymarket/sports/${sport}/${encodeURIComponent(slug)}`);
  if (!res.ok) return null;
  const data = (await res.json()) as Record<string, unknown>;

  return {
    slug,
    question: typeof data.title === 'string' ? data.title : null,
    marketType: 'multi',
    yesPrice: null,
    noPrice: null,
    outcomes: (Array.isArray(data.outcomes) ? data.outcomes : []).map((o: Record<string, unknown>) => ({
      label: typeof o.label === 'string' ? o.label : String(o.label ?? ''),
      price: typeof o.price === 'number' ? o.price : parseFloat(String(o.price ?? '0')) || 0,
    })),
    volume24h: parseNullableNumber(data.volume24h ?? null),
    endDateIso: null,
    oneDayPriceChange: null,
    oneWeekPriceChange: null,
  };
}
