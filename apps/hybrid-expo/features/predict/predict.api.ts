import type {
  EventContext,
  EventOutcomeMarket,
  FeedItem,
  FeedItemBinary,
  FeedItemMatch,
  FeedItemStatus,
  FeedTeam,
  FeedOutcome,
  FeedResponse,
  GeopoliticsMarket,
  GeopoliticsMarketDetail,
  LivePrice,
  PredictSport,
  PriceHistory,
  PricePoint,
  SportMarket,
  SportMarketDetail,
  SportOutcome,
  SportOutcomeDetail,
  TrendingMarket,
} from '@/features/predict/predict.types';
import { OrderSide, OrderType } from '@polymarket/client';
import { fetchBalanceAllowance, fetchTransaction } from '@polymarket/client/actions';
import type { SecureClient, TransactionHandle } from '@polymarket/client';
import { resolveApiBaseUrl, fetchWithTimeout } from '@/lib/api';
import { normalizePredictError } from './predict.errors';
import { POLYMARKET_BUILDER_CODE } from './predict.signing';

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((e): e is string => typeof e === 'string');
    } catch { /* not JSON */ }
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

export type PredictOperationStatus =
  | 'submitted'
  | 'waiting_to_match'
  | 'filled'
  | 'not_filled'
  | 'cancel_requested'
  | 'cancelled'
  | 'collecting'
  | 'bridging'
  | 'completed'
  | 'needs_signature'
  | 'failed';

export interface PredictOperationMeta {
  operationId?: string;
  status?: PredictOperationStatus;
  userMessage?: string;
  code?: string;
}

function mapGeopoliticsMarket(row: unknown): GeopoliticsMarket | null {
  if (!row || typeof row !== 'object') return null;
  const market = row as Record<string, unknown>;

  const slug = typeof market.slug === 'string' ? market.slug : null;
  const question = typeof market.question === 'string' ? market.question : null;
  if (!slug || !question) return null;

  return {
    slug,
    question,
    category: 'geopolitics',
    conditionId: typeof market.conditionId === 'string' ? market.conditionId : null,
    clobTokenIds: toStringArray(market.clobTokenIds),
    yesPrice: toNumber(market.yesPrice),
    noPrice: toNumber(market.noPrice),
    volume24h: toNumber(market.volume24h),
    liquidity: toNumber(market.liquidityNum ?? market.liquidity),
    endDate: typeof market.endDate === 'string' ? market.endDate : null,
    active: typeof market.active === 'boolean' ? market.active : null,
    image: typeof market.image === 'string' ? market.image : null,
  };
}

function mapSportOutcome(row: unknown): SportOutcome | null {
  if (!row || typeof row !== 'object') return null;
  const outcome = row as Record<string, unknown>;
  const label = typeof outcome.label === 'string' ? outcome.label : null;
  if (!label) return null;

  return {
    label,
    price: toNumber(outcome.price),
    conditionId: typeof outcome.conditionId === 'string' ? outcome.conditionId : null,
    clobTokenIds: toStringArray(outcome.clobTokenIds),
  };
}

function mapSportMarket(row: unknown): SportMarket | null {
  if (!row || typeof row !== 'object') return null;
  const market = row as Record<string, unknown>;

  const slug = typeof market.slug === 'string' ? market.slug : null;
  const title = typeof market.title === 'string' ? market.title : null;
  const sport = market.sport === 'epl' || market.sport === 'ucl' ? market.sport : null;
  if (!slug || !title || !sport) return null;

  const outcomesRaw = Array.isArray(market.outcomes) ? market.outcomes : [];
  const outcomes = outcomesRaw.map(mapSportOutcome).filter((outcome): outcome is SportOutcome => outcome !== null);

  return {
    slug,
    title,
    sport,
    startDate: typeof market.startDate === 'string' ? market.startDate : null,
    endDate: typeof market.endDate === 'string' ? market.endDate : null,
    image: typeof market.image === 'string' ? market.image : null,
    active: typeof market.active === 'boolean' ? market.active : null,
    volume24h: toNumber(market.volume24h),
    liquidity: toNumber(market.liquidity),
    negRisk: market.negRisk === true,
    outcomes,
  };
}

function mapEventOutcome(row: unknown): EventOutcomeMarket | null {
  if (!row || typeof row !== 'object') return null;
  const o = row as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id : null;
  const label = typeof o.label === 'string' ? o.label : null;
  if (!id || !label) return null;
  return {
    id,
    slug: typeof o.slug === 'string' ? o.slug : '',
    label,
    price: toNumber(o.price),
    conditionId: typeof o.conditionId === 'string' ? o.conditionId : null,
    clobTokenIds: toStringArray(o.clobTokenIds),
    active: typeof o.active === 'boolean' ? o.active : null,
    closed: o.closed === true,
    volume24h: toNumber(o.volume24h),
  };
}

function mapEventContext(row: unknown): EventContext | null {
  if (!row || typeof row !== 'object') return null;
  const ev = row as Record<string, unknown>;
  const slug = typeof ev.slug === 'string' ? ev.slug : null;
  const title = typeof ev.title === 'string' ? ev.title : null;
  if (!slug || !title) return null;
  const outcomesRaw = Array.isArray(ev.outcomes) ? ev.outcomes : [];
  const outcomes = outcomesRaw.map(mapEventOutcome).filter((o): o is EventOutcomeMarket => o !== null);
  // Fewer than 2 real outcomes means this is not actually a multi-outcome event.
  if (outcomes.length < 2) return null;
  return {
    slug,
    title,
    description: typeof ev.description === 'string' ? ev.description : null,
    endDate: typeof ev.endDate === 'string' ? ev.endDate : null,
    active: typeof ev.active === 'boolean' ? ev.active : null,
    negRisk: ev.negRisk === true,
    volume24h: toNumber(ev.volume24h),
    outcomes,
  };
}

function mapGeopoliticsMarketDetail(row: unknown): GeopoliticsMarketDetail | null {
  if (!row || typeof row !== 'object') return null;
  const market = row as Record<string, unknown>;

  const slug = typeof market.slug === 'string' ? market.slug : null;
  const question = typeof market.question === 'string' ? market.question : null;
  if (!slug || !question) return null;

  const outcomesRaw = typeof market.outcomes === 'string' ? market.outcomes : null;
  const outcomePricesRaw = typeof market.outcomePrices === 'string' ? market.outcomePrices : null;

  let outcomes: string[] = [];
  let outcomePrices: number[] = [];

  if (outcomesRaw) {
    try {
      const parsed = JSON.parse(outcomesRaw) as unknown;
      if (Array.isArray(parsed)) outcomes = parsed.filter((value): value is string => typeof value === 'string');
    } catch {
      outcomes = [];
    }
  }

  if (outcomePricesRaw) {
    try {
      const parsed = JSON.parse(outcomePricesRaw) as unknown;
      if (Array.isArray(parsed)) {
        outcomePrices = parsed
          .map((value) => toNumber(value))
          .filter((value): value is number => value !== null);
      }
    } catch {
      outcomePrices = [];
    }
  }

  return {
    slug,
    question,
    description: typeof market.description === 'string' ? market.description : null,
    category: typeof market.category === 'string' ? market.category : null,
    endDate: typeof market.endDate === 'string' ? market.endDate : null,
    active: typeof market.active === 'boolean' ? market.active : null,
    volume24h: toNumber(market.volume24hr ?? market.volume24h),
    volume: toNumber(market.volumeNum ?? market.volume),
    liquidity: toNumber(market.liquidityNum ?? market.liquidity),
    outcomes,
    outcomePrices,
    clobTokenIds: toStringArray(market.clobTokenIds),
    image: typeof market.image === 'string' ? market.image : null,
    negRisk: market.negRisk === true,
    event: mapEventContext(market.event),
  };
}

