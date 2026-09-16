import type { MarketCandle } from '@/features/charts/market-chart.types';

export type MarketCandleValidationCode =
  | 'invalid-time'
  | 'invalid-ohlc'
  | 'invalid-range'
  | 'invalid-volume';

export interface MarketCandleValidationIssue {
  readonly index: number;
  readonly code: MarketCandleValidationCode;
}

export interface NormalizedMarketCandles {
  readonly candles: MarketCandle[];
  readonly issues: MarketCandleValidationIssue[];
  readonly duplicateTimes: number[];
}

export function normalizeMarketCandles(
  input: readonly MarketCandle[],
): NormalizedMarketCandles {
  const issues: MarketCandleValidationIssue[] = [];
  const byTime = new Map<number, MarketCandle>();
  const duplicateTimes = new Set<number>();

  input.forEach((candle, index) => {
    const issue = validateMarketCandle(candle);
    if (issue) {
      issues.push({ index, code: issue });
      return;
    }

    if (byTime.has(candle.timeMs)) duplicateTimes.add(candle.timeMs);
    byTime.set(candle.timeMs, {
      timeMs: candle.timeMs,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume ?? null,
    });
  });

  return {
    candles: Array.from(byTime.values()).sort((a, b) => a.timeMs - b.timeMs),
    issues,
    duplicateTimes: Array.from(duplicateTimes).sort((a, b) => a - b),
  };
}

export function validateMarketCandle(
  candle: MarketCandle,
): MarketCandleValidationCode | null {
  if (!Number.isFinite(candle.timeMs)) return 'invalid-time';
  if (
    !Number.isFinite(candle.open)
    || !Number.isFinite(candle.high)
    || !Number.isFinite(candle.low)
    || !Number.isFinite(candle.close)
  ) {
    return 'invalid-ohlc';
  }
  if (
    candle.high < candle.low
    || candle.high < Math.max(candle.open, candle.close)
    || candle.low > Math.min(candle.open, candle.close)
  ) {
    return 'invalid-range';
  }
  if (
    candle.volume !== null
    && candle.volume !== undefined
    && (!Number.isFinite(candle.volume) || candle.volume < 0)
  ) {
    return 'invalid-volume';
  }
  return null;
}
