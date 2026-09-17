import type { PhoenixCandle, PhoenixMarket } from '@/features/perps/phoenix.api';
import { PHOENIX_VENUE_DESCRIPTOR } from '@/features/perps/perps.registry';

export const PHOENIX_LIVE_WS_URL = PHOENIX_VENUE_DESCRIPTOR.publicWsBaseUrl;

export type PhoenixLiveConnectionStatus =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'stale'
  | 'paused';

export interface PhoenixLiveCandleUpdate {
  readonly kind: 'candle';
  readonly symbol: string;
  readonly timeframe: string;
  readonly candle: PhoenixCandle;
  readonly receivedAt: number;
}

export interface PhoenixLiveMarketStats {
  readonly kind: 'marketStats';
  readonly symbol: string;
  readonly timestampMs: number;
  readonly markPrice: number;
  readonly oraclePrice: number;
  readonly previousDayMarkPrice: number;
  readonly openInterestBase: number;
  readonly volume24hUsd: number;
  readonly volume24hBase: number;
  readonly fundingRate: number;
  readonly receivedAt: number;
}

export type PhoenixLiveMessage = PhoenixLiveCandleUpdate | PhoenixLiveMarketStats;

export interface PhoenixSubscriptionMessage {
  readonly type: 'subscribe' | 'unsubscribe';
  readonly subscription: {
    readonly channel: 'candles' | 'marketStats';
    readonly symbol: string;
    readonly timeframe?: string;
  };
}

export function normalizePhoenixLiveSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/-PERP$/, '');
}

export function buildPhoenixLiveSubscriptionMessages(
  type: PhoenixSubscriptionMessage['type'],
  symbol: string,
  timeframe: string,
): readonly PhoenixSubscriptionMessage[] {
  const venueSymbol = normalizePhoenixLiveSymbol(symbol);
  return [
    {
      type,
      subscription: {
        channel: 'candles',
        symbol: venueSymbol,
        timeframe,
      },
    },
    {
      type,
      subscription: {
        channel: 'marketStats',
        symbol: venueSymbol,
      },
    },
  ];
}

export function parsePhoenixLiveMessage(
  input: unknown,
  receivedAt = Date.now(),
): PhoenixLiveMessage | null {
  const record = asRecord(parseWireValue(input));
  if (!record) return null;

  if (record.channel === 'candle') {
    const candleRecord = asRecord(record.candle);
    const symbol = asString(record.symbol);
    const timeframe = asString(record.timeframe);
    if (!candleRecord || !symbol || !timeframe) return null;

    const time = asInteger(candleRecord.time);
    const open = asFiniteNumber(candleRecord.open);
    const high = asFiniteNumber(candleRecord.high);
    const low = asFiniteNumber(candleRecord.low);
    const close = asFiniteNumber(candleRecord.close);
    const volume = asFiniteNumber(candleRecord.volume);
    const tradeCount = asInteger(candleRecord.tradeCount);
    if (
      time === null
      || open === null
      || high === null
      || low === null
      || close === null
      || volume === null
      || volume < 0
      || tradeCount === null
      || tradeCount < 0
    ) {
      return null;
    }

    return {
      kind: 'candle',
      symbol: normalizePhoenixLiveSymbol(symbol),
      timeframe,
      receivedAt,
      candle: {
        time,
        open,
        high,
        low,
        close,
        volume,
        volumeQuote: asFiniteNumber(candleRecord.volumeQuote),
        tradeCount,
        externalSource: 'phoenix_ws',
      },
    };
  }

  if (record.channel === 'marketStats') {
    const symbol = asString(record.symbol);
    const timestamp = asInteger(record.timestamp);
    const markPrice = asFiniteNumber(record.markPrice);
    const oraclePrice = asFiniteNumber(record.oraclePrice);
    const previousDayMarkPrice = asFiniteNumber(record.prevDayMarkPrice);
    const openInterestBase = asFiniteNumber(record.openInterest);
    const volume24hUsd = asFiniteNumber(record.dayVolumeUsd);
    const volume24hBase = asFiniteNumber(record.dayVolumeBase);
    const fundingRate = asFiniteNumber(record.currentFundingRate);
    if (
      !symbol
      || timestamp === null
      || markPrice === null
      || oraclePrice === null
      || previousDayMarkPrice === null
      || openInterestBase === null
      || volume24hUsd === null
      || volume24hBase === null
      || fundingRate === null
    ) {
      return null;
    }

    return {
      kind: 'marketStats',
      symbol: normalizePhoenixLiveSymbol(symbol),
      timestampMs: normalizeEpochMs(timestamp),
      markPrice,
      oraclePrice,
      previousDayMarkPrice,
      openInterestBase,
      volume24hUsd,
      volume24hBase,
      fundingRate,
      receivedAt,
    };
  }

  return null;
}

export function applyPhoenixLiveMarketStats(
  market: PhoenixMarket,
  stats: PhoenixLiveMarketStats,
): PhoenixMarket {
  if (normalizePhoenixLiveSymbol(market.venueSymbol) !== stats.symbol) return market;

  const change24h = stats.previousDayMarkPrice > 0
    ? ((stats.markPrice - stats.previousDayMarkPrice) / stats.previousDayMarkPrice) * 100
    : market.change24h;
  const openInterest = stats.openInterestBase * stats.markPrice;

  return {
    ...market,
    markPrice: stats.markPrice,
    oraclePrice: stats.oraclePrice,
    fundingRate: stats.fundingRate,
    openInterest: Number.isFinite(openInterest) ? openInterest : market.openInterest,
    volume24h: stats.volume24hUsd,
    change24h,
    dataFreshness: 'live',
    dataFreshnessReason: 'Phoenix WebSocket market statistics.',
  };
}

export function phoenixReconnectDelayMs(
  attempt: number,
  random = Math.random(),
): number {
  const normalizedAttempt = Math.max(0, Math.floor(attempt));
  const baseDelay = Math.min(30_000, 1_000 * (2 ** normalizedAttempt));
  const clampedRandom = Math.max(0, Math.min(1, random));
  const jitter = 0.8 + clampedRandom * 0.4;
  return Math.round(baseDelay * jitter);
}

function parseWireValue(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return null;
  }
}

function normalizeEpochMs(value: number): number {
  return Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}