function mapSportOutcomeDetail(row: unknown): SportOutcomeDetail | null {
  if (!row || typeof row !== 'object') return null;
  const outcome = row as Record<string, unknown>;
  const label = typeof outcome.label === 'string' ? outcome.label : null;
  if (!label) return null;

  return {
    label,
    question: typeof outcome.question === 'string' ? outcome.question : null,
    price: toNumber(outcome.price),
    conditionId: typeof outcome.conditionId === 'string' ? outcome.conditionId : null,
    clobTokenIds: toStringArray(outcome.clobTokenIds),
    liquidity: toNumber(outcome.liquidity),
    volume24h: toNumber(outcome.volume24h),
    bestBid: toNumber(outcome.bestBid),
    bestAsk: toNumber(outcome.bestAsk),
    acceptingOrders: typeof outcome.acceptingOrders === 'boolean' ? outcome.acceptingOrders : null,
  };
}

function mapSportMarketDetail(row: unknown): SportMarketDetail | null {
  if (!row || typeof row !== 'object') return null;
  const market = row as Record<string, unknown>;

  const slug = typeof market.slug === 'string' ? market.slug : null;
  const title = typeof market.title === 'string' ? market.title : null;
  const sport = typeof market.sport === 'string' ? market.sport : null;
  if (!slug || !title || !sport) return null;

  const outcomesRaw = Array.isArray(market.outcomes) ? market.outcomes : [];
  const outcomes = outcomesRaw
    .map(mapSportOutcomeDetail)
    .filter((outcome): outcome is SportOutcomeDetail => outcome !== null);

  const rawStatus = typeof market.status === 'string' ? market.status : 'n/a';
  const status: FeedItemStatus =
    rawStatus === 'live' || rawStatus === 'upcoming' || rawStatus === 'closed'
      ? rawStatus
      : 'n/a';

  return {
    slug,
    title,
    description: typeof market.description === 'string' ? market.description : null,
    sport,
    status,
    startDate: typeof market.startDate === 'string' ? market.startDate : null,
    endDate: typeof market.endDate === 'string' ? market.endDate : null,
    image: typeof market.image === 'string' ? market.image : null,
    active: typeof market.active === 'boolean' ? market.active : null,
    negRisk: market.negRisk === true,
    volume24h: toNumber(market.volume24h),
    liquidity: toNumber(market.liquidity),
    outcomes,
  };
}

async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const baseUrl = resolveApiBaseUrl();
  const response = await fetchWithTimeout(`${baseUrl}${path}`, { signal });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }
  return response.json();
}

/**
 * @deprecated Use fetchFeaturedMarkets() instead. This endpoint returns the old per-category
 * curated markets list and will be removed once all screens migrate to the unified feed.
 */
export async function fetchCuratedMarkets(): Promise<GeopoliticsMarket[]> {
  const payload = await getJson('/polymarket/markets');
  if (!Array.isArray(payload)) throw new Error('Invalid markets response');

  return payload
    .map(mapGeopoliticsMarket)
    .filter((market): market is GeopoliticsMarket => market !== null);
}

/**
 * @deprecated Use fetchFeaturedMarkets() instead. This endpoint returns sport-specific markets
 * and will be removed once all screens migrate to the unified feed.
 */
export async function fetchSportsMarkets(sport: PredictSport): Promise<SportMarket[]> {
  const payload = await getJson(`/polymarket/sports/${sport}`);
  if (!Array.isArray(payload)) throw new Error('Invalid sports response');

  return payload
    .map(mapSportMarket)
    .filter((market): market is SportMarket => market !== null);
}

const SLUG_BLOCKLIST = ['halftime', 'exact-score'];

function isBlockedSlug(slug: string): boolean {
  return SLUG_BLOCKLIST.some((term) => slug.includes(term));
}

function mapFeedOutcome(raw: unknown): FeedOutcome | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const label = typeof o.label === 'string' ? o.label : null;
  const price = toNumber(o.price);
  if (!label || price === null) return null;
  return {
    label,
    price,
    conditionId: typeof o.conditionId === 'string' ? o.conditionId : undefined,
    clobTokenIds: Array.isArray(o.clobTokenIds)
      ? (o.clobTokenIds as unknown[]).filter((t): t is string => typeof t === 'string')
      : undefined,
  };
}

function mapFeedTeam(raw: unknown): FeedTeam | null {
  if (!raw || typeof raw !== 'object') return null;
  const team = raw as Record<string, unknown>;
  const name = typeof team.name === 'string' ? team.name : null;
  if (!name) return null;
  return {
    name,
    logo: typeof team.logo === 'string' ? team.logo : null,
    abbreviation: typeof team.abbreviation === 'string' ? team.abbreviation : null,
    alias: typeof team.alias === 'string' ? team.alias : null,
    color: typeof team.color === 'string' ? team.color : null,
    ordering: typeof team.ordering === 'string' ? team.ordering : null,
  };
}

function mapFeedItem(raw: unknown): FeedItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;

  const type = item.type;
  const slug = typeof item.slug === 'string' ? item.slug : null;
  if (!slug || isBlockedSlug(slug)) return null;

  const title = typeof item.title === 'string' ? item.title : typeof item.question === 'string' ? item.question : null;
  if (!title) return null;

  const category = typeof item.category === 'string' ? item.category : 'other';
  const tags = Array.isArray(item.tags)
    ? (item.tags as unknown[]).filter((t): t is string => typeof t === 'string')
    : [];
  const status = typeof item.status === 'string' ? (item.status as FeedItemMatch['status']) : 'n/a';
  const image = typeof item.image === 'string' ? item.image : null;
  const active = item.active === true;
  const volume = toNumber(item.volume) ?? 0;
  const endDate = typeof item.endDate === 'string' ? item.endDate : null;

  const outcomesRaw = Array.isArray(item.outcomes) ? item.outcomes : [];
  const outcomes = outcomesRaw.map(mapFeedOutcome).filter((o): o is FeedOutcome => o !== null);
  const teamsRaw = Array.isArray(item.teams) ? item.teams : [];
  const teams = teamsRaw.map(mapFeedTeam).filter((team): team is FeedTeam => team !== null);

  if (type === 'match') {
    const sport = typeof item.sport === 'string' ? item.sport : null;
    if (!sport) return null;
    const result: FeedItemMatch = {
      type: 'match',
      slug,
      title,
      category,
      sport,
      tags,
      status,
      gameStartTime: typeof item.gameStartTime === 'string' && item.gameStartTime !== '' ? item.gameStartTime : null,
      startDate: typeof item.startDate === 'string' && item.startDate !== '' ? item.startDate : null,
      endDate,
      image,
      active,
      volume,
      teams,
      outcomes,
    };
    return result;
  }

  if (type === 'binary') {
    const price = toNumber(item.price) ?? toNumber(item.yesPrice) ?? 0;
    const clobTokenIds = Array.isArray(item.clobTokenIds)
      ? (item.clobTokenIds as unknown[]).filter((t): t is string => typeof t === 'string')
      : undefined;
    const result: FeedItemBinary = {
      type: 'binary',
      slug,
      title,
      category,
      tags,
      status,
      image,
      active,
      volume,
      price,
      endDate,
      outcomes,
      clobTokenIds,
    };
    return result;
  }

  return null;
}

