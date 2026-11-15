/**
 * Per-venue portfolio drill-down contract — the data side of the scoped view
 * issued in #657 (D2). Three fixed tabs everywhere: Positions · Orders ·
 * History. Venues supply rows and actions, not layout (design reference:
 * docs/mockups/design-language/market-experience, profile screen).
 *
 * The row shape is identical across venues; only the wording is venue-specific
 * (Phoenix shows size and leverage, Polymarket shares and chance). Each row
 * carries a per-adapter "venue actions" slot (actionLabel + onActionPress):
 * Phoenix TP/SL, Polymarket redeem/cash-out, Meteora rebalance. These do not
 * generalize and are NOT forced into shared vocabulary.
 *
 * PURE — no react, no react-native, so this stays `tsx --test`-able. React-side
 * extras (custom section nodes) live on the screen component's extended type.
 */

/** The three tabs, in their fixed display order. Every venue fills all three. */
export type PortfolioTabKey = 'positions' | 'orders' | 'history';

export const PORTFOLIO_TAB_KEYS: readonly PortfolioTabKey[] = [
  'positions',
  'orders',
  'history',
];

export type PortfolioRowTone = 'pos' | 'neg' | 'neutral' | 'accent';

export interface VenuePortfolioRow {
  key: string;
  /** Left lead, venue-worded: 'Long · 1.8 SOL', '40 shares · NO'. */
  title: string;
  /** Optional colored inline accent inside the title (side, outcome). */
  titleAccent?: string;
  /** Optional second line: 'Entry $138.20 · 2× leverage', 'Avg 61¢ · paid $24.40'. */
  subtitle?: string;
  /** Right headline value, mono. */
  value: string;
  valueTone?: PortfolioRowTone;
  /** Right second line: '+8.3%'-style change. */
  subValue?: string;
  subValueTone?: PortfolioRowTone;
  /**
   * The venue-actions slot on the row — one adapter-defined action
   * ('TP/SL', 'Cash out', 'Redeem', 'Rebalance', 'Cancel'…). Rendered in gold
   * on the right; the shell never interprets it.
   */
  actionLabel?: string;
  onActionPress?: () => void;
  /** Tapping the row itself — the venue's pre-filled close/manage flow. */
  onPress?: () => void;
  /** True while the row's action is in flight (e.g. an order cancel). */
  actionPending?: boolean;
  /** Greys the action slot out without removing it. */
  actionDisabled?: boolean;
}

export interface VenuePortfolioSection {
  key: string;
  /** Section caption, e.g. 'Open positions', 'When this resolves'. */
  label?: string;
  rows: readonly VenuePortfolioRow[];
}

export type PortfolioTabStatus = 'idle' | 'loading' | 'ready' | 'failed';

/** Data one tab renders. `error` surfaces only on 'failed'. */
export interface PortfolioTabData {
  status: PortfolioTabStatus;
  error?: string | null;
  sections: readonly VenuePortfolioSection[];
}

/** Total rows in a tab across all its sections. */
export function countPortfolioRows(tab: PortfolioTabData): number {
  return tab.sections.reduce((sum, section) => sum + section.rows.length, 0);
}

/**
 * A ready tab with no rows anywhere shows the shared empty state — a venue
 * with no orders shows an empty state, not a different tab set (#657).
 */
export function isPortfolioTabEmpty(tab: PortfolioTabData): boolean {
  return tab.status === 'ready' && countPortfolioRows(tab) === 0;
}

/** Fallback empty-state copy per tab; venues may override per tab. */
export function portfolioEmptyCopy(tab: PortfolioTabKey): { title: string; message: string } {
  switch (tab) {
    case 'positions':
      return {
        title: 'No open positions',
        message: 'Positions you open at this venue appear here.',
      };
    case 'orders':
      return {
        title: 'No open orders',
        message: 'Limit orders you place will appear here until they fill.',
      };
    case 'history':
      return {
        title: 'No history yet',
        message: 'Filled trades and transfers will appear here.',
      };
  }
}
