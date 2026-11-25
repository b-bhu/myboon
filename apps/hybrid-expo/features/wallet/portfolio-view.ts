/**
 * Portfolio view choice, remembered on the phone (issue #840).
 *
 * The Portfolio header offers Table | Map | Cards (wallet.html at 02b98eba,
 * frame "Portfolio · Map", the ".vs" icon segmented switch; the frame also
 * pins the contract in PROTO_NOTES: "choice is remembered", data "local
 * preference"). Cards joined the views in #842 and Map in #871; a stored
 * value for a view that is not enabled falls back to Table, so the switch
 * never reopens with a disabled segment selected.
 *
 * AsyncStorage is the app's durable client store (like
 * features/chain/activation.ts). Read and write failures are swallowed by
 * design (#840): a failed read means Table, a failed write means the choice
 * holds for this session only — neither may surface as an error in the UI.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export type PortfolioView = 'table' | 'map' | 'cards';

export const DEFAULT_PORTFOLIO_VIEW: PortfolioView = 'table';

export const PORTFOLIO_VIEW_STORAGE_KEY = 'wallet.portfolio.view';

/**
 * Views with a body to render. `selectView` writes only these and
 * `parsePortfolioView` honours only these as stored values, so a stored
 * unknown value (or one for a view disabled again someday) falls back to
 * the default and never opens a segment that cannot render.
 */
export const ENABLED_PORTFOLIO_VIEWS: readonly PortfolioView[] = ['table', 'map', 'cards'];

/**
 * Stored or raw values never select a view that cannot render: only values
 * in `ENABLED_PORTFOLIO_VIEWS` pass; anything else — unknown, disabled, or
 * no value at all — is the default.
 */
export function parsePortfolioView(raw: string | null): PortfolioView {
  return raw !== null && (ENABLED_PORTFOLIO_VIEWS as readonly string[]).includes(raw)
    ? (raw as PortfolioView)
    : DEFAULT_PORTFOLIO_VIEW;
}

export async function readPortfolioView(): Promise<PortfolioView> {
  try {
    return parsePortfolioView(await AsyncStorage.getItem(PORTFOLIO_VIEW_STORAGE_KEY));
  } catch {
    // A failed read is Table (#840); the switch must never error the screen.
    return DEFAULT_PORTFOLIO_VIEW;
  }
}

export async function writePortfolioView(view: PortfolioView): Promise<void> {
  try {
    await AsyncStorage.setItem(PORTFOLIO_VIEW_STORAGE_KEY, view);
  } catch {
    // A failed write is ignored (#840): the session keeps its choice and the
    // next open falls back to the default or the last stored value.
  }
}
