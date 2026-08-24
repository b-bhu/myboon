import type {
  EventContext,
  EventOutcomeMarket,
  FeedItem,
  FeedItemBinary,
  FeedItemMatch,
  FeedItemStatus,
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
import { resolveApiBaseUrl, fetchWithTimeout } from '@/lib/api';
import type { Signer } from '@/features/chain/chain.contract';
import {
  createSignedPredictOrder,
  signDepositWalletBatch,
  type DepositWalletSignatureRequest,
} from './predict.signing';

// --- CLOB session expiry signal ---
// The server keeps CLOB sessions in-memory (packages/api/src/clob.ts), so a
// restart/redeploy silently invalidates every active session. Callers below
// detect the resulting 401 and emit here so usePolymarketWallet can surface
// a "reconnect" prompt instead of the UI quietly polling a dead session.
type ClobSessionExpiredListener = () => void;
const clobSessionExpiredListeners = new Set<ClobSessionExpiredListener>();

export function onClobSessionExpired(listener: ClobSessionExpiredListener): () => void {
  clobSessionExpiredListeners.add(listener);
  return () => clobSessionExpiredListeners.delete(listener);
}

function notifyClobSessionExpired(): void {
  clobSessionExpiredListeners.forEach((listener) => listener());
}

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
  | 'failed'
  | 'session_expired';

export interface PredictOperationMeta {
  operationId?: string;
  status?: PredictOperationStatus;
  userMessage?: string;
  code?: string;
  isSessionExpired?: boolean;
}

function parseOperationMeta(data: Record<string, unknown>): PredictOperationMeta {
  const status = typeof data.status === 'string' ? data.status : undefined;
  const lifecycleError = data.lifecycleError && typeof data.lifecycleError === 'object'
    ? data.lifecycleError as Record<string, unknown>
    : null;
  const code = typeof lifecycleError?.code === 'string'
    ? lifecycleError.code
    : typeof data.code === 'string'
      ? data.code
      : undefined;
  return {
    operationId: typeof data.operationId === 'string' ? data.operationId : undefined,
    status: status === 'submitted'
      || status === 'waiting_to_match'
      || status === 'filled'
      || status === 'not_filled'
      || status === 'cancel_requested'
      || status === 'cancelled'
      || status === 'collecting'
      || status === 'bridging'
      || status === 'completed'
      || status === 'needs_signature'
      || status === 'failed'
      || status === 'session_expired'
      ? status
      : undefined,
    userMessage: typeof data.userMessage === 'string' ? data.userMessage : undefined,
    code,
    isSessionExpired: status === 'session_expired' || code === 'PREDICT_SESSION_EXPIRED',
  };
}

function getSignatureRequest(data: Record<string, unknown>): DepositWalletSignatureRequest | null {
  const request = data.signatureRequest;
  if (!request || typeof request !== 'object') return null;
  const r = request as Record<string, unknown>;
  if (
    r.kind !== 'deposit_wallet_batch'
    || typeof r.ownerAddress !== 'string'
    || typeof r.depositWalletAddress !== 'string'
    || typeof r.chainId !== 'number'
    || typeof r.nonce !== 'string'
    || typeof r.deadline !== 'string'
    || !Array.isArray(r.calls)
  ) {
    return null;
  }
  return r as unknown as DepositWalletSignatureRequest;
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

async function getJson(path: string): Promise<unknown> {
  const baseUrl = resolveApiBaseUrl();
  const response = await fetchWithTimeout(`${baseUrl}${path}`);
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
  polygonAddress: string;
  tradingAddress?: string | null;
  tokenID: string;
  price: number;
  size?: number;
  amount?: number;
  side: 'BUY' | 'SELL';
  negRisk?: boolean;
  orderType?: 'GTC' | 'FOK' | 'FAK';
}

export interface PlaceBetResult extends PredictOperationMeta {
  orderID?: string;
  success: boolean;
  error?: string;
}

function formatOrderMinimum(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$5';
  return `$${value.toFixed(2).replace(/\.00$/u, '').replace(/(\.\d)0$/u, '$1')}`;
}

function friendlyPlaceBetError(detail: string): string {
  if (/FOK_ORDER_NOT_FILLED|not filled|fill[- ]?or[- ]?kill|couldn'?t be fully filled/iu.test(detail)) {
    return 'Not filled. Price or liquidity changed. Try a smaller amount or refresh the market.';
  }

  if (/not enough liquidity|insufficient liquidity/iu.test(detail)) {
    return 'Not enough liquidity at the current price. Try a smaller amount.';
  }

  if (/min option validation/iu.test(detail)) {
    return 'Select at least one option to continue.';
  }

  const minimumMatch =
    detail.match(/lower than the minimum:\s*([0-9]+(?:\.[0-9]+)?)/iu)
    ?? detail.match(/minimum(?: order)? size[^0-9]*([0-9]+(?:\.[0-9]+)?)/iu);
  if (minimumMatch) {
    const minimum = Number.parseFloat(minimumMatch[1]);
    return `Minimum order size is ${formatOrderMinimum(minimum)}. Increase your amount to continue.`;
  }

  return detail;
}

/**
 * Place bet through the server-side deposit-wallet order path.
 */
export async function placeBet(signer: Signer, params: PlaceBetParams): Promise<PlaceBetResult> {
  const baseUrl = resolveApiBaseUrl();
  const signedOrder = await createSignedPredictOrder(signer, params);

  const response = await fetchWithTimeout(`${baseUrl}/clob/order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...params, signedOrder }),
  });

  const data = await response.json() as Record<string, unknown>;
  const operationMeta = parseOperationMeta(data);

  if (!response.ok) {
    const detail = typeof data.userMessage === 'string'
      ? data.userMessage
      : typeof data.detail === 'string'
        ? data.detail
        : typeof data.error === 'string'
          ? data.error
          : 'Order failed';
    return { success: false, error: friendlyPlaceBetError(detail), ...operationMeta };
  }

  return {
    success: true,
    orderID: typeof data.orderID === 'string'
      ? data.orderID
      : typeof data.orderId === 'string'
        ? data.orderId
        : typeof data.id === 'string'
          ? data.id
          : undefined,
    ...operationMeta,
  };
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
}

export async function fetchOpenOrders(polygonAddress: string): Promise<OpenOrder[]> {
  const baseUrl = resolveApiBaseUrl();
  const response = await fetchWithTimeout(`${baseUrl}/clob/positions/${encodeURIComponent(polygonAddress)}`);
  if (!response.ok) {
    // 401 = no active CLOB session (server restart / TTL expired) — not a crash
    if (response.status === 401) notifyClobSessionExpired();
    return [];
  }
  const data = await response.json() as Record<string, unknown>;
  return Array.isArray(data.orders) ? data.orders as OpenOrder[] : [];
}

export async function cancelOrder(
  polygonAddress: string,
  orderId: string,
): Promise<{ ok: boolean; error?: string } & PredictOperationMeta> {
  const baseUrl = resolveApiBaseUrl();
  const response = await fetchWithTimeout(
    `${baseUrl}/clob/order/${encodeURIComponent(orderId)}?address=${encodeURIComponent(polygonAddress)}`,
    { method: 'DELETE' },
  );
  const data = await response.json() as Record<string, unknown>;
  const operationMeta = parseOperationMeta(data);
  if (!response.ok) {
    return {
      ok: false,
      error: typeof data.userMessage === 'string'
        ? data.userMessage
        : typeof data.detail === 'string'
          ? data.detail
          : 'Cancel failed',
      ...operationMeta,
    };
  }
  return { ok: true, ...operationMeta };
}

// --- CLOB Balance ---

export interface ClobBalance {
  balance: number;
  allowance: number;
  wrap?: {
    attempted: boolean;
    wrapped: boolean;
    amount: number;
    txHash: string | null;
    error: string | null;
    signatureRequired?: boolean;
  };
}

/**
 * Auto-wrap needs a signature, so it only runs when the caller supplied a
 * signer. Balance reads themselves are unauthenticated and work without one.
 */
export async function fetchClobBalance(
  polygonAddress: string,
  wrapSigner: Signer | null = null,
): Promise<ClobBalance | null> {
  const baseUrl = resolveApiBaseUrl();
  const response = await fetchWithTimeout(`${baseUrl}/clob/balance/${encodeURIComponent(polygonAddress)}`);
  if (!response.ok) {
    // 401 = no active CLOB session (server restart / TTL expired) — not a crash
    if (response.status === 401) notifyClobSessionExpired();
    return null;
  }
  const data = await response.json() as Record<string, unknown>;
  const wrap = data.wrap && typeof data.wrap === 'object'
    ? data.wrap as ClobBalance['wrap']
    : undefined;
  if (wrapSigner && wrap?.signatureRequired) {
    await wrapPolymarketCash(wrapSigner, polygonAddress).catch(() => null);
    return fetchClobBalance(polygonAddress, null);
  }
  return {
    balance: typeof data.balance === 'number' ? data.balance : 0,
    allowance: typeof data.allowance === 'number' ? data.allowance : 0,
    wrap,
  };
}

export async function wrapPolymarketCash(
  signer: Signer,
  polygonAddress: string,
): Promise<PredictOperationMeta & { ok: boolean; error?: string }> {
  const baseUrl = resolveApiBaseUrl();
  const response = await fetchWithTimeout(`${baseUrl}/clob/wrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ polygonAddress }),
  });
  const data = await response.json() as Record<string, unknown>;
  const signatureRequest = getSignatureRequest(data);
  if (signatureRequest) {
    const batch = await signDepositWalletBatch(signer, signatureRequest, { operation: 'wrap' });
    const signedResponse = await fetchWithTimeout(`${baseUrl}/clob/wrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ polygonAddress, batch }),
    });
    const signedData = await signedResponse.json() as Record<string, unknown>;
    if (!signedResponse.ok) {
      return { ok: false, error: typeof signedData.userMessage === 'string' ? signedData.userMessage : 'Wrap failed', ...parseOperationMeta(signedData) };
    }
    return { ok: true, ...parseOperationMeta(signedData) };
  }
  if (!response.ok) {
    return { ok: false, error: typeof data.userMessage === 'string' ? data.userMessage : 'Wrap failed', ...parseOperationMeta(data) };
  }
  return { ok: true, ...parseOperationMeta(data) };
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

export async function fetchDepositStatus(depositAddress: string): Promise<DepositBridgeTransaction[]> {
  const baseUrl = resolveApiBaseUrl();
  const response = await fetchWithTimeout(`${baseUrl}/clob/deposit-status/${encodeURIComponent(depositAddress)}`);
  if (!response.ok) return [];
  const data = await response.json() as Record<string, unknown>;
  return Array.isArray(data.transactions)
    ? data.transactions.filter((entry): entry is DepositBridgeTransaction => !!entry && typeof entry === 'object')
    : [];
}

// --- Portfolio & Positions (Gamma data-api, proxied through VPS) ---

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

export async function fetchPortfolio(polygonAddress: string): Promise<PortfolioData> {
  const payload = await getJson(`/polymarket/portfolio/${encodeURIComponent(polygonAddress)}`);
  if (!payload || typeof payload !== 'object') throw new Error('Invalid portfolio response');
  const p = payload as Record<string, unknown>;
  return {
    address: typeof p.address === 'string' ? p.address : polygonAddress,
    portfolioValue: toNumber(p.portfolioValue),
    positions: Array.isArray(p.positions) ? (p.positions as PortfolioPosition[]) : [],
    redeemablePositions: Array.isArray(p.redeemablePositions)
      ? (p.redeemablePositions as PortfolioPosition[]).filter((position) => (position.currentValue ?? 0) >= 0.01)
      : [],
    closedPositions: Array.isArray(p.closedPositions) ? (p.closedPositions as ClosedPortfolioPosition[]) : [],
    activity: Array.isArray(p.activity) ? (p.activity as ActivityItem[]) : [],
    profile: p.profile as PortfolioData['profile'] ?? null,
    summary: (p.summary as PortfolioData['summary']) ?? { openPositions: 0, totalPnl: 0, totalCollected: 0 },
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

export async function fetchActivity(polygonAddress: string): Promise<ActivityItem[]> {
  const payload = await getJson(`/polymarket/activity/${encodeURIComponent(polygonAddress)}`);
  if (!Array.isArray(payload)) return [];
  return payload as ActivityItem[];
}

export async function fetchMarketPositions(polygonAddress: string, slug: string): Promise<PortfolioPosition[]> {
  const payload = await getJson(`/polymarket/positions/${encodeURIComponent(polygonAddress)}/market/${encodeURIComponent(slug)}`);
  if (!Array.isArray(payload)) return [];
  return payload as PortfolioPosition[];
}

// --- Withdraw ---

export interface WithdrawParams {
  polygonAddress: string;
  tradingAddress: string;
  amount: number;
  solanaAddress: string;
}

export interface WithdrawResult extends PredictOperationMeta {
  ok: boolean;
  amount?: number;
  txHash?: string | null;
  error?: string;
}

const SOLANA_CHAIN_ID = '1151111081099710';
const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

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

async function fetchExpectedWithdrawBridgeAddress(params: WithdrawParams): Promise<string> {
  const response = await fetchWithTimeout('https://bridge.polymarket.com/withdraw', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address: params.tradingAddress,
      toChainId: SOLANA_CHAIN_ID,
      toTokenAddress: SOLANA_USDC_MINT,
      recipientAddr: params.solanaAddress,
    }),
  });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  const bridgeAddress = bridgeAddressFromPayload(data);
  if (!response.ok || !bridgeAddress) {
    throw new Error('Could not verify withdrawal route. Try again.');
  }
  return bridgeAddress;
}

export async function withdrawFromPolymarket(
  signer: Signer,
  params: WithdrawParams,
): Promise<WithdrawResult> {
  const baseUrl = resolveApiBaseUrl();
  const response = await fetchWithTimeout(`${baseUrl}/clob/withdraw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  const data = await response.json() as Record<string, unknown>;
  const operationMeta = parseOperationMeta(data);
  const signatureRequest = getSignatureRequest(data);
  if (signatureRequest) {
    const bridgeAddress = await fetchExpectedWithdrawBridgeAddress(params);
    const batch = await signDepositWalletBatch(signer, signatureRequest, {
      operation: 'withdraw',
      amount: params.amount,
      bridgeAddress,
    });
    const signedResponse = await fetchWithTimeout(`${baseUrl}/clob/withdraw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, batch }),
    });
    const signedData = await signedResponse.json() as Record<string, unknown>;
    const signedMeta = parseOperationMeta(signedData);
    if (!signedResponse.ok) {
      return {
        ok: false,
        error: typeof signedData.userMessage === 'string'
          ? signedData.userMessage
          : typeof signedData.detail === 'string'
            ? signedData.detail
            : 'Withdraw failed',
        ...signedMeta,
      };
    }
    return {
      ok: true,
      amount: typeof signedData.amount === 'number' ? signedData.amount : undefined,
      txHash: typeof signedData.txHash === 'string' ? signedData.txHash : null,
      ...signedMeta,
    };
  }

  if (!response.ok) {
    const detail = typeof data.userMessage === 'string'
      ? data.userMessage
      : typeof data.detail === 'string'
        ? data.detail
        : typeof data.error === 'string'
          ? data.error
          : 'Withdraw failed';
    return { ok: false, error: detail, ...operationMeta };
  }

  return {
    ok: true,
    amount: typeof data.amount === 'number' ? data.amount : undefined,
    txHash: typeof data.txHash === 'string' ? data.txHash : null,
    ...operationMeta,
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
  asset?: string;
  outcomeIndex?: number;
  negativeRisk?: boolean;
}

export async function redeemPosition(
  signer: Signer,
  polygonAddress: string,
  position: RedeemPositionInput,
): Promise<RedeemResult> {
  const baseUrl = resolveApiBaseUrl();
  const response = await fetchWithTimeout(`${baseUrl}/clob/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      polygonAddress,
      conditionId: position.conditionId,
      asset: position.asset,
      outcomeIndex: position.outcomeIndex,
      negativeRisk: position.negativeRisk,
    }),
  });

  const text = await response.text();
  let data: Record<string, unknown> = {};
  if (text) {
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = { error: text };
    }
  }

  const signatureRequest = getSignatureRequest(data);
  if (signatureRequest) {
    const batch = await signDepositWalletBatch(signer, signatureRequest, {
      operation: 'redeem',
      conditionId: position.conditionId,
      negativeRisk: position.negativeRisk,
    });
    const signedResponse = await fetchWithTimeout(`${baseUrl}/clob/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        polygonAddress,
        conditionId: position.conditionId,
        asset: position.asset,
        outcomeIndex: position.outcomeIndex,
        negativeRisk: position.negativeRisk,
        batch,
      }),
    });
    const signedText = await signedResponse.text();
    let signedData: Record<string, unknown> = {};
    if (signedText) {
      try {
        signedData = JSON.parse(signedText) as Record<string, unknown>;
      } catch {
        signedData = { error: signedText };
      }
    }
    if (!signedResponse.ok) {
      const detail =
        typeof signedData.userMessage === 'string'
          ? signedData.userMessage
          : typeof signedData.detail === 'string'
          ? signedData.detail
          : typeof signedData.error === 'string'
            ? signedData.error
            : `Redeem failed (${signedResponse.status})`;
      return { ok: false, error: detail, ...parseOperationMeta(signedData) };
    }
    return {
      ok: true,
      txHash: typeof signedData.txHash === 'string' ? signedData.txHash : null,
      ...parseOperationMeta(signedData),
    };
  }

  if (!response.ok) {
    const detail =
      typeof data.userMessage === 'string'
        ? data.userMessage
        : typeof data.detail === 'string'
        ? data.detail
        : typeof data.error === 'string'
          ? data.error
          : `Redeem failed (${response.status})`;
    return { ok: false, error: detail, ...parseOperationMeta(data) };
  }

  return {
    ok: true,
    txHash: typeof data.txHash === 'string' ? data.txHash : null,
    ...parseOperationMeta(data),
  };
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
