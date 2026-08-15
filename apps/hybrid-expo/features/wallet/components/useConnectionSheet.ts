/**
 * Requirement-scoped adapter over the one app-wide wallet sheet.
 *
 * This hook owns no visibility or chain state and renders nothing. A screen
 * declares its chain and venue once, then awaits a one-shot outcome.
 */

import { useCallback } from 'react';

import type { Chain } from '@/features/chain/chain.contract';
import { useWalletSheet } from '@/features/wallet/WalletSheetProvider';
import type { WalletSheetOutcome } from '@/features/wallet/components/walletSheet.presentation';

export interface ConnectionSheetRequirement {
  chain: Chain;
  applicationLabel: string;
}

export interface ConnectionSheetController {
  open: () => Promise<WalletSheetOutcome>;
}

export function useConnectionSheet(
  requirement: ConnectionSheetRequirement,
): ConnectionSheetController {
  const { openForRequirement } = useWalletSheet();
  const { chain, applicationLabel } = requirement;
  const open = useCallback(
    () => openForRequirement({ chain, applicationLabel }),
    [applicationLabel, chain, openForRequirement],
  );
  return { open };
}
