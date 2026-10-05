import type { MeteoraOhlcvCandle } from '@myboon/shared/meteora';

import { normalizeMarketCandles } from '@/features/charts/market-chart.normalization';
import type { MarketCandle } from '@/features/charts/market-chart.types';

/** Convert Meteora's string OHLCV values into the shared chart contract. */
export function adaptMeteoraCandles(
  candles: readonly MeteoraOhlcvCandle[],
  inverted = false,
) {
  const normalized = normalizeMarketCandles(candles.map((candle): MarketCandle => {
    const open = positivePrice(candle.open);
    const high = positivePrice(candle.high);
    const low = positivePrice(candle.low);
    const close = positivePrice(candle.close);
    return {
      timeMs: Math.abs(candle.timestamp) < 100_000_000_000
        ? candle.timestamp * 1000
        : candle.timestamp,
      open: inverted ? 1 / open : open,
      // Reciprocating the quote reverses the high and low prices.
      high: inverted ? 1 / low : high,
      low: inverted ? 1 / high : low,
      close: inverted ? 1 / close : close,
      volume: Number(candle.volume),
    };
  }));

  return {
    candles: normalized.candles,
    rejectedRows: normalized.issues.length,
    duplicateTimes: normalized.duplicateTimes,
  };
}

function positivePrice(value: string): number {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : Number.NaN;
}
