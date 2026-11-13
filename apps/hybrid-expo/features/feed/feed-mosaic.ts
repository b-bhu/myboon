import type { PhoenixCandleInterval } from '@/features/perps/phoenix.api';
import type { StorySummary } from './feed.types';

/**
 * Topic mosaic layout and the topic-to-market table for issue #615.
 * Tile size follows event count (the activity field the stories API returns).
 * A pinned action appears only when the story name or slug matches a market
 * that Phoenix already lists. Unknown topics get no action and no chart.
 */

export const MOSAIC_PAGE_SIZE = 10;
export const MOSAIC_COLUMNS = 6;
export const MOSAIC_ROWS = 4;

export type MosaicTileKind = 'large' | 'tall' | 'regular' | 'slim';
export type ChartRangeKey = '1D' | '1W' | '1M' | '1Y';

export interface MosaicPlacement {
  index: number;
  kind: MosaicTileKind;
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
}

export interface MosaicPage<T> {
  items: T[];
  placements: MosaicPlacement[];
}

export interface TopicMarketLink {
  symbol: string;
  action: string;
  assetName: string;
}

export interface ChartRangeRequest {
  key: ChartRangeKey;
  interval: PhoenixCandleInterval;
  count: number;
}

const SPANS: Record<MosaicTileKind, { col: number; row: number }> = {
  large: { col: 3, row: 2 },
  tall: { col: 2, row: 2 },
  regular: { col: 2, row: 1 },
  slim: { col: 1, row: 1 },
};

/** 1D/1W/1M/1Y as candle windows Phoenix already serves. A range with fewer than two closes is hidden. */
export const CHART_RANGES: readonly ChartRangeRequest[] = [
  { key: '1D', interval: '1h', count: 24 },
  { key: '1W', interval: '4h', count: 42 },
  { key: '1M', interval: '1d', count: 30 },
  { key: '1Y', interval: '1d', count: 365 },
];

interface MarketRule {
  tokens: readonly string[];
  link: TopicMarketLink;
}

const MARKET_RULES: readonly MarketRule[] = [
  { tokens: ['bitcoin', 'btc'], link: { symbol: 'BTC-PERP', action: 'Trade BTC perps', assetName: 'Bitcoin' } },
  { tokens: ['ethereum', 'ether', 'eth'], link: { symbol: 'ETH-PERP', action: 'Trade ETH perps', assetName: 'Ether' } },
  { tokens: ['solana', 'sol'], link: { symbol: 'SOL-PERP', action: 'Trade SOL perps', assetName: 'Solana' } },
  { tokens: ['gold'], link: { symbol: 'GOLD-PERP', action: 'Trade gold perps', assetName: 'Gold' } },
  { tokens: ['silver'], link: { symbol: 'SILVER-PERP', action: 'Trade silver perps', assetName: 'Silver' } },
  { tokens: ['eurusd', 'euro'], link: { symbol: 'EURUSD-PERP', action: 'Trade EUR/USD perps', assetName: 'Euro' } },
  { tokens: ['gbpusd', 'sterling', 'pound'], link: { symbol: 'GBPUSD-PERP', action: 'Trade GBP/USD perps', assetName: 'Sterling' } },
  { tokens: ['usdjpy', 'yen'], link: { symbol: 'USDJPY-PERP', action: 'Trade USD/JPY perps', assetName: 'Yen' } },
  { tokens: ['nasdaq', 'qqq'], link: { symbol: 'QQQ-PERP', action: 'Trade Nasdaq perps', assetName: 'Nasdaq 100' } },
  { tokens: ['spy', 'spx'], link: { symbol: 'SPY-PERP', action: 'Trade S&P 500 perps', assetName: 'S&P 500' } },
  { tokens: ['bonk'], link: { symbol: 'KBONK-PERP', action: 'Trade BONK perps', assetName: 'Bonk' } },
  { tokens: ['iran', 'oil', 'brent', 'wti', 'hormuz', 'crude'], link: { symbol: 'WTIOIL-PERP', action: 'Trade WTI perps', assetName: 'WTI crude' } },
];

/** Largest event count first. That is the stand-in for 24h activity, which the API does not return. */
export function rankStories(stories: readonly StorySummary[]): StorySummary[] {
  return stories.slice().sort((a, b) => (
    b.eventCount - a.eventCount
    || Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    || a.storySlug.localeCompare(b.storySlug)
  ));
}

export function mosaicTileKinds(count: number): MosaicTileKind[] {
  if (count <= 0) return [];
  if (count === 1) return ['large'];
  if (count === 2) return ['large', 'tall'];
  if (count <= 8) {
    return ['large', 'tall', ...Array.from({ length: count - 2 }, (): MosaicTileKind => 'regular')];
  }
  const regulars = count - 4;
  return ['large', 'tall', 'slim', 'slim', ...Array.from({ length: regulars }, (): MosaicTileKind => 'regular')];
}