/** Fetch the published, dashboard-controlled Polymarket collection. */
export async function fetchFeaturedMarkets(): Promise<FeedResponse> {
  const payload = await getJson('/polymarket/collections/featured');
  if (!payload || typeof payload !== 'object') throw new Error('Invalid feed response');
  const p = payload as Record<string, unknown>;

  const rawItems = Array.isArray(p.items) ? p.items : [];
  const items = rawItems.map(mapFeedItem).filter((item): item is FeedItem => item !== null);

  const categories = Array.isArray(p.categories)
    ? (p.categories as unknown[]).filter((c): c is string => typeof c === 'string')
    : [];

  return { items, categories };
}

// --- One Tap Up/Down (Predict redesign PRD §2) ---

export interface UpDownRound {
  slug: string;
  asset: 'btc' | 'eth';
  duration: 'hourly' | 'daily';
  question: string;
  startDate: string | null;
  endDate: string | null;
  active: boolean | null;
  closed: boolean;
  volume24h: number | null;
  upPrice: number | null;
  downPrice: number | null;
  clobTokenIds: string[];
  conditionId: string | null;
  resolutionSource: string | null;
  rules: string | null;
  priceToBeat: number | null;
  priceToBeatSource: {
    value: number;
    source: string;
    symbol: string;
    interval: string;
    valueType: string;
    boundaryTime: string;
    observedAt: string;
  } | null;
  currentPrice: number | null;
  currentPriceSource: {
    value: number;
    source: string;
    symbol: string;
    observedAt: string;
  } | null;
}

export interface UpDownRounds {
  btc: { hourly: UpDownRound | null; daily: UpDownRound | null };
  eth: { hourly: UpDownRound | null; daily: UpDownRound | null };
}

export async function fetchUpDownRounds(): Promise<UpDownRounds> {
  const payload = await getJson('/polymarket/updown');
  if (!payload || typeof payload !== 'object') throw new Error('Invalid updown response');
  const p = payload as Record<string, unknown>;
  function bucket(row: unknown): UpDownRounds['btc'] {
    const r = (row ?? {}) as Record<string, unknown>;
    return { hourly: (r.hourly as UpDownRound | null) ?? null, daily: (r.daily as UpDownRound | null) ?? null };
  }
  return { btc: bucket(p.btc), eth: bucket(p.eth) };
}

export interface UpDownHistoryPoint {
  t: number;
  p: number;
}

export interface UpDownHistory {
  source: string;
  symbol: string;
  interval: string;
  points: UpDownHistoryPoint[];
  asset: 'btc' | 'eth';
  duration: 'hourly' | 'daily';
  slug: string;
  startDate: string;
  endDate: string;
  priceToBeat: number | null;
  currentPrice: number | null;
}

export async function fetchUpDownHistory(
  asset: UpDownRound['asset'],
  duration: UpDownRound['duration'],
): Promise<UpDownHistory> {
  const payload = await getJson(`/polymarket/updown/${asset}/${duration}/history`);
  if (!payload || typeof payload !== 'object') throw new Error('Invalid updown history response');
  const p = payload as Record<string, unknown>;
  const points = Array.isArray(p.points)
    ? p.points.flatMap((row): UpDownHistoryPoint[] => {
        if (!row || typeof row !== 'object') return [];
        const point = row as Record<string, unknown>;
        const t = toNumber(point.t);
        const price = toNumber(point.p);
        return t !== null && price !== null ? [{ t, p: price }] : [];
      })
    : [];
  return {
    source: typeof p.source === 'string' ? p.source : '',
    symbol: typeof p.symbol === 'string' ? p.symbol : '',
    interval: typeof p.interval === 'string' ? p.interval : '',
    points,
    asset,
    duration,
    slug: typeof p.slug === 'string' ? p.slug : '',
    startDate: typeof p.startDate === 'string' ? p.startDate : '',
    endDate: typeof p.endDate === 'string' ? p.endDate : '',
    priceToBeat: toNumber(p.priceToBeat),
    currentPrice: toNumber(p.currentPrice),
  };
}

export interface PredictSearchEvent {
  id: string;
  slug: string;
  detailSlug: string;
  title: string;
  image: string | null;
  active: boolean | null;
  endDate: string | null;
  volume24h: number | null;
  marketCount: number;
  kind: 'sports' | 'prediction';
  outcomes: Array<{ label: string; price: number | null }>;
}

export interface PredictSearchTag {
  id: string;
  slug: string;
  label: string;
}

export interface PredictSearchTeam {
  id: string;
  name: string;
  league: string | null;
  logo: string | null;
  abbreviation: string | null;
  alias: string | null;
}

export interface PredictSearchResponse {
  query: string;
  page: number;
  hasMore: boolean;
  events: PredictSearchEvent[];
  tags: PredictSearchTag[];
  teams: PredictSearchTeam[];
}

export async function fetchPredictSearch(
  query: string,
  signal?: AbortSignal,
): Promise<PredictSearchResponse> {
  const payload = await getJson(`/polymarket/search?q=${encodeURIComponent(query)}`, signal);
  if (!payload || typeof payload !== 'object') throw new Error('Invalid search response');
  const p = payload as PredictSearchResponse;
  const events = Array.isArray(p.events)
    ? p.events.flatMap((raw): PredictSearchEvent[] => {
        if (!raw || typeof raw !== 'object') return [];
        const event = raw as unknown as Record<string, unknown>;
        const id = typeof event.id === 'string' ? event.id : null;
        const slug = typeof event.slug === 'string' ? event.slug : null;
        const title = typeof event.title === 'string' ? event.title : null;
        if (!id || !slug || !title) return [];
        return [{
          id,
          slug,
          detailSlug: typeof event.detailSlug === 'string' && event.detailSlug ? event.detailSlug : slug,
          title,
          image: typeof event.image === 'string' ? event.image : null,
          active: typeof event.active === 'boolean' ? event.active : null,
          endDate: typeof event.endDate === 'string' ? event.endDate : null,
          volume24h: toNumber(event.volume24h),
          marketCount: toNumber(event.marketCount) ?? 0,
          kind: event.kind === 'sports' ? 'sports' : 'prediction',
          outcomes: Array.isArray(event.outcomes)
            ? event.outcomes.flatMap((rawOutcome): Array<{ label: string; price: number | null }> => {
                if (!rawOutcome || typeof rawOutcome !== 'object') return [];
                const outcome = rawOutcome as Record<string, unknown>;
                return typeof outcome.label === 'string'
                  ? [{ label: outcome.label, price: toNumber(outcome.price) }]
                  : [];
              })
            : [],
        }];
      })
    : [];
  return {
    query: typeof p.query === 'string' ? p.query : query,
    page: typeof p.page === 'number' ? p.page : 1,
    hasMore: p.hasMore === true,
    events,
    tags: Array.isArray(p.tags) ? p.tags : [],
    teams: Array.isArray(p.teams) ? p.teams : [],
  };
}

