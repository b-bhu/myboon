/**
 * App-wide wallet manager and requirement resolver.
 *
 * Exactly one ConnectionSheet is mounted here. Screens describe why they need
 * it; they never own visibility or render another sheet instance.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useChainActivation } from '@/features/chain/activation';
import type { Chain } from '@/features/chain/chain.contract';
import { useActivationReconciler } from '@/features/chain/useActivationReconciler';
import { usePrivyEvmWallet } from '@/features/chain/usePrivyEvmWallet';
import { ConnectionSheet } from '@/features/wallet/components/ConnectionSheet';
import {
  createWalletSheetRequest,
  deriveWalletTrigger,
  isRequirementSatisfied,
  type WalletSessionSnapshot,
  type WalletSheetIntent,
  type WalletSheetOutcome,
  type WalletSheetRequest,
} from '@/features/wallet/components/walletSheet.presentation';
import { useWallet } from '@/hooks/useWallet';

interface RequirementInput {
  chain: Chain;
  applicationLabel: string;
}

interface WalletSheetContextValue {
  isOpen: boolean;
  intent: WalletSheetIntent;
  openManager: () => void;
  openForRequirement: (input: RequirementInput) => Promise<WalletSheetOutcome>;
  close: () => void;
  trigger: ReturnType<typeof deriveWalletTrigger>;
}

const DEFAULT_INTENT: WalletSheetIntent = { kind: 'manage' };

const WalletSheetContext = createContext<WalletSheetContextValue>({
  isOpen: false,
  intent: DEFAULT_INTENT,
  openManager: () => {},
  openForRequirement: async () => 'cancelled',
  close: () => {},
  trigger: { label: 'Wallets', accessibilityLabel: 'Manage wallets', activeCount: 0 },
});

export function useWalletSheet() {
  return useContext(WalletSheetContext);
}

interface PendingRequirement {
  request: WalletSheetRequest;
  failure: Error | null;
}

export function WalletSheetProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [intent, setIntent] = useState<WalletSheetIntent>(DEFAULT_INTENT);
  const pendingRef = useRef<PendingRequirement | null>(null);

  // Mounted once, app-wide: a live connection becomes an activation record.
  useActivationReconciler();
  const solana = useWallet();
  const evm = usePrivyEvmWallet();
  const { activation, isHydrated } = useChainActivation();

  const session = useMemo<WalletSessionSnapshot>(() => ({
    activationHydrated: isHydrated,
    privyAuthenticated: evm.isPrivyUser,
    accounts: [
      {
        chain: 'solana',
        address: solana.connected ? solana.address : null,
        active: activation.solana,
        usable: solana.connected && !!solana.address && !!solana.signMessage,
        source: solana.source === 'mwa' ? 'external_wallet' : 'myboon_wallet',
      },
      {
        chain: 'evm',
        address: evm.address,
        active: activation.evm,
        usable: evm.isProvisioned && !!evm.address && !!evm.request && !evm.needsRecovery,
        source: 'myboon_wallet',
      },
    ],
    recoveryChains: [
      ...(solana.needsRecovery ? ['solana' as const] : []),
      ...(evm.needsRecovery ? ['evm' as const] : []),
    ],
  }), [
    activation.evm,
    activation.solana,
    evm.address,
    evm.isPrivyUser,
    evm.isProvisioned,
    evm.needsRecovery,
    evm.request,
    isHydrated,
    solana.needsRecovery,
    solana.address,
    solana.connected,
    solana.signMessage,
    solana.source,
  ]);

  const cancelPending = useCallback(() => {
    pendingRef.current?.request.cancel();
    pendingRef.current = null;
  }, []);

  const openManager = useCallback(() => {
    cancelPending();
    setIntent({ kind: 'manage' });
    setIsOpen(true);
  }, [cancelPending]);

  const openForRequirement = useCallback((input: RequirementInput) => {
    if (isRequirementSatisfied(session, input.chain)) {
      return Promise.resolve<WalletSheetOutcome>('satisfied');
    }

    cancelPending();
    const request = createWalletSheetRequest();
    pendingRef.current = { request, failure: null };
    setIntent({
      kind: 'requirement',
      chain: input.chain,
      applicationLabel: input.applicationLabel,
    });
    setIsOpen(true);
    return request.promise;
  }, [cancelPending, session]);

  const close = useCallback(() => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    setIsOpen(false);
    if (!pending) return;
    if (pending.failure) pending.request.fail(pending.failure);
    else pending.request.cancel();
  }, []);

  const recordTechnicalFailure = useCallback((error: Error) => {
    if (pendingRef.current) pendingRef.current.failure = error;
  }, []);

  const clearTechnicalFailure = useCallback(() => {
    if (pendingRef.current) pendingRef.current.failure = null;
  }, []);

  // A successful auth/create call is not enough. Resolve only after activation
  // is persisted and the live hook exposes a signer-capable wallet.
  useEffect(() => {
    if (
      !isOpen
      || intent.kind !== 'requirement'
      || !pendingRef.current
      || !isRequirementSatisfied(session, intent.chain)
    ) {
      return;
    }

    // Keep the in-sheet ready state visible briefly so creation does not look
    // like the modal simply vanished.
    const timer = setTimeout(() => {
      const pending = pendingRef.current;
      pendingRef.current = null;
      pending?.request.satisfy();
      setIsOpen(false);
    }, 450);
    return () => clearTimeout(timer);
  }, [intent, isOpen, session]);

  useEffect(() => () => cancelPending(), [cancelPending]);

  const trigger = useMemo(() => deriveWalletTrigger(session), [session]);
  const value = useMemo<WalletSheetContextValue>(() => ({
    isOpen,
    intent,
    openManager,
    openForRequirement,
    close,
    trigger,
  }), [close, intent, isOpen, openForRequirement, openManager, trigger]);

  return (
    <WalletSheetContext.Provider value={value}>
      {children}
      <ConnectionSheet
        visible={isOpen}
        intent={intent}
        onClose={close}
        onTechnicalFailure={recordTechnicalFailure}
        onRetry={clearTechnicalFailure}
      />
    </WalletSheetContext.Provider>
  );
}
