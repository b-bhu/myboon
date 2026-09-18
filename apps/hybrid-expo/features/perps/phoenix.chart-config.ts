import type { PhoenixCandleInterval } from '@/features/perps/phoenix.api';
import { formatPrice } from '@/lib/format';

export interface PhoenixChartTimeframe {
  readonly label: '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
  readonly interval: PhoenixCandleInterval;
  readonly count: number;
}

export const PHOENIX_CHART_TIMEFRAMES: readonly PhoenixChartTimeframe[] = [
  { label: '1m', interval: '1m', count: 180 },
  { label: '5m', interval: '5m', count: 180 },
  { label: '15m', interval: '15m', count: 180 },
  { label: '1h', interval: '1h', count: 180 },
  { label: '4h', interval: '4h', count: 180 },
  { label: '1d', interval: '1d', count: 180 },
];

export const DEFAULT_PHOENIX_CHART_TIMEFRAME_INDEX = 3;

export function formatPhoenixAxisPrice(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (absolute >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (absolute >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return formatPrice(value);
}

export function formatPhoenixChartTime(
  timeMs: number,
  interval: PhoenixCandleInterval,
): string {
  const date = new Date(timeMs);
  if (!Number.isFinite(date.getTime())) return '';
  const time = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  if (
    interval === '1s'
    || interval === '5s'
    || interval === '1m'
    || interval === '5m'
    || interval === '15m'
    || interval === '30m'
  ) {
    return time;
  }
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (interval === '1d') return day;
  const hour = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    hour12: true,
  }).replace(' ', '');
  return `${day} ${hour}`;
}
