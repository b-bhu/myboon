/**
 * useWalletSetup — the sheet's wallet creation and activation actions.
 *
 * Moved out of ConnectionSheet.tsx (#737). Signing in with Privy and waiting
 * for (or creating) its wallet is one try; activating the chain finishes it
 * and only then reports connected. A failed setup retries the wallet alone
 * (#316) — a bad OTP code never lands here.
 *
 * Model: docs/modules/wallet/specs/wallet_connectivity.md ("The connection modal")
 */

import { useCallback, type Dispatch, type SetStateAction } from 'react';
import * as Haptics from 'expo-haptics';
import { classifyWalletSetupError, isUserCancelled, type ConnectFlowEvent, type LinkedKind } from '@/features/wallet/components/connect.flow';
import type { Chain } from '@/features/chain/chain.contract';
import type { ChainActivation } from '@/features/chain/activation';
import type { usePrivyEvmWallet } from '@/features/chain/usePrivyEvmWallet';
import type { PrivyWalletState } from '@/hooks/usePrivyWallet';
import type { useWallet } from '@/hooks/useWallet';

export function useWalletSetup({
  chain,
  dispatch,
  privy,
  evm,
  activate,
  onClose,
  onConnected,
  solana,
  busy,
  setBusy,
  setActionError,
}: {
  chain: Chain;
  dispatch: (event: ConnectFlowEvent) => void;
  privy: PrivyWalletState;
  evm: ReturnType<typeof usePrivyEvmWallet>;
  activate: ChainActivation['activate'];
  onClose: () => void;
  onConnected: (() => void) | undefined;
  solana: ReturnType<typeof useWallet>;
  busy: boolean;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setActionError: Dispatch<SetStateAction<string | null>>;
}) {
  const finishActivated = useCallback((kind: LinkedKind) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    onConnected?.();
    dispatch({ type: 'wallet_setup_succeeded', linked: kind });
    onClose();
  }, [dispatch, onClose, onConnected]);

  /**
   * Wallet step only. The caller has already signed in. A throw here is a
   * setup failure, never an "Invalid code".
   */
  const runWalletSetup = useCallback(async () => {
    if (chain === 'solana') await privy.waitForWallet();
    else if (!evm.isProvisioned) await evm.provision();
    await activate(chain);
    finishActivated('privy');
  }, [activate, chain, evm, finishActivated, privy]);

  const handleExternalWallet = useCallback(async () => {
    // Mobile Wallet Adapter (external_mwa). The system chooser picks the wallet.
    // connectExternal is that call. This path does not sign in or create a wallet.
    if (busy || chain !== 'solana') return;
    setActionError(null);
    dispatch({ type: 'choose_external' });
    setBusy(true);
    try {
      await solana.connectExternal();
      await activate('solana');
      finishActivated('external');
    } catch (error: unknown) {
      if (isUserCancelled(error)) {
        dispatch({ type: 'external_cancelled' });
      } else {
        const message = error instanceof Error && error.message
          ? error.message
          : 'Could not connect that wallet.';
        dispatch({ type: 'external_failed', message });
      }
    } finally {
      setBusy(false);
    }
  }, [activate, busy, chain, dispatch, finishActivated, setActionError, setBusy, solana]);

  const handleRetryWallet = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    dispatch({ type: 'retry_wallet' });
    try {
      await runWalletSetup();
    } catch (error: unknown) {
      dispatch({ type: 'wallet_setup_failed', failure: classifyWalletSetupError(error) });
    } finally {
      setBusy(false);
    }
  }, [busy, dispatch, runWalletSetup, setActionError, setBusy]);

  return { runWalletSetup, handleExternalWallet, handleRetryWallet };
}