export async function fetchCuratedMarketDetail(slug: string): Promise<GeopoliticsMarketDetail> {
  const payload = await getJson(`/polymarket/markets/${encodeURIComponent(slug)}`);
  const detail = mapGeopoliticsMarketDetail(payload);
  if (!detail) throw new Error('Invalid market detail response');
  return detail;
}

export async function fetchSportMarketDetail(sport: string, slug: string): Promise<SportMarketDetail> {
  const payload = await getJson(`/polymarket/sports/${sport}/${encodeURIComponent(slug)}`);
  const detail = mapSportMarketDetail(payload);
  if (!detail) throw new Error('Invalid sport detail response');
  return detail;
}

function mapTrendingMarket(row: unknown): TrendingMarket | null {
  if (!row || typeof row !== 'object') return null;
  const m = row as Record<string, unknown>;
  const slug = typeof m.slug === 'string' ? m.slug : null;
  const question = typeof m.question === 'string' ? m.question : null;
  if (!slug || !question) return null;
  return {
    slug,
    question,
    category: typeof m.category === 'string' ? m.category : 'geopolitics',
    yesPrice: toNumber(m.yesPrice),
    noPrice: toNumber(m.noPrice),
    volume24h: toNumber(m.volume24h),
    endDate: typeof m.endDate === 'string' ? m.endDate : null,
    active: typeof m.active === 'boolean' ? m.active : null,
    image: typeof m.image === 'string' ? m.image : null,
  };
}

export async function fetchTrendingMarkets(limit = 10): Promise<TrendingMarket[]> {
  const payload = await getJson(`/polymarket/trending?limit=${limit}`);
  if (!Array.isArray(payload)) throw new Error('Invalid trending response');
  return payload.map(mapTrendingMarket).filter((m): m is TrendingMarket => m !== null);
}

export async function fetchMarketPrice(slug: string): Promise<LivePrice> {
  const payload = await getJson(`/polymarket/markets/${encodeURIComponent(slug)}/price`);
  if (!payload || typeof payload !== 'object') throw new Error('Invalid price response');
  const p = payload as Record<string, unknown>;
  return {
    slug: typeof p.slug === 'string' ? p.slug : slug,
    yesPrice: toNumber(p.yesPrice),
    noPrice: toNumber(p.noPrice),
    fetchedAt: typeof p.fetchedAt === 'string' ? p.fetchedAt : new Date().toISOString(),
  };
}

export async function fetchLivePrices(tokenIds: string[]): Promise<Record<string, number | null>> {
  const uniqueTokenIds = [...new Set(tokenIds.map((tokenId) => tokenId.trim()).filter(Boolean))];
  if (uniqueTokenIds.length === 0) return {};

  const payload = await getJson(`/polymarket/live-prices?tokenIds=${encodeURIComponent(uniqueTokenIds.join(','))}`);
  if (!payload || typeof payload !== 'object') throw new Error('Invalid live prices response');
  const p = payload as Record<string, unknown>;
  const rows = Array.isArray(p.prices) ? p.prices : [];

  const prices: Record<string, number | null> = {};
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const entry = row as Record<string, unknown>;
    const tokenId = typeof entry.tokenId === 'string' ? entry.tokenId : null;
    if (!tokenId) continue;
    prices[tokenId] = toNumber(entry.price);
  }

  return prices;
}

export interface PlaceBetParams {
  tokenID: string;
  price: number;
  size?: number;
  amount?: number;
  side: 'BUY' | 'SELL';
  negRisk?: boolean;
  orderType?: 'GTC' | 'GTD' | 'FOK' | 'FAK';
  /** Unix seconds. Required by the CLOB when orderType is GTD. */
  expiration?: number;
}

export interface PlaceBetResult extends PredictOperationMeta {
  orderID?: string;
  success: boolean;
  error?: string;
  estimatedPrice?: number;
  executionPrice?: number;
  shares?: number;
  amount?: number;
  expectedPayout?: number;
  tradeIds?: string[];
}

export async function placeBet(client: SecureClient, params: PlaceBetParams): Promise<PlaceBetResult> {
  try {
    const isMarket = params.orderType === 'FOK' || params.orderType === 'FAK';
    let estimatedPrice: number | undefined;
    if (isMarket) {
      estimatedPrice = await client.estimateMarketPrice(params.side === 'BUY'
        ? {
            tokenId: params.tokenID,
            side: OrderSide.BUY,
            amount: params.amount ?? (params.size ?? 0) * params.price,
            orderType: params.orderType === 'FOK' ? OrderType.FOK : OrderType.FAK,
          }
        : {
            tokenId: params.tokenID,
            side: OrderSide.SELL,
            shares: params.size ?? 0,
            orderType: params.orderType === 'FOK' ? OrderType.FOK : OrderType.FAK,
          });
      const outsideProtection = params.side === 'BUY'
        ? estimatedPrice > params.price
        : estimatedPrice < params.price;
      if (outsideProtection) {
        return {
          success: false,
          status: 'not_filled',
          code: 'PRICE_PROTECTION',
          error: 'Not filled. The executable SDK price moved outside your reviewed limit.',
          estimatedPrice,
        };
      }
    }
    const response = isMarket
      ? await client.placeMarketOrder(params.side === 'BUY'
        ? {
            tokenId: params.tokenID,
            side: OrderSide.BUY,
            amount: params.amount ?? (params.size ?? 0) * params.price,
            maxPrice: estimatedPrice ?? params.price,
            maxSpend: params.amount,
            orderType: params.orderType === 'FOK' ? OrderType.FOK : OrderType.FAK,
            builderCode: POLYMARKET_BUILDER_CODE,
          }
        : {
            tokenId: params.tokenID,
            side: OrderSide.SELL,
            shares: params.size ?? 0,
            minPrice: estimatedPrice ?? params.price,
            orderType: params.orderType === 'FOK' ? OrderType.FOK : OrderType.FAK,
            builderCode: POLYMARKET_BUILDER_CODE,
          })
      : await client.placeLimitOrder({
          tokenId: params.tokenID,
          side: params.side === 'BUY' ? OrderSide.BUY : OrderSide.SELL,
          size: params.size ?? 0,
          price: params.price,
          builderCode: POLYMARKET_BUILDER_CODE,
          ...(params.orderType === 'GTD' && params.expiration ? { expiration: params.expiration } : {}),
        });

    if (!response.ok) {
      const normalized = normalizePredictError({ code: response.code, message: response.message });
      return {
        success: false,
        status: normalized.kind === 'liquidity' ? 'not_filled' : 'failed',
        code: normalized.code,
        error: normalized.message,
        estimatedPrice,
      };
    }

    const makingAmount = toNumber(response.makingAmount) ?? 0;
    const takingAmount = toNumber(response.takingAmount) ?? 0;
    let actualShares = params.side === 'BUY' ? takingAmount : makingAmount;
    let actualAmount = params.side === 'BUY' ? makingAmount : takingAmount;
    let executionPrice = actualShares > 0 ? actualAmount / actualShares : undefined;

    // Resting/delayed orders have zero immediate fill amounts. Read back the
    // authoritative SDK order rather than presenting the local preview as the
    // accepted order size/price.
    if (response.status !== 'matched') {
      try {
        const order = await client.fetchOrder({ orderId: response.orderId });
        actualShares = toNumber(order.originalSize) ?? 0;
        executionPrice = toNumber(order.price) ?? undefined;
        actualAmount = actualShares * (executionPrice ?? 0);
      } catch {
        // The placement result remains authoritative; reconciliation will
        // fetch the order again after the upstream index catches up.
      }
    }

    const resultMeta = {
      orderID: response.orderId,
      estimatedPrice,
      ...(executionPrice !== undefined ? { executionPrice } : {}),
      ...(actualShares > 0 ? { shares: actualShares, expectedPayout: actualShares } : {}),
      ...(actualAmount > 0 ? { amount: actualAmount } : {}),
      tradeIds: response.tradeIds,
    };
    if (isMarket && response.status === 'matched') {
      try {
        await client.waitForOrderFillSettlement(response);
      } catch (error) {
        const normalized = normalizePredictError(error, 'Order settlement failed.');
        if (normalized.kind === 'order_waiting') {
          return {
            success: true,
            ...resultMeta,
            status: 'submitted',
            userMessage: 'Order matched. Settlement is still processing.',
          };
        }
        throw error;
      }
    }
    const status: PredictOperationStatus = response.status === 'matched' ? 'filled' : 'waiting_to_match';
    return { success: true, ...resultMeta, status };
  } catch (error) {
    const normalized = normalizePredictError(error, 'Order failed.');
    return { success: false, status: 'failed', code: normalized.code, error: normalized.message };
  }
}

