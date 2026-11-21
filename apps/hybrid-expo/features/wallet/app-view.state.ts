/**
 * Wallet app-view state — the selectedApp state and its pure reducer
 * (issue #771).
 *
 * Tapping an app opens that app inside the Wallet: the app view sits over
 * the Portfolio, and `back` returns to the Portfolio list. The selection is
 * generic by app id ('polymarket', 'phoenix', 'pacifica', 'meteora', 'spot';
 * the ids are the Wallet's protocol ids) so the other apps plug in later.
 *
 * Changing the wallet resets the selection: the app view belongs to the
 * wallet it was opened from, so another wallet (or a disconnect) must not
 * inherit it.
 *
 * Nothing on the Wallet surface dispatches `select` yet — the shell mounts
 * but nothing changes on screen until a later issue wires the taps.
 */

/** A wallet the selection can belong to (addresses joined, or null). */
export type WalletAppViewWalletId = string | null;

export type WalletAppViewState = {
  /** Wallet the last `wallet-change` reported; the reset rule's comparison. */
  walletId: WalletAppViewWalletId;
  /** App id open in the app view; `null` = none (the Portfolio is on top). */
  selectedApp: string | null;
};

export type WalletAppViewAction =
  | { type: 'select'; app: string }
  | { type: 'back' }
  | { type: 'wallet-change'; walletId: string | null };

export const initialWalletAppView: WalletAppViewState = {
  walletId: null,
  selectedApp: null,
};

export function walletAppViewReducer(
  state: WalletAppViewState,
  action: WalletAppViewAction,
): WalletAppViewState {
  switch (action.type) {
    case 'select':
      // Re-selecting swaps the open app straight away; back is only for
      // leaving the app view.
      return { ...state, selectedApp: action.app };
    case 'back':
      return { ...state, selectedApp: null };
    case 'wallet-change':
      // A different wallet, or none, clears the selection. Re-syncing the
      // same wallet must not — return the same state so useReducer bails
      // out and a repeated sync never loops.
      if (action.walletId === state.walletId) return state;
      return { walletId: action.walletId, selectedApp: null };
  }
}
