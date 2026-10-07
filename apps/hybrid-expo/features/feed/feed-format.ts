import { formatPrice, formatUsdCompact } from '@/lib/format';

export function formatFeedUsd(value: number | null, compact = false): string {
  if (value === null || !Number.isFinite(value)) return 'Unavailable';
  // Hermes' Intl implementation does not consistently support compact notation.
  if (compact && value > 0) return formatUsdCompact(value);
  if (value > 0 && value < 0.001) return formatPrice(value);
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: value < 1 ? 6 : 2 });
}