export function placeMosaicTiles(count: number): MosaicPlacement[] {
  // A short list still fills the mosaic. Empty cells would read as a missing page.
  if (count === 1) {
    return [{ index: 0, kind: 'large', col: 0, row: 0, colSpan: MOSAIC_COLUMNS, rowSpan: MOSAIC_ROWS }];
  }
  if (count === 2) {
    return [
      { index: 0, kind: 'large', col: 0, row: 0, colSpan: 3, rowSpan: MOSAIC_ROWS },
      { index: 1, kind: 'tall', col: 3, row: 0, colSpan: 3, rowSpan: MOSAIC_ROWS },
    ];
  }
  const kinds = mosaicTileKinds(count);
  const grid = Array.from({ length: MOSAIC_ROWS }, () => Array.from({ length: MOSAIC_COLUMNS }, () => false));
  const placed: MosaicPlacement[] = [];
  kinds.forEach((kind, index) => {
    const span = SPANS[kind];
    for (let row = 0; row <= MOSAIC_ROWS - span.row; row += 1) {
      for (let col = 0; col <= MOSAIC_COLUMNS - span.col; col += 1) {
        let free = true;
        for (let y = 0; y < span.row && free; y += 1) {
          for (let x = 0; x < span.col; x += 1) {
            if (grid[row + y]?.[col + x]) {
              free = false;
              break;
            }
          }
        }
        if (!free) continue;
        for (let y = 0; y < span.row; y += 1) {
          for (let x = 0; x < span.col; x += 1) {
            const line = grid[row + y];
            if (line) line[col + x] = true;
          }
        }
        placed.push({ index, kind, col, row, colSpan: span.col, rowSpan: span.row });
        return;
      }
    }
  });
  return placed;
}

export function mosaicPages<T>(items: readonly T[]): MosaicPage<T>[] {
  if (items.length === 0) return [];
  const pages: MosaicPage<T>[] = [];
  for (let start = 0; start < items.length; start += MOSAIC_PAGE_SIZE) {
    const slice = items.slice(start, start + MOSAIC_PAGE_SIZE);
    pages.push({ items: slice, placements: placeMosaicTiles(slice.length) });
  }
  return pages;
}

function storyTokens(slug: string, name: string): Set<string> {
  return new Set(`${slug} ${name}`.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0));
}

/** Pinned market for a story, or null when no listed market matches its name or slug. */
export function topicMarket(slug: string, name: string): TopicMarketLink | null {
  const tokens = storyTokens(slug, name);
  const rule = MARKET_RULES.find((candidate) => candidate.tokens.some((token) => tokens.has(token)));
  return rule ? rule.link : null;
}

/** Today and mosaic heights. 25% and 40% of the phone, shrunk together if the column cannot hold a calendar card. */
export function feedBandHeights(windowHeight: number, columnHeight: number): { today: number; mosaic: number } {
  const today = Math.max(0, Math.round(windowHeight * 0.25));
  const mosaic = Math.max(0, Math.round(windowHeight * 0.4));
  const minCalendar = 96;
  const gaps = 16;
  if (!(columnHeight > 0)) return { today, mosaic };
  const available = columnHeight - gaps;
  if (today + mosaic + minCalendar <= available) return { today, mosaic };
  const room = Math.max(0, available - minCalendar);
  const scale = today + mosaic > 0 ? room / (today + mosaic) : 1;
  return { today: Math.round(today * scale), mosaic: Math.round(mosaic * scale) };
}

export function percentChange(closes: readonly number[]): number | null {
  const first = closes[0];
  const last = closes[closes.length - 1];
  if (closes.length < 2 || first === undefined || last === undefined || !Number.isFinite(first) || !Number.isFinite(last) || first === 0) {
    return null;
  }
  return ((last - first) / Math.abs(first)) * 100;
}

export function formatMarketPrice(value: number): string {
  if (!Number.isFinite(value)) return '';
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatSignedPercent(value: number): string {
  if (!Number.isFinite(value)) return '';
  const digits = Math.abs(value).toFixed(2);
  if (value > 0) return `+${digits}%`;
  if (value < 0) return `-${digits}%`;
  return `${digits}%`;
}

export function isOfflineMessage(message: string): boolean {
  return /failed to fetch|network request failed|network error|offline|timed out|timeout|aborted|load failed/i.test(message);
}

export function sectionFailureTitle(message: string, unavailable: string): string {
  return isOfflineMessage(message) ? 'You appear to be offline' : unavailable;
}
