/**
 * useConnectionSheet — open the shared connection sheet from any entry point.
 *
 * Exists so a screen that needs a wallet writes `openConnect('solana')` instead
 * of hand-rolling visible/chain state, and so no call site is tempted back into
 * calling `wallet.connect()` directly (which skips email and passkey entirely).
 *
 * Model: docs/modules/wallet/specs/wallet_connectivity.md ("The connection modal")
 */

import { useCallback, useState } from 'react';
import type { Chain } from '@/features/chain/chain.contract';

export interface ConnectionSheetController {
  visible: boolean;
  /** Chain the sheet is currently offering options for. */
  chain: Chain;
  open: (chain: Chain) => void;
  close: () => void;
}

export function useConnectionSheet(defaultChain: Chain = 'solana'): ConnectionSheetController {
  const [visible, setVisible] = useState(false);
  const [chain, setChain] = useState<Chain>(defaultChain);

  const open = useCallback((next: Chain) => {
    setChain(next);
    setVisible(true);
  }, []);

  const close = useCallback(() => setVisible(false), []);

  return { visible, chain, open, close };
}
