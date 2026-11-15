/**
 * RSI for the shared market screen's indicator pane (#656).
 *
 * Pure node-safe module (no react-native imports) — the pane component and the
 * chart tests both consume it. Wilder's RSI with period 14, computed from the
 * candles already fetched by the venue price-chart components. No new network
 * request: this is a client-side calculation only.
 *
 * Period decision (recorded): RSI_PERIOD = 14 → the first value needs
 * RSI_PERIOD price changes, i.e. RSI_MIN_CANDLES = 15 closes. Fewer closes
 * must surface as the explicit insufficient-history state, never a partial
 * line. Changing the period changes that threshold with it.
 */

import type { MarketCandle, MarketChartStatus } from './market-chart.types';

export const RSI_PERIOD = 14;
/** Wilder's RSI needs `period` price changes, i.e. `period + 1` closes. */
export const RSI_MIN_CANDLES = RSI_PERIOD + 1;

/** One RSI reading aligned to a candle time, for the pane's plot. */
export interface RsiPoint {
  readonly timeMs: number;
  readonly value: number;
}

/**
 * What the pane renders. `error` covers a failed candle request and a venue
 * that returned nothing usable — the pane hides entirely in that state and the
 * retry stays on the chart above it.
 */
export type RsiPaneData =
  | { readonly kind: 'ready'; readonly value: number; readonly points: readonly RsiPoint[] }
  | {
      readonly kind: 'insufficient-history';
      readonly have: number;
      readonly need: number;
    }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' };

/**
 * RSI value for closes[i] for every i >= period, null before the first full
 * window. Wilder smoothing: the seed averages are the simple mean of the first
 * `period` changes; later averages decay with (previous * (period - 1) + current)
 * / period. Defined corners: only gains in the window → 100, only losses → 0,
 * no price change at all → 50 (neutral, documented). Any non-finite close
 * empties the result rather than corrupting the walk.
 */
export function computeRsiValues(
  closes: readonly number[],
  period: number = RSI_PERIOD,
): readonly (number | null)[] {
  const values: (number | null)[] = new Array(closes.length).fill(null);
  if (period < 1 || closes.length < period + 1) return values;
  if (closes.some((close) => !Number.isFinite(close))) return values;

  const gainAt = (delta: number) => (delta > 0 ? delta : 0);
  const lossAt = (delta: number) => (delta < 0 ? -delta : 0);
  const rsiFromAverages = (avgGain: number, avgLoss: number) => {
    if (avgGain === 0 && avgLoss === 0) return 50;
    if (avgLoss === 0) return 100;
    if (avgGain === 0) return 0;
    return 100 - 100 / (1 + avgGain / avgLoss);
  };

  let avgGain = 0;
  let avgLoss = 0;
  for (let index = 1; index <= period; index += 1) {
    const delta = closes[index] - closes[index - 1];
    avgGain += gainAt(delta);
    avgLoss += lossAt(delta);
  }
  avgGain /= period;
  avgLoss /= period;
  values[period] = rsiFromAverages(avgGain, avgLoss);

  for (let index = period + 1; index < closes.length; index += 1) {
    const delta = closes[index] - closes[index - 1];
    avgGain = (avgGain * (period - 1) + gainAt(delta)) / period;
    avgLoss = (avgLoss * (period - 1) + lossAt(delta)) / period;
    values[index] = rsiFromAverages(avgGain, avgLoss);
  }

  return values;
}

/**
 * Pane inputs from the candles a price-chart component already holds. Sorts by
 * candle time ascending, so RSI is computed on time order regardless of the
 * caller's array order. `statusKind` is the shared chart status: loading maps
 * through so the pane never shows a stale or zero value while candles load,
 * and error/empty map to the pane's hidden state.
 */
export function buildRsiPaneData(
  candles: readonly MarketCandle[],
  statusKind: MarketChartStatus['kind'],
): RsiPaneData {
  if (statusKind === 'loading') return { kind: 'loading' };
  if (statusKind === 'error' || statusKind === 'empty') return { kind: 'error' };

  const sorted = [...candles].sort((a, b) => a.timeMs - b.timeMs);
  const closes = sorted.map((candle) => candle.close);
  if (closes.some((close) => !Number.isFinite(close))) return { kind: 'error' };

  const values = computeRsiValues(closes);
  const latest = values.length > 0 ? values[values.length - 1] : null;
  if (latest === null || !Number.isFinite(latest)) {
    return { kind: 'insufficient-history', have: closes.length, need: RSI_MIN_CANDLES };
  }

  const points: RsiPoint[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const value = values[index];
    if (value !== null) points.push({ timeMs: sorted[index].timeMs, value });
  }
  return { kind: 'ready', value: latest, points };
}
