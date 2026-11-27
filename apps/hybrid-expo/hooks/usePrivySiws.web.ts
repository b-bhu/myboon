/**
 * usePrivySiws — web stub. new (#948).
 *
 * SIWS is the phone-side external-wallet path (#948, Decision D57). On web the
 * connection sheet's external action stays the wallet-adapter connect it was
 * on main: no Privy sign-in, no link, no embedded wallet — the pre-SIWS web
 * behaviour is unchanged. The native variant owns the real flow.
 */

import type { PrivySiwsState } from './usePrivySiws.native';

export function usePrivySiws(): PrivySiwsState {
  return { authenticate: null };
}
