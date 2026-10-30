import { withMock } from './feed-mocks';
import { heatmapTone } from './token-heatmap-layout';
import type { HeatmapToken } from './token-heatmap.types';

/**
 * Pure view model for the Market slide, Market screen and token sheet
 * (issue #500). Movers, table ordering and up/down counts come straight from
 * the fetched heatmap data. Category assignment, sparklines and the "why it
 * moved" card are deterministic samples that exist only while FEED mocks are
 * enabled — the UI decides through marketSample() and then either applies
 * category filtering or always shows every token.
 *
 * No react imports: plain-node tests run this module directly.
 */

export type MoverMode = 'gainers' | 'losers' | 'volume';

export const MARKET_INTERVALS = ['24h', '1h'] as const;
export type MarketInterval = typeof MARKET_INTERVALS[number];

/** '24H' / '1H' — the mock's interval toggle label. */
export function intervalLabel(interval: MarketInterval): string {
  return interval.toUpperCase();
}

export const MARKET_CATEGORIES = ['trending', 'crypto', 'stocks', 'memes'] as const;
export type MarketCategory = typeof MARKET_CATEGORIES[number];

export const MARKET_CATEGORY_LABELS: Record<MarketCategory, string> = {
  trending: 'TRENDING',
  crypto: 'CRYPTO',
  stocks: 'TOKENIZED STOCKS',
  memes: 'MEMES',
};

/** SegmentedTabs options for the four mock category tabs. */
export function marketCategoryOptions(): { key: MarketCategory; label: string }[] {
  return MARKET_CATEGORIES.map((category) => ({ key: category, label: MARKET_CATEGORY_LABELS[category] }));
}

const bySymbolAsc = (a: HeatmapToken, b: HeatmapToken): number =>
  a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;

const withFiniteChange = (token: HeatmapToken): boolean =>
  token.priceChangePct !== null && Number.isFinite(token.priceChangePct);

/**
 * Top movers for a mode: gainers by change desc, losers by change asc (the
 * whole range, not negatives-only), volume by volumeUsd desc. Tokens without
 * a change never appear in the change modes; ties break by symbol asc.
 */
/** Stablecoins kept out of movers and the table (they never "move"). */
export const STABLECOIN_SYMBOLS: ReadonlySet<string> = new Set([
  'USDC', 'USDT', 'USDG', 'PYUSD', 'USDS', 'USDE', 'FDUSD', 'DAI', 'USDH', 'UXD', 'USD1',
]);

/** True for listed stablecoins and their jl- / wrapped (w-) / bridged (.e) variants. */
export function isStablecoin(token: { symbol: string }): boolean {
  const base = token.symbol.trim().toUpperCase().replace(/^(JL|W)(?=USD|DAI|PYUSD|FDUSD)/, '').replace(/\.E$/, '');
  return STABLECOIN_SYMBOLS.has(base);
}

export function movers(tokens: HeatmapToken[], mode: MoverMode, n = 3): HeatmapToken[] {
  tokens = tokens.filter((token) => !isStablecoin(token));
  if (mode === 'volume') {
    return [...tokens].sort((a, b) => b.volumeUsd - a.volumeUsd || bySymbolAsc(a, b)).slice(0, n);
  }
  const direction = mode === 'gainers' ? -1 : 1;
  return tokens
    .filter(withFiniteChange)
    .sort((a, b) => direction * ((a.priceChangePct ?? 0) - (b.priceChangePct ?? 0)) || bySymbolAsc(a, b))
    .slice(0, n);
}

/** Market-table rows: volumeUsd desc, ties by symbol asc. */
export function tableRows(tokens: HeatmapToken[]): HeatmapToken[] {
  return tokens.filter((token) => !isStablecoin(token)).sort((a, b) => b.volumeUsd - a.volumeUsd || bySymbolAsc(a, b));
}

/** Up/down tile counts; zero and unknown changes are neither (heatmapTone). */
export function upDownCounts(tokens: HeatmapToken[]): { up: number; down: number } {
  let up = 0;
  let down = 0;
  for (const token of tokens) {
    const tone = heatmapTone(token.priceChangePct);
    if (tone === 'up') up += 1;
    else if (tone === 'down') down += 1;
  }
  return { up, down };
}

/** Mock's treemap caption: '16 tokens · sized by volume'. */
export function treemapCaption(tokens: HeatmapToken[]): string {
  return `${tokens.length} tokens · sized by volume`;
}

/**
 * Price like the mock: $182.40 (2 decimals at/above 1), $0.7124 (4 decimals
 * from 0.01 up), two significant digits for tinier prices ($0.000022) without
 * exponent notation; $0.00 for zero and '—' when unknown.
 */
export function formatTokenPrice(price: number | null): string {
  if (price === null || !Number.isFinite(price)) return '—';
  if (price === 0) return '$0.00';
  if (price >= 1) return `$${price.toFixed(2)}`;
  if (price >= 0.01) return `$${price.toFixed(4)}`;
  const exponent = Math.floor(Math.log10(price));
  const decimals = Math.min(12, Math.max(0, -(exponent) + 1));
  return `$${price.toFixed(decimals)}`;
}

/** '▲ 2.4%' / '▼ 3.2%' / '0.0%' (no arrow) / '—' when unknown. */
export function changeText(change: number | null): string {
  if (change === null || !Number.isFinite(change)) return '—';
  if (change === 0) return '0.0%';
  const arrow = change > 0 ? '▲' : '▼';
  return `${arrow} ${Math.abs(change).toFixed(1)}%`;
}

// Sample data below. Deterministic per address, same values every call.

const SAMPLE_CATEGORIES: readonly MarketCategory[] = ['crypto', 'stocks', 'memes'];

const hash = (address: string, seed: number): number => {
  let value = seed | 0;
  for (let index = 0; index < address.length; index += 1) {
    value = (Math.imul(value, 31) + address.charCodeAt(index)) | 0;
  }
  return value < 0 ? -value : value;
};

/** Sample bucket from the address hash — trending never happens by itself. */
export function sampleCategory(token: Pick<HeatmapToken, 'address'>): MarketCategory {
  return SAMPLE_CATEGORIES[hash(token.address, 0x6d61) % SAMPLE_CATEGORIES.length]!;
}

/** 'trending' shows everything; the other tabs keep matching sample buckets. */
export function filterByCategory(tokens: HeatmapToken[], category: MarketCategory): HeatmapToken[] {
  if (category === 'trending') return tokens;
  return tokens.filter((token) => sampleCategory(token) === category);
}

/** Sparkline shape 0..1 per address, same values every call. */
export function sampleSparkline(address: string, points = 12): number[] {
  const values: number[] = [];
  let seed = hash(address, 0x515c);
  for (let index = 0; index < points; index += 1) {
    seed = (Math.imul(seed || 0x2f6e2b1, 48271) + 11) >>> 0;
    values.push((seed % 1000) / 1000);
  }
  return values;
}

/** Generic sample headline so the sheet's "why it moved" card reads like the mock. */
export function sampleNews(token: Pick<HeatmapToken, 'name' | 'symbol'>): { title: string; ago: string } {
  return { title: `${token.name} trades on heavier volume today`, ago: '2h' };
}

/** Mock gate for the sheet/screen sample content: true while live, null when off. */
export function marketSample(enabled?: boolean): true | null {
  return withMock(true, enabled);
}