// --- CLOB Open Orders ---

export interface OpenOrder {
  id: string;
  status: string;
  market: string;
  asset_id: string;
  side: string;
  original_size: string;
  size_matched: string;
  price: string;
  outcome: string;
  created_at: number;
  order_type: string;
  /** SDK trade IDs already reflected in size_matched (used for idempotent stream updates). */
  associate_trades?: string[];
}

type SdkOpenOrder = Awaited<ReturnType<SecureClient['fetchOrder']>>;

function mapOpenOrder(order: SdkOpenOrder): OpenOrder {
  return {
    id: order.id,
    status: order.status,
    market: order.conditionId,
    asset_id: order.tokenId,
    side: order.side,
    original_size: order.originalSize,
    size_matched: order.sizeMatched,
    price: order.price,
    outcome: order.outcome,
    created_at: Date.parse(order.createdAt),
    order_type: order.orderType,
    associate_trades: order.associateTrades,
  };
}

export async function fetchOpenOrders(client: SecureClient): Promise<OpenOrder[]> {
  const orders: OpenOrder[] = [];
  for await (const page of client.listOpenOrders()) {
    orders.push(...page.items.map(mapOpenOrder));
  }
  return orders;
}

export async function fetchOpenOrder(client: SecureClient, orderId: string): Promise<OpenOrder> {
  const typedOrderId = orderId as Parameters<SecureClient['fetchOrder']>[0]['orderId'];
  return mapOpenOrder(await client.fetchOrder({ orderId: typedOrderId }));
}

export async function cancelOrder(
  client: SecureClient,
  orderId: string,
): Promise<{ ok: boolean; error?: string } & PredictOperationMeta> {
  try {
    const typedOrderId = orderId as Parameters<SecureClient['cancelOrder']>[0]['orderId'];
    const result = await client.cancelOrder({ orderId: typedOrderId });
    if (result.canceled.some((id) => id === orderId)) return { ok: true, status: 'cancelled' };
    const reason = Object.entries(result.notCanceled).find(([id]) => id === orderId)?.[1];
    return { ok: false, status: 'failed', error: reason || 'Polymarket did not cancel this order.' };
  } catch (error) {
    const normalized = normalizePredictError(error, 'Cancel failed.');
    return { ok: false, status: 'failed', code: normalized.code, error: normalized.message };
  }
}

// --- CLOB Balance ---

export interface ClobBalance {
  balance: number;
  allowance: number;
}

export async function fetchClobBalance(client: SecureClient): Promise<ClobBalance | null> {
  try {
    const assetType = 'COLLATERAL' as Parameters<typeof fetchBalanceAllowance>[1]['assetType'];
    const result = await fetchBalanceAllowance(client, { assetType });
    const allowanceValues = Object.values(result.allowances).map((value) => BigInt(value));
    const allowance = allowanceValues.length > 0
      ? allowanceValues.reduce((minimum, value) => value < minimum ? value : minimum)
      : 0n;
    return {
      balance: Number(BigInt(result.balance)) / 1e6,
      allowance: Number(allowance) / 1e6,
    };
  } catch {
    return null;
  }
}

// --- Deposit Status ---

export type DepositBridgeStatus =
  | 'DEPOSIT_DETECTED'
  | 'PROCESSING'
  | 'ORIGIN_TX_CONFIRMED'
  | 'SUBMITTED'
  | 'COMPLETED'
  | 'FAILED';

export interface DepositBridgeTransaction {
  fromChainId?: string;
  fromTokenAddress?: string;
  fromAmountBaseUnit?: string;
  toChainId?: string;
  toTokenAddress?: string;
  status?: DepositBridgeStatus;
  txHash?: string;
  createdTimeMs?: number;
}

export interface BridgeSupportedAsset {
  chainId: string;
  chainName: string;
  token: {
    name: string;
    symbol: string;
    address: string;
    decimals: number;
  };
  minCheckoutUsd: number;
}

export interface BridgeDepositAddresses {
  evm?: string;
  svm?: string;
  [key: string]: string | undefined;
}

export interface BridgeQuoteFeeBreakdown {
  appFeePercent: number | null;
  appFeeUsd: number | null;
  fillCostPercent: number | null;
  fillCostUsd: number | null;
  gasUsd: number | null;
  maxSlippage: number | null;
  minReceived: number | null;
  swapImpact: number | null;
  totalImpact: number | null;
  totalImpactUsd: number | null;
}

export interface BridgeQuote {
  quoteId: string;
  estCheckoutTimeMs: number;
  estInputUsd: number;
  estOutputUsd: number;
  estToTokenBaseUnit: string;
  estFeeBreakdown: BridgeQuoteFeeBreakdown;
}

export interface BridgeQuoteRequest {
  fromAmountBaseUnit: string;
  fromChainId: string;
  fromTokenAddress: string;
  recipientAddress: string;
  toChainId: string;
  toTokenAddress: string;
}

export const POLYGON_CHAIN_ID = '137';
export const SOLANA_CHAIN_ID = '1151111081099710';
export const POLYGON_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const POLYMARKET_PUSD = '0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb';
export const MAX_WITHDRAW_BRIDGE_IMPACT_PERCENT = 0.1; // 10 basis points

async function bridgeJson(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetchWithTimeout(`${resolveApiBaseUrl()}${path}`, init);
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const detail = typeof data.error === 'string' ? data.error : `Bridge request failed (${response.status})`;
    throw Object.assign(new Error(detail), { status: response.status });
  }
  return data;
}

function mapBridgeAsset(value: unknown): BridgeSupportedAsset | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const token = row.token && typeof row.token === 'object'
    ? row.token as Record<string, unknown>
    : null;
  const minCheckoutUsd = toNumber(row.minCheckoutUsd);
  if (
    typeof row.chainId !== 'string'
    || typeof row.chainName !== 'string'
    || !token
    || typeof token.name !== 'string'
    || typeof token.symbol !== 'string'
    || typeof token.address !== 'string'
    || typeof token.decimals !== 'number'
    || minCheckoutUsd === null
  ) return null;
  return {
    chainId: row.chainId,
    chainName: row.chainName,
    token: {
      name: token.name,
      symbol: token.symbol,
      address: token.address,
      decimals: token.decimals,
    },
    minCheckoutUsd,
  };
}

