import type {
  Candle,
  PerpsAccount,
  PerpsMarket,
  PerpsOrder,
  PerpsPosition,
  RawAccountInfo,
  RawCandle,
  RawOrder,
  RawPosition,
  RawPriceInfo,
} from '@/features/perps/perps.types';
import { fetchWithTimeout, resolveApiBaseUrl } from '@/lib/api';
import { PACIFIC_REST } from '@/features/perps/pacific.config';

export function safeNum(val: unknown): number {
  const n = parseFloat(String(val));
  return Number.isFinite(n) ? n : 0;
}

export async function pacificGet<T>(path: string): Promise<T> {
  const url = `${PACIFIC_REST}${path}`;
  const res = await fetchWithTimeout(url);
  if (res.status === 429) throw new Error('Rate limit — try again shortly');
  const json = (await res.json()) as { success?: boolean; data?: T; error?: string };
  if (!res.ok || json.success === false) {
    throw new Error(json.error ?? `HTTP ${res.status}`);
  }
  return json.data as T;
}

export async function fetchPerpsMarkets(): Promise<PerpsMarket[]> {
  const baseUrl = resolveApiBaseUrl();
  const res = await fetchWithTimeout(`${baseUrl}/perps/pacifica/markets`);
  if (!res.ok) throw new Error(`Markets unavailable (${res.status})`);

  const payload = await res.json();
  if (!Array.isArray(payload)) throw new Error('Invalid markets response');
  return payload as PerpsMarket[];
}

export async function fetchPerpsPositions(address: string): Promise<PerpsPosition[]> {
  const [rawPositions, prices] = await Promise.all([
    pacificGet<RawPosition[]>(`/positions?account=${encodeURIComponent(address)}`),
    pacificGet<RawPriceInfo[]>('/info/prices'),
  ]);

  const priceMap = new Map(prices.map((p) => [p.symbol, safeNum(p.mark)]));

  return rawPositions.map((pos): PerpsPosition => {
    const entry = safeNum(pos.entry_price);
    const size = safeNum(pos.amount);
    const mark = priceMap.get(pos.symbol) ?? entry;
    const side = pos.side === 'bid' ? 'long' : ('short' as const);
    const direction = side === 'long' ? 1 : -1;
    const pnl = (mark - entry) * size * direction;
    const pnlPct = entry > 0 && size > 0 ? (pnl / (entry * size)) * 100 : 0;

    return { symbol: pos.symbol, side, size, entryPrice: entry, markPrice: mark, unrealizedPnl: pnl, unrealizedPnlPct: pnlPct };
  });
}

export async function fetchPerpsAccount(address: string): Promise<PerpsAccount> {
  const acc = await pacificGet<RawAccountInfo>(`/account?account=${encodeURIComponent(address)}`);
  return {
    equity: safeNum(acc.account_equity),
    availableToSpend: safeNum(acc.available_to_spend),
    availableToWithdraw: safeNum(acc.available_to_withdraw),
    totalMarginUsed: safeNum(acc.total_margin_used),
    positionsCount: acc.positions_count,
  };
}

export async function fetchOpenOrders(address: string): Promise<PerpsOrder[]> {
  const raw = await pacificGet<RawOrder[]>(`/orders?account=${encodeURIComponent(address)}`);
  return raw.map((o): PerpsOrder => ({
    orderId: o.order_id,
    symbol: o.symbol,
    side: o.side,
    price: safeNum(o.price),
    stopPrice: o.stop_price ? safeNum(o.stop_price) : null,
    orderType: o.order_type,
    reduceOnly: o.reduce_only,
    createdAt: o.created_at,
  }));
}

export type CandleInterval = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '8h' | '12h' | '1d';

const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
  '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000,
  '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000,
};

export async function fetchCandles(
  symbol: string,
  interval: CandleInterval,
  count: number = 100,
): Promise<Candle[]> {
  const endTime = Date.now();
  const startTime = endTime - INTERVAL_MS[interval] * count;
  const params = new URLSearchParams({
    symbol,
    interval,
    start_time: String(startTime),
    end_time: String(endTime),
  });
  const raw = await pacificGet<RawCandle[]>(`/kline?${params}`);
  return raw.map((c) => ({
    time: c.t,
    open: safeNum(c.o),
    close: safeNum(c.c),
    high: safeNum(c.h),
    low: safeNum(c.l),
    volume: safeNum(c.v),
  }));
}

// Re-export aliases onto lib/format's consolidated formatters. Keeps every
// existing detail/profile/chart screen importing from this module compiling
// with zero edits, per the token-identity-and-venue-adapters PRD (formatter
// consolidation, acceptance criterion 6).
export { formatPrice, formatPercent as formatChange, formatUsdCompact, formatRate as formatFunding } from '@/lib/format';
