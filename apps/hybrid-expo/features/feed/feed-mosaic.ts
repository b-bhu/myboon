import type { PhoenixCandleInterval } from '@/features/perps/phoenix.api';
import type { StorySummary } from './feed.types';

/**
 * Topic mosaic layout and the topic-to-market table for issue #615.
 * Tile size follows event count (the activity field the stories API returns).
 * A pinned action appears only for an exact story slug in the market table.
 * Unknown topics get no action and no chart.
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
  /** One line on the detail, until a real causal chain exists. */
  note: string;
}

export interface ChartRangeRequest {
  key: ChartRangeKey;
  interval: PhoenixCandleInterval;
  count: number;
}

/** 1D/1W/1M/1Y as candle windows Phoenix already serves. A range with fewer than two closes is hidden. */
export const CHART_RANGES: readonly ChartRangeRequest[] = [
  { key: '1D', interval: '1h', count: 24 },
  { key: '1W', interval: '4h', count: 42 },
  { key: '1M', interval: '1d', count: 30 },
  { key: '1Y', interval: '1d', count: 365 },
];

/** Exact story slugs only. A word inside a headline must not pick a market. */
const MARKET_BY_SLUG: Readonly<Record<string, TopicMarketLink>> = {
  bitcoin: {
    symbol: 'BTC-PERP',
    action: 'Trade BTC perps',
    assetName: 'Bitcoin',
    note: 'Bitcoin is the market this story follows.',
  },
  'us-iran-conflict': {
    symbol: 'WTIOIL-PERP',
    action: 'Trade WTI perps',
    assetName: 'WTI crude',
    note: 'Oil is the market most tied to this story.',
  },
};

/** Largest event count first. That is the stand-in for 24h activity, which the API does not return. */
export function rankStories(stories: readonly StorySummary[]): StorySummary[] {
  return stories.slice().sort((a, b) => (
    b.eventCount - a.eventCount
    || Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    || a.storySlug.localeCompare(b.storySlug)
  ));
}

interface TileSpec {
  colSpan: number;
  rowSpan: number;
  kind: MosaicTileKind;
}

/** Rows whose widths sum to 6 and whose heights sum to 4, so counts 1–10 fill the grid. */
const FULL_LAYOUTS: Readonly<Record<number, readonly (readonly TileSpec[])[]>> = {
  1: [[{ colSpan: 6, rowSpan: 4, kind: 'large' }]],
  2: [[
    { colSpan: 3, rowSpan: 4, kind: 'large' },
    { colSpan: 3, rowSpan: 4, kind: 'tall' },
  ]],
  3: [
    [{ colSpan: 3, rowSpan: 2, kind: 'large' }, { colSpan: 3, rowSpan: 2, kind: 'tall' }],
    [{ colSpan: 6, rowSpan: 2, kind: 'regular' }],
  ],
  4: [
    [{ colSpan: 3, rowSpan: 2, kind: 'large' }, { colSpan: 3, rowSpan: 2, kind: 'tall' }],
    [{ colSpan: 3, rowSpan: 2, kind: 'regular' }, { colSpan: 3, rowSpan: 2, kind: 'regular' }],
  ],
  5: [
    [{ colSpan: 3, rowSpan: 2, kind: 'large' }, { colSpan: 3, rowSpan: 2, kind: 'tall' }],
    [{ colSpan: 2, rowSpan: 2, kind: 'regular' }, { colSpan: 2, rowSpan: 2, kind: 'regular' }, { colSpan: 2, rowSpan: 2, kind: 'regular' }],
  ],
  6: [
    [{ colSpan: 3, rowSpan: 2, kind: 'large' }, { colSpan: 3, rowSpan: 2, kind: 'tall' }],
    [{ colSpan: 3, rowSpan: 1, kind: 'regular' }, { colSpan: 3, rowSpan: 1, kind: 'regular' }],
    [{ colSpan: 3, rowSpan: 1, kind: 'regular' }, { colSpan: 3, rowSpan: 1, kind: 'regular' }],
  ],
  7: [
    [{ colSpan: 3, rowSpan: 1, kind: 'large' }, { colSpan: 3, rowSpan: 1, kind: 'tall' }],
    [{ colSpan: 3, rowSpan: 1, kind: 'regular' }, { colSpan: 3, rowSpan: 1, kind: 'regular' }],
    [{ colSpan: 3, rowSpan: 1, kind: 'regular' }, { colSpan: 3, rowSpan: 1, kind: 'regular' }],
    [{ colSpan: 6, rowSpan: 1, kind: 'regular' }],
  ],
  8: [
    [{ colSpan: 3, rowSpan: 1, kind: 'large' }, { colSpan: 3, rowSpan: 1, kind: 'tall' }],
    [{ colSpan: 3, rowSpan: 1, kind: 'regular' }, { colSpan: 3, rowSpan: 1, kind: 'regular' }],
    [{ colSpan: 3, rowSpan: 1, kind: 'regular' }, { colSpan: 3, rowSpan: 1, kind: 'regular' }],
    [{ colSpan: 3, rowSpan: 1, kind: 'regular' }, { colSpan: 3, rowSpan: 1, kind: 'regular' }],
  ],
  9: [
    [{ colSpan: 2, rowSpan: 2, kind: 'large' }, { colSpan: 2, rowSpan: 2, kind: 'tall' }, { colSpan: 2, rowSpan: 2, kind: 'regular' }],
    [{ colSpan: 2, rowSpan: 1, kind: 'regular' }, { colSpan: 2, rowSpan: 1, kind: 'regular' }, { colSpan: 2, rowSpan: 1, kind: 'regular' }],
    [{ colSpan: 2, rowSpan: 1, kind: 'regular' }, { colSpan: 2, rowSpan: 1, kind: 'regular' }, { colSpan: 2, rowSpan: 1, kind: 'regular' }],
  ],
  10: [
    [{ colSpan: 2, rowSpan: 1, kind: 'large' }, { colSpan: 2, rowSpan: 1, kind: 'tall' }, { colSpan: 2, rowSpan: 1, kind: 'regular' }],
    [{ colSpan: 2, rowSpan: 1, kind: 'regular' }, { colSpan: 2, rowSpan: 1, kind: 'regular' }, { colSpan: 2, rowSpan: 1, kind: 'regular' }],
    [{ colSpan: 3, rowSpan: 1, kind: 'regular' }, { colSpan: 3, rowSpan: 1, kind: 'regular' }],
    [{ colSpan: 3, rowSpan: 1, kind: 'regular' }, { colSpan: 3, rowSpan: 1, kind: 'regular' }],
  ],
};

