/**
 * Venue-generic market list contract.
 *
 * Generalizes `features/perps/perps.contract.ts` beyond perps so that
 * registering a new venue (Orca, a fourth perps venue, whatever) means
 * writing an adapter object, not a new 400-line screen. See
 * docs/modules/wallet/PRDs/2026_08_11_token_identity_and_venue_adapters_PRD.md.
 *
 * PURE — no react-native imports, so this stays `tsx --test`-able.
 *
 * This is a pragmatic adaptation of the PRD's sketch, not a verbatim copy:
 * - `lead` is a descriptor (`MarketLead`), not a `ReactNode` — keeps
 *   `toRow` a pure function callers can unit test without rendering.
 * - `identities` is a `ReadonlyMap<string, TokenIdentity>` keyed by the ref
 *   `toRow` echoes back, not an array — O(1) lookup per row.
 * - `href` replaces an `onPress` closure — the row model stays data, and
 *   the UI layer decides how navigation actually happens.
 */

import type { TokenIdentity } from '@/lib/token-identity';

export type CellTone = 'neutral' | 'dim' | 'pos' | 'neg';

export interface Cell {
  text: string;
  tone?: CellTone;
  width: number;
}

export interface ColumnSpec {
  key: string;
  label: string;
  width: number;
  active?: boolean;
}

/** One leg of a token pair lead (Meteora's `SOL / USDC` rows). */
export interface MarketLeadToken {
  identityRef: string;
  /**
   * Resolved identity icon (origin-relative, e.g. `/tokens/icon/mint/<mint>`).
   * The mapper fills this from the identity map it is already given, so the
   * shell does not need to look identities up a second time to render a row.
   */
  identityIconUrl?: string | null;
  venueIconUrl: string | null;
  letter: string;
  tint?: string;
}

/** Describes the leading icon/avatar of a row — a single token, or a pair. */
export type MarketLead =
  | {
      kind: 'token';
      identityRef: string;
      /** Resolved identity icon (origin-relative). Preferred over venueIconUrl. */
      identityIconUrl?: string | null;
      venueIconUrl: string | null;
      letter: string;
    }
  | { kind: 'pair'; x: MarketLeadToken; y: MarketLeadToken };

export interface MarketListRow {
  key: string;
  lead: MarketLead;
  title: string;
  titleSuffix?: string;
  subtitle?: string;
  cells: [Cell, Cell, Cell];
  href: string;
  /** Required — cannot be skipped. Acceptance criterion 5. */
  a11yLabel: string;
}

export interface MarketListTheme {
  screen: string;
  surface: string;
  surfaceLift: string;
  border: string;
  rowDivider: string;
  rowPressed: string;
  text: string;
  textDim: string;
  textFaint: string;
  accent: string;
  pos: string;
  neg: string;
}

export interface MarketQuery {
  page?: number;
  pageSize?: number;
  query?: string;
  sortBy?: string;
}

export interface MarketPage<T = unknown> {
  items: readonly T[];
  hasNext: boolean;
  page: number;
}

export interface VenueCapabilities {
  pagination: boolean;
  remoteSearch: boolean;
  filters: boolean;
}

export interface VenueAdapter<TMarket = unknown> {
  venueId: 'pacifica' | 'phoenix' | 'meteora' | 'orca';
  displayName: string;
  kind: 'perps' | 'lp' | 'spot';
  routeBase: string;
  theme?: MarketListTheme;
  capabilities: VenueCapabilities;

  listMarkets(query: MarketQuery): Promise<MarketPage<TMarket>>;
  identityRefs(markets: readonly TMarket[]): string[];
  toRow(market: TMarket, identities: ReadonlyMap<string, TokenIdentity>): MarketListRow;
  sortRows?(rows: MarketListRow[], markets: readonly TMarket[]): MarketListRow[];
  matchesQuery?(market: TMarket, query: string): boolean;

  search: { mode: 'local' | 'remote'; placeholder: string };
  columns: [ColumnSpec, ColumnSpec, ColumnSpec];
}
