/**
 * usePhoenixSigner — the wallet signer wrapped for `sendPhoenixBuiltTransaction`
 * (issues #850 and #851). Same wrapper as `phoenixSignAndSendTransaction` in
 * the old profile screen (phoenix.portfolio.tsx): null when the wallet cannot
 * send; otherwise it returns the signature string.
 */

import { useMemo } from 'react';

import { useWallet } from '@/hooks/useWallet';
import type { PhoenixSignAndSendTransactionFn } from '@/features/perps/phoenix.execution';

export function usePhoenixSigner() {
  const wallet = useWallet();
  const signAndSend = useMemo<PhoenixSignAndSendTransactionFn | null>(() => {
    if (typeof wallet.signAndSendTransaction !== 'function') return null;
    return async (transaction) => {
      const result = await (wallet.signAndSendTransaction as (tx: unknown) => Promise<unknown>)(transaction);
      if (typeof result === 'string') return result;
      if (result !== null && typeof result === 'object') {
        const signature = (result as { signature?: unknown }).signature;
        if (typeof signature === 'string') return signature;
      }
      throw new Error('Phoenix wallet did not return a transaction signature');
    };
  }, [wallet.signAndSendTransaction]);
  return { address: wallet.address, connection: wallet.connection, signAndSend };
}