export async function fetchBridgeSupportedAssets(): Promise<BridgeSupportedAsset[]> {
  const data = await bridgeJson('/clob/bridge/supported-assets');
  const rows = Array.isArray(data.supportedAssets) ? data.supportedAssets : [];
  return rows.map(mapBridgeAsset).filter((asset): asset is BridgeSupportedAsset => asset !== null);
}

/** Deliberately narrow product support: exact native USDC on Polygon/Solana. */
export function selectSupportedDepositAssets(assets: BridgeSupportedAsset[]): BridgeSupportedAsset[] {
  const accepted = new Map([
    [`${POLYGON_CHAIN_ID}:${POLYGON_USDC.toLowerCase()}`, 0],
    [`${SOLANA_CHAIN_ID}:${SOLANA_USDC_MINT.toLowerCase()}`, 1],
  ]);
  return assets
    .filter((asset) => accepted.has(`${asset.chainId}:${asset.token.address.toLowerCase()}`))
    .sort((a, b) => (
      accepted.get(`${a.chainId}:${a.token.address.toLowerCase()}`)!
      - accepted.get(`${b.chainId}:${b.token.address.toLowerCase()}`)!
    ));
}

export async function fetchDepositAddresses(walletAddress: string): Promise<BridgeDepositAddresses> {
  const data = await bridgeJson(`/clob/deposit/${encodeURIComponent(walletAddress)}`);
  const raw = data.address && typeof data.address === 'object'
    ? data.address as Record<string, unknown>
    : data;
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function bridgeFeeNumber(raw: Record<string, unknown>, field: string): number | null {
  return toNumber(raw[field]);
}

export async function fetchBridgeQuote(request: BridgeQuoteRequest): Promise<BridgeQuote> {
  const data = await bridgeJson('/clob/bridge/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  const fees = data.estFeeBreakdown && typeof data.estFeeBreakdown === 'object'
    ? data.estFeeBreakdown as Record<string, unknown>
    : {};
  const quoteId = typeof data.quoteId === 'string' ? data.quoteId : null;
  const estCheckoutTimeMs = toNumber(data.estCheckoutTimeMs);
  const estInputUsd = toNumber(data.estInputUsd);
  const estOutputUsd = toNumber(data.estOutputUsd);
  const estToTokenBaseUnit = typeof data.estToTokenBaseUnit === 'string'
    ? data.estToTokenBaseUnit
    : null;
  if (!quoteId || estCheckoutTimeMs === null || estInputUsd === null || estOutputUsd === null || !estToTokenBaseUnit) {
    throw new Error('Bridge returned an incomplete quote. Try again.');
  }
  return {
    quoteId,
    estCheckoutTimeMs,
    estInputUsd,
    estOutputUsd,
    estToTokenBaseUnit,
    estFeeBreakdown: {
      appFeePercent: bridgeFeeNumber(fees, 'appFeePercent'),
      appFeeUsd: bridgeFeeNumber(fees, 'appFeeUsd'),
      fillCostPercent: bridgeFeeNumber(fees, 'fillCostPercent'),
      fillCostUsd: bridgeFeeNumber(fees, 'fillCostUsd'),
      gasUsd: bridgeFeeNumber(fees, 'gasUsd'),
      maxSlippage: bridgeFeeNumber(fees, 'maxSlippage'),
      minReceived: bridgeFeeNumber(fees, 'minReceived'),
      swapImpact: bridgeFeeNumber(fees, 'swapImpact'),
      totalImpact: bridgeFeeNumber(fees, 'totalImpact'),
      totalImpactUsd: bridgeFeeNumber(fees, 'totalImpactUsd'),
    },
  };
}

export function decimalAmountToBaseUnits(amount: number, decimals: number): string {
  if (!Number.isFinite(amount) || amount < 0 || !Number.isInteger(decimals) || decimals < 0) {
    throw new Error('Invalid token amount.');
  }
  const fixed = amount.toFixed(decimals);
  const [whole, fraction = ''] = fixed.split('.');
  return `${whole}${fraction.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/u, '');
}

export async function fetchDepositStatus(depositAddress: string): Promise<DepositBridgeTransaction[]> {
  const baseUrl = resolveApiBaseUrl();
  const response = await fetchWithTimeout(`${baseUrl}/clob/deposit-status/${encodeURIComponent(depositAddress)}`);
  if (!response.ok) return [];
  const data = await response.json() as Record<string, unknown>;
  return Array.isArray(data.transactions)
    ? data.transactions.filter((entry): entry is DepositBridgeTransaction => !!entry && typeof entry === 'object')
    : [];
}

// --- Account data (authoritative SecureClient account.wallet) ---

export interface PortfolioPosition {
  proxyWallet: string;
  /** Token ID — used as tokenID for sell orders */
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  curPrice: number;
  title: string;
  slug: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  icon: string | null;
  endDate: string | null;
  /** Whether this market uses the neg-risk exchange contract */
  negativeRisk: boolean;
}

export interface ClosedPortfolioPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  avgPrice: number;
  totalBought: number;
  realizedPnl: number;
  curPrice: number;
  timestamp: number;
  title: string;
  slug: string;
  icon: string | null;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  oppositeOutcome: string;
  oppositeAsset: string;
  endDate: string | null;
}

export interface PortfolioData {
  address: string;
  portfolioValue: number | null;
  positions: PortfolioPosition[];
  redeemablePositions: PortfolioPosition[];
  closedPositions: ClosedPortfolioPosition[];
  activity: ActivityItem[];
  recentTrades: RecentAccountTrade[];
  profile: {
    name: string | null;
    bio: string | null;
    profileImage: string | null;
    xUsername: string | null;
  } | null;
  summary: {
    openPositions: number;
    totalPnl: number;
    cashOutNow?: number;
    readyToCollect?: number;
    activePickCount?: number;
    closedPickCount?: number;
    activityCount?: number;
    hasActivity?: boolean;
    hasAnyPicks?: boolean;
    totalCollected?: number;
    totalRealizedPnl?: number;
  };
}

export interface ActivityItem {
  timestamp: number;
  type: string;
  side: string;
  size: number;
  usdcSize: number;
  price: number;
  asset?: string;
  conditionId?: string;
  eventSlug?: string;
  outcomeIndex?: number;
  title: string;
  slug: string;
  outcome: string;
}

export interface RecentAccountTrade {
  id: string;
  conditionId: string;
  tokenId: string;
  takerOrderId: string;
  makerOrderIds: string[];
  side: string;
  price: number;
  size: number;
  status: string;
  matchedAt: number;
}

export async function fetchRecentAccountTrades(client: SecureClient): Promise<RecentAccountTrade[]> {
  const page = await client.listAccountTrades().firstPage();
  return page.items.map((trade) => ({
    id: trade.id,
    conditionId: trade.conditionId,
    tokenId: trade.tokenId,
    takerOrderId: trade.takerOrderId,
    makerOrderIds: trade.makerOrders.map((order) => order.orderId),
    side: trade.side,
    price: numberOrZero(trade.price),
    size: numberOrZero(trade.size),
    status: trade.status,
    matchedAt: Date.parse(trade.matchedAt),
  }));
}

async function collectSdkPages<T>(paginator: AsyncIterable<{ items: T[] }>): Promise<T[]> {
  const items: T[] = [];
  for await (const page of paginator) items.push(...page.items);
  return items;
}

function numberOrZero(value: unknown): number {
  return toNumber(value) ?? 0;
}

function mapSdkPosition(value: unknown): PortfolioPosition {
  const position = value as Record<string, unknown>;
  return {
    proxyWallet: typeof position.wallet === 'string' ? position.wallet : '',
    asset: typeof position.tokenId === 'string' ? position.tokenId : '',
    conditionId: typeof position.conditionId === 'string' ? position.conditionId : '',
    size: numberOrZero(position.size),
    avgPrice: numberOrZero(position.avgPrice),
    currentValue: numberOrZero(position.currentValue),
    cashPnl: numberOrZero(position.cashPnl),
    percentPnl: numberOrZero(position.percentPnl),
    curPrice: numberOrZero(position.curPrice),
    title: typeof position.title === 'string' ? position.title : '',
    slug: typeof position.slug === 'string' ? position.slug : '',
    eventSlug: typeof position.eventSlug === 'string' ? position.eventSlug : '',
    outcome: typeof position.outcome === 'string' ? position.outcome : '',
    outcomeIndex: numberOrZero(position.outcomeIndex),
    icon: typeof position.icon === 'string' ? position.icon : null,
    endDate: typeof position.endDate === 'string' ? position.endDate : null,
    negativeRisk: position.negativeRisk === true,
  };
}

function mapSdkClosedPosition(value: unknown): ClosedPortfolioPosition {
  const position = value as Record<string, unknown>;
  return {
    proxyWallet: typeof position.wallet === 'string' ? position.wallet : '',
    asset: typeof position.tokenId === 'string' ? position.tokenId : '',
    conditionId: typeof position.conditionId === 'string' ? position.conditionId : '',
    avgPrice: numberOrZero(position.avgPrice),
    totalBought: numberOrZero(position.totalBought),
    realizedPnl: numberOrZero(position.realizedPnl),
    curPrice: numberOrZero(position.curPrice),
    timestamp: numberOrZero(position.timestamp),
    title: typeof position.title === 'string' ? position.title : '',
    slug: typeof position.slug === 'string' ? position.slug : '',
    icon: typeof position.icon === 'string' ? position.icon : null,
    eventSlug: typeof position.eventSlug === 'string' ? position.eventSlug : '',
    outcome: typeof position.outcome === 'string' ? position.outcome : '',
    outcomeIndex: numberOrZero(position.outcomeIndex),
    oppositeOutcome: typeof position.oppositeOutcome === 'string' ? position.oppositeOutcome : '',
    oppositeAsset: typeof position.oppositeTokenId === 'string' ? position.oppositeTokenId : '',
    endDate: typeof position.endDate === 'string' ? position.endDate : null,
  };
}

function mapSdkActivity(value: unknown): ActivityItem {
  const activity = value as Record<string, unknown>;
  const isTrade = activity.type === 'TRADE' && activity.isCombo !== true;
  return {
    timestamp: numberOrZero(activity.timestamp),
    type: typeof activity.type === 'string' ? activity.type : 'UNKNOWN',
    side: isTrade && typeof activity.side === 'string' ? activity.side : '',
    size: isTrade ? numberOrZero(activity.shares) : 0,
    usdcSize: numberOrZero(activity.amount),
    price: isTrade ? numberOrZero(activity.price) : 0,
    asset: isTrade && typeof activity.tokenId === 'string' ? activity.tokenId : undefined,
    conditionId: typeof activity.conditionId === 'string' ? activity.conditionId : undefined,
    eventSlug: typeof activity.eventSlug === 'string' ? activity.eventSlug : undefined,
    outcomeIndex: isTrade ? numberOrZero(activity.outcomeIndex) : undefined,
    title: typeof activity.title === 'string' ? activity.title : 'Account activity',
    slug: typeof activity.slug === 'string' ? activity.slug : '',
    outcome: isTrade && typeof activity.outcome === 'string' ? activity.outcome : '',
  };
}

export async function fetchActivity(client: SecureClient): Promise<ActivityItem[]> {
  const activities = await collectSdkPages(client.listActivity());
  return activities.map(mapSdkActivity);
}

export async function fetchPortfolio(client: SecureClient): Promise<PortfolioData> {
  const [sdkPositions, sdkClosed, values, activities, profile, recentTrades] = await Promise.all([
    collectSdkPages(client.listPositions()),
    collectSdkPages(client.listClosedPositions()),
    client.fetchPortfolioValue(),
    collectSdkPages(client.listActivity()),
    client.fetchPublicProfile({ address: client.account.wallet }),
    fetchRecentAccountTrades(client),
  ]);
  const positions = sdkPositions.map(mapSdkPosition);
  const redeemablePositions = sdkPositions
    .filter((position) => (position as unknown as Record<string, unknown>).redeemable === true)
    .map(mapSdkPosition)
    .filter((position) => position.currentValue >= 0.01);
  const closedPositions = sdkClosed.map(mapSdkClosedPosition);
  const activity = activities.map(mapSdkActivity);
  const totalPnl = positions.reduce((sum, position) => sum + position.cashPnl, 0);
  const cashOutNow = positions.reduce((sum, position) => sum + position.currentValue, 0);
  const readyToCollect = redeemablePositions.reduce((sum, position) => sum + position.currentValue, 0);
  const totalRealizedPnl = closedPositions.reduce((sum, position) => sum + position.realizedPnl, 0);
  const totalCollected = activity
    .filter((entry) => entry.type === 'REDEEM')
    .reduce((sum, entry) => sum + entry.usdcSize, 0);

  return {
    address: client.account.wallet,
    portfolioValue: values.reduce((sum, value) => sum + numberOrZero(value.value), 0),
    positions,
    redeemablePositions,
    closedPositions,
    activity,
    recentTrades,
    profile: profile ? {
      name: profile.name ?? profile.pseudonym ?? null,
      bio: profile.bio ?? null,
      profileImage: profile.profileImage ?? null,
      xUsername: profile.xUsername ?? null,
    } : null,
    summary: {
      openPositions: positions.length,
      totalPnl,
      cashOutNow,
      readyToCollect,
      activePickCount: positions.length,
      closedPickCount: closedPositions.length,
      activityCount: activity.length,
      hasActivity: activity.length > 0,
      hasAnyPicks: positions.length + closedPositions.length > 0,
      totalCollected,
      totalRealizedPnl,
    },
  };
}

export async function fetchMarketPositions(client: SecureClient, slug: string): Promise<PortfolioPosition[]> {
  const positions = await collectSdkPages(client.listPositions());
  return positions.map(mapSdkPosition).filter((position) => (
    position.slug === slug || position.eventSlug === slug
  ));
}

// --- Withdraw ---

export interface WithdrawParams {
  amount: number;
  solanaAddress: string;
}

export interface PreparedWithdrawal {
  amount: number;
  solanaAddress: string;
  bridgeAddress: string;
  asset: BridgeSupportedAsset;
  quote: BridgeQuote;
}

export interface WithdrawalTransferStatus {
  state: string;
  transactionId: string;
  transactionHash: string | null;
  errorMessage: string | null;
}

function bridgeAddressFromPayload(data: Record<string, unknown>): string | null {
  const address = data.address;
  if (address && typeof address === 'object') {
    const evm = (address as Record<string, unknown>).evm;
    if (typeof evm === 'string') return evm;
  }
  if (typeof data.depositAddress === 'string') return data.depositAddress;
  if (typeof address === 'string') return address;
  return null;
}

async function fetchExpectedWithdrawBridgeAddress(
  client: SecureClient,
  params: WithdrawParams,
  destinationAsset: BridgeSupportedAsset,
): Promise<string> {
  const response = await fetchWithTimeout(`${resolveApiBaseUrl()}/clob/bridge/withdraw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address: client.account.wallet,
      toChainId: destinationAsset.chainId,
      toTokenAddress: destinationAsset.token.address,
      recipientAddr: params.solanaAddress,
    }),
  });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  const bridgeAddress = bridgeAddressFromPayload(data);
  if (!response.ok || !bridgeAddress || !/^0x[0-9a-fA-F]{40}$/u.test(bridgeAddress)) {
    throw new Error('Could not verify withdrawal route. Try again.');
  }
  return bridgeAddress;
}

