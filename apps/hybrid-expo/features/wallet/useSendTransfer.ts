/**
 * Send slider state machine — issue #825.
 *
 * Runs the #824 transfer when the person swipes, and again with the same
 * inputs when they retry after a failure. Nothing is signed before a swipe:
 * `send` is only called by the slider. Also plans the recipient's USDC account
 * rent so the panel can show it before the swipe.
 */

import { Connection, type Transaction } from '@solana/web3.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SOLANA_RPC, SOLANA_RPC_WS } from '@/features/perps/pacific.config';
import { useWallet } from '@/hooks/useWallet';
import { notifyWalletDataChanged } from '@/features/wallet/wallet.refresh';
import { planSendUsdc, sendUsdcOnSolana } from '@/features/wallet/send-transfer';
import type { SendStage } from '@/features/wallet/send-panel.state';

export interface SendTransferInputs {
  fromAddress: string | null;
  /** Null until the address is valid. */
  toAddress: string | null;
  /** Null until the amount is a positive number. */
  amountAtomic: string | null;
  balanceAtomic: string | null;
}

export function useSendTransfer({ fromAddress, toAddress, amountAtomic, balanceAtomic }: SendTransferInputs) {
  const wallet = useWallet();
  const connection = useMemo(
    () => wallet.connection ?? new Connection(SOLANA_RPC, { commitment: 'confirmed', wsEndpoint: SOLANA_RPC_WS }),
    [wallet.connection],
  );
  const [stage, setStage] = useState<SendStage>('idle');
  const [tookSeconds, setTookSeconds] = useState(1);
  const [rentLamports, setRentLamports] = useState<number | null>(null);
  const runningRef = useRef(false);

  // The rent line shows before the swipe, so it is planned as inputs change.
  useEffect(() => {
    setRentLamports(null);
    if (!fromAddress || !toAddress || !amountAtomic) return;
    let cancelled = false;
    planSendUsdc({
      fromAddress,
      toAddress,
      amountAtomic,
      balanceAtomic: balanceAtomic ?? amountAtomic,
      connection,
    })
      .then((plan) => {
        if (!cancelled) setRentLamports(plan.needsRecipientAccount ? plan.rentLamports : null);
      })
      .catch(() => {
        if (!cancelled) setRentLamports(null);
      });
    return () => {
      cancelled = true;
    };
  }, [amountAtomic, balanceAtomic, connection, fromAddress, toAddress]);

  // Typing again after a result starts a fresh send.
  useEffect(() => {
    if (!runningRef.current) setStage('idle');
  }, [amountAtomic, toAddress]);

  const signTransaction = wallet.signTransaction as
    | ((transaction: Transaction) => Promise<Transaction>)
    | null;

  const send = useCallback(async () => {
    if (runningRef.current || !fromAddress || !toAddress || !amountAtomic || balanceAtomic === null || !signTransaction) {
      return;
    }
    runningRef.current = true;
    setStage('pending');
    const startedAt = Date.now();
    try {
      const result = await sendUsdcOnSolana({
        fromAddress,
        toAddress,
        amountAtomic,
        balanceAtomic,
        connection,
        signTransaction,
      });
      if (result.status === 'confirmed') {
        setTookSeconds(Math.max(1, Math.round((Date.now() - startedAt) / 1000)));
        setStage('done');
        notifyWalletDataChanged();
      } else if (result.status === 'cancelled') {
        // The person turned the signature down: nothing was sent, back to the swipe.
        setStage('idle');
      } else {
        setStage('failed');
      }
    } catch {
      setStage('failed');
    } finally {
      runningRef.current = false;
    }
  }, [amountAtomic, balanceAtomic, connection, fromAddress, signTransaction, toAddress]);

  return { stage, send, tookSeconds, rentLamports, canSign: signTransaction !== null };
}
