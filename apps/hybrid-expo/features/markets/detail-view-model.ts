/**
 * View-model contract for the shared market detail screen (#651).
 *
 * Pure-refactor frame: the venue composition modules build this object from
 * data lifted verbatim from the four legacy detail screens. Only the chart
 * body is venue-swapped; every other section renders from these props.
 */

import type { ReactNode } from 'react';

export type ValueTone = 'up' | 'down' | 'flat';

export interface MarketDetailTopBarVM {
  /** Market name, truncating to one line. */
  marketName: string;
  /** Venue badge word inside the bar. */
  venueBadge: string;
  onBack: () => void;
  onInfoPress?: () => void;
}

export interface MarketDetailPriceRowVM {
  /** Formatted price, already scrub/live resolved. */
  price: string;
  change?: { text: string; tone: ValueTone } | null;
  /** One venue-supplied secondary stat (perp funding, volume, resolution date). */
  secondaryStat?: { label: string; value: string } | null;
  /** Liveness indicator for venues with a push feed. */
  live?: boolean;
}

export interface MarketDetailRangeVM {
  ranges: readonly string[];
  activeRange: string;
  onSelectRange: (range: string) => void;
  /** News toggle rendered on the same line, right-aligned. */
  newsVisible: boolean;
  onToggleNews?: () => void;
}

export interface NewsStoryCard {
  id: string;
  label: string;
  timeLabel: string;
  imageUrl?: string | null;
  fallbackText?: string;
  onOpen?: () => void;
}

export interface PositionRowVM {
  id: string;
  title: string;
  detail: string;
  value: string;
  tone: ValueTone;
  onRowPress?: () => void;
  actions?: { label: string; onPress: () => void }[];
}

export interface MarketDetailActionButtonVM {
  label: string;
  /** Bar buttons always open the action sheet; a venue handler runs first. */
  onPress?: () => void;
  variant: 'primary' | 'secondary';
  disabled?: boolean;
  busy?: boolean;
}

export interface MarketDetailActionBarVM {
  connected: boolean;
  /** Shown as the single connect action + reason when no wallet is linked. */
  connectReason?: string;
  /** Word for the single action's button (defaults to the connect wording). */
  connectLabel?: string;
  onConnect?: () => void;
  buttons: [MarketDetailActionButtonVM, MarketDetailActionButtonVM];
}

export interface MarketDetailViewModel {
  topBar: MarketDetailTopBarVM;
  priceRow: MarketDetailPriceRowVM;
  range: MarketDetailRangeVM;
  /** Inline market-level notice (failed fetch with retry); null hides it. */
  notice?: ReactNode;
  /** Chart body — the only venue-swapped region of the screen. */
  chartBody: ReactNode;
  /** News marker cards; an empty list hides the rail entirely. */
  newsStories: readonly NewsStoryCard[];
  positionsTitle: string;
  positionRows: readonly PositionRowVM[];
  /** Transient position-action feedback (submitted, failures). */
  positionsMessage?: string;
  actionBar: MarketDetailActionBarVM;
  /** Sheet content opened by the action bar (moved order form until C lands). */
  actionSheet?: ReactNode;
}

export const MARKET_DETAIL_RANGES = ['1H', '4H', '1D', '1W'] as const;
