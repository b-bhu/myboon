import { normalizeMarketCandles } from '@/features/charts/market-chart.normalization';
import type { MarketCandle } from '@/features/charts/market-chart.types';
import type { PhoenixCandle } from '@/features/perps/phoenix.api';

export interface PhoenixChartAdapterResult {
  readonly candles: MarketCandle[];
  readonly rejectedRows: number;
  readonly duplicateTimes: readonly number[];
}

export function adaptPhoenixCandles(
  candles: readonly PhoenixCandle[],
): PhoenixChartAdapterResult {
  const normalized = normalizeMarketCandles(candles.map((candle) => ({
    timeMs: normalizePhoenixCandleEpoch(candle.time),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  })));

  return {
    candles: normalized.candles,
    rejectedRows: normalized.issues.length,
    duplicateTimes: normalized.duplicateTimes,
  };
}

export function normalizePhoenixCandleEpoch(value: number): number {
  return Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
}

export function mergePhoenixCandlePages(
  older: readonly PhoenixCandle[],
  current: readonly PhoenixCandle[],
): PhoenixCandle[] {
  const byTime = new Map<number, PhoenixCandle>();
  older.forEach((candle) => byTime.set(normalizePhoenixCandleEpoch(candle.time), candle));
  current.forEach((candle) => byTime.set(normalizePhoenixCandleEpoch(candle.time), candle));
  return Array.from(byTime.values()).sort((left, right) => (
    normalizePhoenixCandleEpoch(left.time) - normalizePhoenixCandleEpoch(right.time)
  ));
}

/**
 * Reconciles a fresh venue snapshot with locally cached candles.
 *
 * Snapshot rows deliberately win duplicate timestamps so a reconnect can
 * repair OHLCV values that became stale while the socket was unavailable.
 */
export function reconcilePhoenixCandleSnapshot(
  current: readonly PhoenixCandle[],
  snapshot: readonly PhoenixCandle[],
): PhoenixCandle[] {
  return mergePhoenixCandlePages(current, snapshot);
}

export function upsertPhoenixLiveCandle(
  current: readonly PhoenixCandle[],
  liveCandle: PhoenixCandle,
): PhoenixCandle[] {
  if (current.length === 0) return [liveCandle];

  const liveTime = normalizePhoenixCandleEpoch(liveCandle.time);
  const existingIndex = current.findIndex(
    (candle) => normalizePhoenixCandleEpoch(candle.time) === liveTime,
  );
  if (existingIndex >= 0) {
    const next = [...current];
    next[existingIndex] = liveCandle;
    return next;
  }

  const latestTime = normalizePhoenixCandleEpoch(current[current.length - 1].time);
  if (liveTime > latestTime) return [...current, liveCandle];

  return mergePhoenixCandlePages([liveCandle], current);
}