export async function fetchWithdrawalQuote(
  amount: number,
  solanaAddress: string,
): Promise<{ asset: BridgeSupportedAsset; quote: BridgeQuote }> {
  const assets = selectSupportedDepositAssets(await fetchBridgeSupportedAssets());
  const asset = assets.find((entry) => entry.chainId === SOLANA_CHAIN_ID);
  if (!asset) throw new Error('Solana USDC withdrawals are unavailable right now.');
  if (!Number.isFinite(amount) || amount < asset.minCheckoutUsd) {
    throw new Error(`Minimum withdrawal is $${asset.minCheckoutUsd.toFixed(2)} USDC.`);
  }
  const quote = await fetchBridgeQuote({
    fromAmountBaseUnit: decimalAmountToBaseUnits(amount, 6),
    fromChainId: POLYGON_CHAIN_ID,
    fromTokenAddress: POLYMARKET_PUSD,
    recipientAddress: solanaAddress,
    toChainId: asset.chainId,
    toTokenAddress: asset.token.address,
  });
  // The documented <10bp offramp rule applies to the pUSD -> native USDC
  // swap, not total bridge cost (which also includes fixed fill/gas costs).
  const impact = quote.estFeeBreakdown.swapImpact;
  if (impact === null) throw new Error('Bridge quote did not include swap impact.');
  if (impact >= MAX_WITHDRAW_BRIDGE_IMPACT_PERCENT) {
    throw new Error(
      `Bridge swap impact is ${impact.toFixed(3)}%; it must stay below ${MAX_WITHDRAW_BRIDGE_IMPACT_PERCENT.toFixed(2)}%.`,
    );
  }
  return { asset, quote };
}

