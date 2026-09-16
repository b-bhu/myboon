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
