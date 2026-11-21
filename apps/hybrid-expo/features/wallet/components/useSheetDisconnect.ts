/**
 * useSheetDisconnect — log out and disconnect for the connected sheet.
 *
 * Moved out of ConnectionSheet.tsx (#737). Disconnecting clears the OTP
 * session so a reopened sheet starts fresh; an external session disconnects
 * the adapter and deactivates the chain instead of touching Privy.
 *
 * Model: docs/modules/wallet/specs/wallet_connectivity.md ("The connection modal")
 */

import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { emptyOtpSession, type OtpCodeSession } from '@/features/wallet/components/otp-resend';
import { selectMwaDisconnect } from '@/features/wallet/signOut';
import type { Chain } from '@/features/chain/chain.contract';
import type { ChainActivation } from '@/features/chain/activation';
import { type ConnectFlowEvent, type ConnectFlowState } from '@/features/wallet/components/connect.flow';
import type { PrivyWalletState } from '@/hooks/usePrivyWallet';
import type { useWallet } from '@/hooks/useWallet';

export function useSheetDisconnect({
  flow,
  dispatch,
  privy,
  solana,
  chain,
  deactivate,
  onClose,
  busy,
  setBusy,
  setActionError,
  setOtpCode,
  setOtpError,
  setOtpSession,
  setEmailError,
}: {
  flow: ConnectFlowState;
  dispatch: (event: ConnectFlowEvent) => void;
  privy: PrivyWalletState;
  solana: ReturnType<typeof useWallet>;
  chain: Chain;
  deactivate: ChainActivation['deactivate'];
  onClose: () => void;
  busy: boolean;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setActionError: Dispatch<SetStateAction<string | null>>;
  setOtpCode: Dispatch<SetStateAction<string>>;
  setOtpError: Dispatch<SetStateAction<string | null>>;
  setOtpSession: Dispatch<SetStateAction<OtpCodeSession>>;
  setEmailError: Dispatch<SetStateAction<string | null>>;
}) {
  const handleLogout = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await privy.disconnect(selectMwaDisconnect(solana));
      setOtpCode('');
      setOtpError(null);
      setOtpSession(emptyOtpSession());
      setEmailError(null);
      dispatch({ type: 'logout' });
    } catch (error: unknown) {
      setActionError(error instanceof Error && error.message ? error.message : 'Could not log out.');
    } finally {
      setBusy(false);
    }
  }, [busy, dispatch, privy, setActionError, setBusy, setEmailError, setOtpCode, setOtpError, setOtpSession, solana]);

  const confirmDisconnect = useCallback(async () => {
    if (busy || !flow.linked) return;
    setBusy(true);
    setActionError(null);
    try {
      if (flow.linked === 'external') {
        if (solana.disconnect) await solana.disconnect();
        await deactivate('solana');
      } else if (privy.isPrivyUser) {
        await privy.disconnect(selectMwaDisconnect(solana));
      } else if (solana.disconnect) {
        await solana.disconnect();
        await deactivate(chain);
      }
      setOtpCode('');
      setOtpError(null);
      setOtpSession(emptyOtpSession());
      dispatch({ type: 'disconnected' });
      onClose();
    } catch (error: unknown) {
      setActionError(error instanceof Error && error.message ? error.message : 'Could not disconnect.');
    } finally {
      setBusy(false);
    }
  }, [busy, chain, deactivate, dispatch, flow.linked, onClose, privy, setActionError, setBusy, setOtpCode, setOtpError, setOtpSession, solana]);

  return { handleLogout, confirmDisconnect };
}