function placementsFromRows(rows: readonly (readonly TileSpec[])[]): MosaicPlacement[] {
  const placed: MosaicPlacement[] = [];
  let index = 0;
  let rowCursor = 0;
  for (const line of rows) {
    let col = 0;
    const rowSpan = line[0]?.rowSpan ?? 1;
    for (const tile of line) {
      placed.push({ index, kind: tile.kind, col, row: rowCursor, colSpan: tile.colSpan, rowSpan: tile.rowSpan });
      col += tile.colSpan;
      index += 1;
    }
    rowCursor += rowSpan;
  }
  return placed;
}

/**
 * Pack `count` tiles into the 6×4 mosaic.
 * `stretch: false` keeps a 1- or 2-tile continuation page at lead size instead of filling the band.
 */
export function placeMosaicTiles(count: number, options?: { stretch?: boolean }): MosaicPlacement[] {
  if (count <= 0) return [];
  if (options?.stretch === false && count <= 2) {
    if (count === 1) return [{ index: 0, kind: 'large', col: 0, row: 0, colSpan: 3, rowSpan: 2 }];
    return [
      { index: 0, kind: 'large', col: 0, row: 0, colSpan: 3, rowSpan: 2 },
      { index: 1, kind: 'tall', col: 3, row: 0, colSpan: 3, rowSpan: 2 },
    ];
  }
  const rows = FULL_LAYOUTS[count];
  return rows ? placementsFromRows(rows) : [];
}

export function mosaicPages<T>(items: readonly T[]): MosaicPage<T>[] {
  if (items.length === 0) return [];
  const pageCount = Math.ceil(items.length / MOSAIC_PAGE_SIZE);
  const pages: MosaicPage<T>[] = [];
  for (let index = 0; index < pageCount; index += 1) {
    const slice = items.slice(index * MOSAIC_PAGE_SIZE, (index + 1) * MOSAIC_PAGE_SIZE);
    const laterShort = pageCount > 1 && index > 0 && slice.length <= 2;
    pages.push({ items: slice, placements: placeMosaicTiles(slice.length, { stretch: !laterShort }) });
  }
  return pages;
}

/** Pinned market for an exact story slug. The display name is ignored on purpose. */
export function topicMarket(slug: string, _name?: string): TopicMarketLink | null {
  return MARKET_BY_SLUG[slug.trim().toLowerCase()] ?? null;
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
