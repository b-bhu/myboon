import type { StoryMarket } from '@myboon/shared/stories';
import type { StorySummary } from './feed.types';

/**
 * Developing-stories layout and market helpers (issue #684).
 * Stories are ranked by activity, so the busiest story on every page of 10
 * gets the large tile and the two quietest get slim slots. The pinned trade
 * action still comes from the exact-slug market table below; the tiles and
 * the details price section read each story's `markets` instead.
 */

export const MOSAIC_PAGE_SIZE = 10;
export const MOSAIC_COLUMNS = 6;
export const MOSAIC_ROWS = 4;

export type MosaicTileKind = 'large' | 'tall' | 'wide' | 'slim';

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

interface TileSpec {
  kind: MosaicTileKind;
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
}

/**
 * The mock's fixed slots on the 6×4 grid, in rank order within a page.
 * A short last page fills only the slots it has and is never re-laid out.
 */
export const PAGE_SLOTS: readonly TileSpec[] = [
  { kind: 'large', col: 0, row: 0, colSpan: 3, rowSpan: 2 },
  { kind: 'tall', col: 3, row: 0, colSpan: 2, rowSpan: 2 },
  { kind: 'wide', col: 0, row: 2, colSpan: 2, rowSpan: 1 },
  { kind: 'wide', col: 2, row: 2, colSpan: 2, rowSpan: 1 },
  { kind: 'wide', col: 4, row: 2, colSpan: 2, rowSpan: 1 },
  { kind: 'wide', col: 0, row: 3, colSpan: 2, rowSpan: 1 },
  { kind: 'wide', col: 2, row: 3, colSpan: 2, rowSpan: 1 },
  { kind: 'wide', col: 4, row: 3, colSpan: 2, rowSpan: 1 },
  { kind: 'slim', col: 5, row: 0, colSpan: 1, rowSpan: 1 },
  { kind: 'slim', col: 5, row: 1, colSpan: 1, rowSpan: 1 },
];

/** Pinned market for an exact story slug. The display name is ignored on purpose. */
export function topicMarket(slug: string, _name?: string): TopicMarketLink | null {
  return MARKET_BY_SLUG[slug.trim().toLowerCase()] ?? null;
}

/**
 * Busiest first: the API's 7-day `eventCount` descending, then the newest
 * `updatedAt` for ties, then `storySlug` ascending for a full tie.
 */
export function rankStories(stories: readonly StorySummary[]): StorySummary[] {
  return stories.slice().sort(compareStoryActivity);
}

function compareStoryActivity(a: StorySummary, b: StorySummary): number {
  if (a.eventCount !== b.eventCount) return b.eventCount - a.eventCount;
  const aMs = Date.parse(a.updatedAt);
  const bMs = Date.parse(b.updatedAt);
  const aValid = Number.isFinite(aMs);
  const bValid = Number.isFinite(bMs);
  if (aValid !== bValid) return aValid ? -1 : 1;
  if (aValid && aMs !== bMs) return bMs - aMs;
  return a.storySlug.localeCompare(b.storySlug);
}

/**
 * Splits the ranked list into pages of 10; page k holds ranks 10k+1 to
 * 10k+10 and slot n on a page holds that page's n-th busiest story.
 */
export function mosaicPages<T extends StorySummary>(items: readonly T[]): MosaicPage<T>[] {
  const ranked = rankStories(items) as T[];
  const pages: MosaicPage<T>[] = [];
  for (let first = 0; first < ranked.length; first += MOSAIC_PAGE_SIZE) {
    const slice = ranked.slice(first, first + MOSAIC_PAGE_SIZE);
    const placements = PAGE_SLOTS.slice(0, slice.length).map((slot, index) => ({
      index,
      kind: slot.kind,
      col: slot.col,
      row: slot.row,
      colSpan: slot.colSpan,
      rowSpan: slot.rowSpan,
    }));
    pages.push({ items: slice, placements });
  }
  return pages;
}

