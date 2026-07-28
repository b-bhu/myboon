/**
 * WalletSheetProvider — the app-wide wallet sheet.
 *
 * One sheet, mounted once, openable from anywhere. The avatar in any header
 * opens it; a screen that needs a specific chain opens it for that chain.
 *
 * Replaces the side drawer. The drawer was a second surface reading wallet
 * state, which is how the app ended up showing a connected address in one
 * panel and "connect a wallet" in another. There is now one place wallet
 * connection state is presented.
 *
 * The sheet answers "who am I" — address, connect, disconnect. It does not
 * answer "what do I have": balances, positions, and protocol rows belong to
 * the wallet module and are unaffected by this.
 *
 * Model: docs/modules/wallet/specs/wallet_connectivity.md ("The connection modal")
 */

import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { ConnectionSheet } from '@/features/wallet/components/ConnectionSheet';
import { useActivationReconciler } from '@/features/chain/useActivationReconciler';
import type { Chain } from '@/features/chain/chain.contract';

interface WalletSheetContextValue {
  isOpen: boolean;
  /** Open for a specific chain. Defaults to Solana, the primary chain. */
  open: (chain?: Chain) => void;
  close: () => void;
}

const WalletSheetContext = createContext<WalletSheetContextValue>({
  isOpen: false,
  open: () => {},
  close: () => {},
});

export function useWalletSheet() {
  return useContext(WalletSheetContext);
}

export function WalletSheetProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [chain, setChain] = useState<Chain>('solana');

  // Mounted once, app-wide: a live connection becomes an activation record.
  useActivationReconciler();

  const open = useCallback((next: Chain = 'solana') => {
    setChain(next);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => setIsOpen(false), []);

  const value = useMemo(() => ({ isOpen, open, close }), [isOpen, open, close]);

  return (
    <WalletSheetContext.Provider value={value}>
      {children}
      <ConnectionSheet visible={isOpen} chain={chain} onClose={close} />
    </WalletSheetContext.Provider>
  );
}
