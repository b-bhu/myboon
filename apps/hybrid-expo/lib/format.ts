/**
 * Shared, nullable-safe formatting utilities used across the whole app —
 * Feed, Predict, Trade, and every venue market list.
 *
 * Consolidates what used to be four drifted copies: `formatPrice` /
 * `formatPhoenixPrice`, `formatChange` / `formatPhoenixPercent`,
 * `formatFunding` / `formatPhoenixRate` (all in features/perps), and
 * Meteora's private `formatUsdCompact` / `formatFee` / `formatUsdAccessible`
 * / `formatCount` (MeteoraPoolsScreen.tsx). Same branches, same thresholds
 * as the originals — this file exists to stop them drifting further, not to
 * change behavior.
 *
 * One no-data glyph everywhere: NO_DATA = '—' (em dash). The old `--`
 * (double hyphen) glyph is retired.
 *
 * PURE — zero imports, so this is fully unit-testable with `tsx --test`
 * (see lib/format.test.ts) without dragging in react-native.
 */

export const NO_DATA = '—';

function toFiniteNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Price formatter. Merges formatPrice (perps.public-api.ts:120) and
 * formatPhoenixPrice (phoenix.api.ts:628) — identical branches, differing
 * only in null-safety, which this version always has.
 *
 * >=1000: locale, no decimals. >=1: 3dp. >=0.001: 6dp. else: exponential.
 * <=0 or non-finite or null/undefined: NO_DATA.
 */
export function formatPrice(price: number | string | null | undefined): string {
  const value = toFiniteNumber(price);
  if (value === null || value <= 0) return NO_DATA;
  if (value >= 1000) return `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (value >= 1) return `$${value.toFixed(3)}`;
  if (value >= 0.001) return `$${value.toFixed(6)}`;
  return `$${value.toExponential(3)}`;
}

/**
 * Signed percent formatter. Merges formatChange (perps.public-api.ts:128)
 * and formatPhoenixPercent (phoenix.api.ts:636) — keeps the `decimals`
 * param from the Phoenix version (default 2).
 *
 * null/undefined/non-finite: NO_DATA.
 */
export function formatPercent(value: number | string | null | undefined, decimals = 2): string {
  const numeric = toFiniteNumber(value);
  if (numeric === null) return NO_DATA;
  const sign = numeric >= 0 ? '+' : '';
  return `${sign}${numeric.toFixed(decimals)}%`;
}

/**
 * Signed rate formatter (funding rates etc). Merges formatFunding
 * (perps.public-api.ts:135) and formatPhoenixRate (phoenix.api.ts:642) —
 * both multiply by 100 and use 4dp.
 *
 * null/undefined/non-finite: NO_DATA.
 */
export function formatRate(value: number | string | null | undefined): string {
  const numeric = toFiniteNumber(value);
  if (numeric === null) return NO_DATA;
  const sign = numeric >= 0 ? '+' : '';
  return `${sign}${(numeric * 100).toFixed(4)}%`;
}

/**
 * Compact USD formatter. Adopts Meteora's richer branch set
 * (MeteoraPoolsScreen.tsx:675) — abs-value thresholds (so negative amounts
 * compact correctly too) and 2 decimals for amounts under $100, keeping the
 * legacy `formatUsdCompact` (lib/format.ts, pre-rewrite) rule that
 * non-positive values are no-data.
 *
 * <=0 or non-finite or null/undefined: NO_DATA.
 */
export function formatUsdCompact(value: number | string | null | undefined): string {
  const amount = toFiniteNumber(value);
  if (amount === null || amount <= 0) return NO_DATA;

  const absolute = Math.abs(amount);
  if (absolute >= 1_000_000_000) return `$${(amount / 1_000_000_000).toFixed(1)}B`;
  if (absolute >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (absolute >= 1_000) return `$${(amount / 1_000).toFixed(1)}K`;
  return `$${amount.toFixed(amount >= 100 ? 0 : 2)}`;
}

/**
 * Pool fee percent formatter, ported verbatim from
 * MeteoraPoolsScreen.tsx:688 — trims trailing zeros, 3dp under 0.1%, 2dp
 * otherwise.
 *
 * null/undefined/non-finite: NO_DATA.
 */
export function formatFee(value: number | string | null | undefined): string {
  const fee = toFiniteNumber(value);
  if (fee === null) return NO_DATA;
  return `${fee.toFixed(fee < 0.1 ? 3 : 2).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

/**
 * Accessible USD formatter, ported verbatim from
 * MeteoraPoolsScreen.tsx:696 — spells out "US dollars" for screen readers.
 * A11y strings must not say "em dash", so no-data here is the word
 * 'Unavailable', not NO_DATA.
 */
export function formatUsdAccessible(value: number | string | null | undefined): string {
  const amount = toFiniteNumber(value);
  if (amount === null) return 'Unavailable';
  return `${amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  })} US dollars`;
}

/**
 * Integer count formatter, ported verbatim from
 * MeteoraPoolsScreen.tsx:705.
 *
 * null/undefined/non-finite: NO_DATA.
 */
export function formatCount(value: number | string | null | undefined): string {
  const count = toFiniteNumber(value);
  if (count === null) return NO_DATA;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(count);
}