/** Markets with both a price and a 24h move, in rank order. */
export function pricedMarkets(story: Pick<StorySummary, 'markets'>): StoryMarket[] {
  return story.markets
    .filter((market) => market.price !== null && market.change24hPct !== null)
    .sort((a, b) => a.rank - b.rank);
}

/**
 * The market a tile shows on this rotation tick: the priced markets cycle
 * head to tail, reduce motion parks on rank 1, and no priced market shows
 * nothing.
 */
export function shownMarket(
  story: Pick<StorySummary, 'markets'>,
  tick: number,
  reduced: boolean,
): StoryMarket | null {
  const priced = pricedMarkets(story);
  if (priced.length === 0) return null;
  if (reduced || priced.length === 1) return priced[0] ?? null;
  const index = ((tick % priced.length) + priced.length) % priced.length;
  return priced[index] ?? null;
}

/**
 * The market a tile shows when a slot is only swapped in once its sparkline
 * data exists (#798): rotation still cycles priced markets (the 4-second
 * crossfade decided in #684), but a tick whose market has no candles yet
 * falls back to the newest earlier rotation that does, so a slot never
 * fades in bare and the previous sparkline holds until the next one loads.
 * Reduce motion never rotates, so it stays on rank 1 whatever is ready.
 */
export function heldMarket(
  story: Pick<StorySummary, 'markets'>,
  tick: number,
  reduced: boolean,
  sparkReady: (symbol: string) => boolean,
): StoryMarket | null {
  const priced = pricedMarkets(story);
  if (priced.length === 0) return null;
  if (reduced || priced.length === 1) return priced[0] ?? null;
  for (let back = 0; back < priced.length; back += 1) {
    const index = (((tick - back) % priced.length) + priced.length) % priced.length;
    const market = priced[index];
    if (market && sparkReady(market.symbol)) return market;
  }
  return null;
}

/**
 * Symbols whose candles to prefetch for one page (#798): every priced market
 * of the page's lead tiles (large and tall), so the rotation between them
 * finds the next sparkline already on hand. Lead tiles are the only tiles
 * that paint a sparkline.
 */
export function pageSparkSymbols(pages: readonly MosaicPage<StorySummary>[], pageIndex: number): string[] {
  const page = pages[pageIndex];
  if (!page) return [];
  const symbols = new Set<string>();
  for (const placement of page.placements) {
    if (placement.kind !== 'large' && placement.kind !== 'tall') continue;
    const story = page.items[placement.index];
    if (!story) continue;
    for (const market of pricedMarkets(story)) symbols.add(market.symbol);
  }
  return [...symbols].sort();
}

export interface TileMove {
  text: string;
  tone: 'up' | 'down' | 'dim';
}

/**
 * One-decimal tile move: `+2.8%` in the up colour, `-0.6%` in the down
 * colour, and `0.0%` dim with no sign when the move rounds to a tenth of
 * nothing.
 */
export function formatTileMove(move: number): TileMove {
  if (!Number.isFinite(move) || Math.round(Math.abs(move) * 10) === 0) {
    return { text: '0.0%', tone: 'dim' };
  }
  const text = `${Math.abs(move).toFixed(1)}%`;
  return move > 0 ? { text: `+${text}`, tone: 'up' } : { text: `-${text}`, tone: 'down' };
}

/**
 * Corner arrow on a story tile (#711): a priced, non-dim move gets the arrow
 * on lead and wide tiles, but never on slim — a slim tile's one cell claims
 * the corner for the title and shows the direction through the move's sign
 * and colour.
 */
export function tileShowsArrow(move: TileMove | null, kind: MosaicTileKind): boolean {
  return move !== null && move.tone !== 'dim' && kind !== 'slim';
}

/** The details tab to open: the `market` param's symbol when linked, else rank 1. */
export function pickDetailMarket(
  markets: readonly StoryMarket[],
  marketParam: string | null | undefined,
): StoryMarket | null {
  if (markets.length === 0) return null;
  if (marketParam) {
    const wanted = markets.find((market) => market.symbol === marketParam);
    if (wanted) return wanted;
  }
  return markets.find((market) => market.rank === 1) ?? markets[0] ?? null;
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
