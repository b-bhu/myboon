/**
 * Pure row-building logic for the Polymarket venue adapter. Colors come from
 * MyBoon's shared theme (no Polymarket brand palette exists in tokens), while
 * row icons come from the feed's own market/team imagery. No React Native
 * imports or fetching.
 */

import { NO_DATA, formatUsdAccessible, formatUsdCompact } from '@/lib/format';
import { DEFAULT_MARKET_LIST_THEME } from '@/features/markets/venue.theme';

import type {
  Cell,
  ColumnSpec,
  MarketListRow,
  MarketListTheme,
} from '@/features/markets/venue.contract';
import type { FeedItem, FeedItemBinary, FeedItemMatch } from './polymarket.types';
import { sportForMarketSlug } from './polymarket.navigation';
import { formatPolymarketTitle, teamInitials } from './formatPolymarketTitle';

const SHORT_DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

export const POLYMARKET_COLUMNS: [ColumnSpec, ColumnSpec, ColumnSpec] = [
  { key: 'chance', label: 'Chance', width: 52, active: true },
  { key: 'volume', label: 'Volume', width: 62 },
  { key: 'ends', label: 'Ends', width: 52 },
];

// No Polymarket brand palette exists in tokens (the four protocol palettes
// there are not ours to extend), so Polymarket rows render in the shared
// default list theme — the same pattern as METEORA_THEME.
export const POLYMARKET_THEME: MarketListTheme = DEFAULT_MARKET_LIST_THEME;

/** A compact short date label ('Nov 3') rendered in UTC so tests stay stable. */
function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return SHORT_DATE_FORMAT.format(date);
}

/**
 * The market's implied chance: the binary YES price, or the leading outcome
 * price for a multi-outcome match. Prices are 0–1; null when the feed has no
 * priced outcome.
 */
export function polymarketChance(market: FeedItem): number | null {
  const prices = market.type === 'binary' ? [market.price] : market.outcomes.map((o) => o.price);
  const priced = prices.filter((p) => typeof p === 'number' && Number.isFinite(p));
  return priced.length > 0 ? Math.max(...priced) : null;
}

function chanceCell(market: FeedItem): Cell {
  const chance = polymarketChance(market);
  return {
    text: chance === null ? NO_DATA : `${Math.round(chance * 100)}%`,
    width: POLYMARKET_COLUMNS[0].width,
  };
}

function volumeCell(volume: number): Cell {
  return {
    text: formatUsdCompact(volume),
    width: POLYMARKET_COLUMNS[1].width,
  };
}

function endsCell(text: string, dim: boolean): Cell {
  return {
    text,
    tone: dim ? 'dim' : undefined,
    width: POLYMARKET_COLUMNS[2].width,
  };
}

/** When this row's market resolves (or 'Live' while a match is in play). */
export function polymarketEndsLabel(market: FeedItem): string {
  if (market.type === 'match') {
    if (market.status === 'live') return 'Live';
    return shortDate(market.gameStartTime ?? market.endDate) ?? NO_DATA;
  }
  return shortDate(market.endDate) ?? NO_DATA;
}

/** Letter fallback for a team leg — abbreviation first, then initials, then '?'. */
function teamLetter(name: string, abbreviation: string | null): string {
  if (abbreviation && abbreviation.length > 0) return abbreviation.charAt(0).toUpperCase();
  return teamInitials(name)?.charAt(0) ?? name.charAt(0).toUpperCase() ?? '?';
}

/**
 * Row href, in the string form `MarketListRow.href` takes. Mirrors
 * `getPolymarketMarketHref` exactly — sport slugs route to the sport detail
 * route, everything else to the generic market route — but as a plain string
 * instead of an expo-router Href object.
 */
export function polymarketHref(slug: string): string {
  const sport = sportForMarketSlug(slug);
  return sport
    ? `/markets/polymarket/sport/${sport}/${slug}`
    : `/markets/polymarket/market/${slug}`;
}

function binaryToRow(market: FeedItemBinary): MarketListRow {
  const title = formatPolymarketTitle({ title: market.title, slug: market.slug });
  return {
    key: market.slug,
    lead: {
      kind: 'token',
      // Prediction markets carry no token identity: the row renders from the
      // feed's own market image with a letter fallback, nothing is resolved.
      identityRef: '',
      identityIconUrl: null,
      venueIconUrl: market.image,
      letter: title.charAt(0).toUpperCase() || '?',
    },
    title,
    subtitle: market.category || undefined,
    cells: [
      chanceCell(market),
      volumeCell(market.volume),
      endsCell(polymarketEndsLabel(market), market.status === 'closed'),
    ],
    href: polymarketHref(market.slug),
    a11yLabel: [
      `Open ${title} prediction market.`,
      chanceCellText(market),
      `${formatUsdAccessible(market.volume)} total volume.`,
      endsSentence(polymarketEndsLabel(market)),
    ]
      .filter(Boolean)
      .join(' '),
  };
}

function matchToRow(market: FeedItemMatch): MarketListRow {
  const [home, away] = market.teams;
  const title = formatPolymarketTitle({
    title: market.title,
    slug: market.slug,
    outcomes: market.outcomes.map((o) => o.label),
  });
  const sportLabel = market.sport.toUpperCase();
  const isLive = market.status === 'live';
  return {
    key: market.slug,
    lead: {
      kind: 'pair',
      x: {
        identityRef: '',
        identityIconUrl: null,
        venueIconUrl: home?.logo ?? market.image,
        letter: home ? teamLetter(home.name, home.abbreviation) : '?',
      },
      y: {
        identityRef: '',
        identityIconUrl: null,
        venueIconUrl: away?.logo ?? null,
        letter: away ? teamLetter(away.name, away.abbreviation) : '?',
      },
    },
    title,
    subtitle: isLive ? `${sportLabel} · Live` : sportLabel,
    cells: [
      chanceCell(market),
      volumeCell(market.volume),
      endsCell(polymarketEndsLabel(market), !isLive && market.status === 'closed'),
    ],
    href: polymarketHref(market.slug),
    a11yLabel: [
      `Open ${title} ${sportLabel} market.`,
      isLive ? 'Live now.' : '',
      chanceCellText(market),
      `${formatUsdAccessible(market.volume)} total volume.`,
    ]
      .filter(Boolean)
      .join(' '),
  };
}

function chanceCellText(market: FeedItem): string {
  const chance = polymarketChance(market);
  return chance === null ? '' : `${Math.round(chance * 100)}% chance of the leading outcome.`;
}

function endsSentence(label: string): string {
  return label === NO_DATA ? '' : `Ends ${label}.`;
}

export function polymarketToRow(market: FeedItem): MarketListRow {
  return market.type === 'binary' ? binaryToRow(market) : matchToRow(market);
}

/** Case-insensitive match on title, category, tags, team and outcome labels. */
export function polymarketMatchesQuery(market: FeedItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const hayFields = [market.title, market.category, ...market.tags];
  if (market.type === 'match') {
    hayFields.push(...market.teams.map((t) => t.name));
  }
  hayFields.push(...market.outcomes.map((o) => o.label));
  return hayFields.some((field) => field.toLowerCase().includes(needle));
}

/** Volume descending — the feed's own default ordering is not guaranteed. */
export function sortFeedItems(items: readonly FeedItem[]): FeedItem[] {
  return [...items].sort((a, b) => b.volume - a.volume);
}