export async function preparePolymarketWithdrawal(
  client: SecureClient,
  params: WithdrawParams,
): Promise<PreparedWithdrawal> {
  if (!Number.isFinite(params.amount) || params.amount <= 0) {
    throw new Error('Enter a valid withdrawal amount.');
  }
  // Re-quote at submission time. The modal's quote is only for review.
  const { asset, quote } = await fetchWithdrawalQuote(params.amount, params.solanaAddress);
  const bridgeAddress = await fetchExpectedWithdrawBridgeAddress(client, params, asset);
  return { ...params, bridgeAddress, asset, quote };
}

/** Submit without waiting so the caller can durably save the handle first. */
export function submitPreparedWithdrawal(
  client: SecureClient,
  prepared: PreparedWithdrawal,
): Promise<TransactionHandle> {
  return client.transferErc20({
    tokenAddress: POLYMARKET_PUSD,
    recipientAddress: prepared.bridgeAddress,
    amount: BigInt(decimalAmountToBaseUnits(prepared.amount, 6)),
    metadata: `Withdraw pUSD to Solana ${prepared.solanaAddress}`,
  });
}

export async function fetchWithdrawalTransferStatus(
  client: SecureClient,
  transactionId: string,
): Promise<WithdrawalTransferStatus> {
  const transaction = await fetchTransaction(client, { transactionId });
  return {
    state: transaction.state,
    transactionId: transaction.transactionId,
    transactionHash: transaction.transactionHash,
    errorMessage: transaction.errorMsg,
  };
}

// --- Redeem ---

export interface RedeemResult extends PredictOperationMeta {
  ok: boolean;
  txHash?: string | null;
  error?: string;
}

export interface RedeemPositionInput {
  conditionId: string;
  marketId?: string;
  positionId?: string;
}

export async function redeemPosition(
  client: SecureClient,
  position: RedeemPositionInput,
): Promise<RedeemResult> {
  try {
    const handle = await client.redeemPositions(
      position.positionId
        ? { positionId: position.positionId }
        : position.marketId
          ? { marketId: position.marketId }
          : { conditionId: position.conditionId },
    );
    const outcome = await handle.wait();
    return {
      ok: true,
      txHash: outcome.transactionHash,
      status: 'completed',
      userMessage: 'Position redeemed.',
    };
  } catch (error) {
    const normalized = normalizePredictError(error, 'Redeem failed.');
    return { ok: false, status: 'failed', code: normalized.code, error: normalized.message };
  }
}

export async function fetchPriceHistory(tokenId: string, interval: '5m' | '1h' | '1d' = '1h'): Promise<PriceHistory> {
  const payload = await getJson(`/polymarket/history/${encodeURIComponent(tokenId)}?interval=${interval}`);
  if (!payload || typeof payload !== 'object') throw new Error('Invalid history response');
  const p = payload as Record<string, unknown>;
  const rawHistory = Array.isArray(p.history) ? p.history : [];
  const history: PricePoint[] = rawHistory
    .filter((pt): pt is Record<string, unknown> => !!pt && typeof pt === 'object')
    .map((pt) => ({ t: toNumber(pt.t) ?? 0, p: toNumber(pt.p) ?? 0 }))
    .filter((pt) => pt.t > 0);
  return { history };
}

export async function fetchOrderbook(tokenId: string): Promise<import('./predict.types').Orderbook> {
  const payload = await getJson(`/polymarket/book/${encodeURIComponent(tokenId)}`);
  if (!payload || typeof payload !== 'object') throw new Error('Invalid orderbook response');
  const p = payload as Record<string, unknown>;

  function parseLevels(raw: unknown): import('./predict.types').OrderbookLevel[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((lv): lv is Record<string, unknown> => !!lv && typeof lv === 'object')
      .map((lv) => ({
        price: toNumber(lv.price) ?? 0,
        size: toNumber(lv.size) ?? 0,
      }))
      .filter((lv) => lv.price > 0 && lv.size > 0);
  }

  const bids = parseLevels(p.bids);
  const asks = parseLevels(p.asks);

  const bestBid = bids.length > 0 ? Math.max(...bids.map((b) => b.price)) : null;
  const bestAsk = asks.length > 0 ? Math.min(...asks.map((a) => a.price)) : null;
  const spread = bestBid !== null && bestAsk !== null ? Math.abs(bestAsk - bestBid) : null;
  const lastPrice = toNumber(p.last_trade_price) ?? toNumber(p.last_price) ?? toNumber(p.lastPrice) ?? bestBid;

  return { bids, asks, lastPrice, spread };
}
