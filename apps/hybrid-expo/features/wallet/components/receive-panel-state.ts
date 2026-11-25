/**
 * Receive panel state — pure helper for the Wallet Receive mode (issue #719).
 *
 * The Receive panel renders one of three states per chain toggle:
 * a QR card, a "not set up yet" note, or a connect prompt. Nothing here is
 * signed, so the state derives only from wallet data the Wallet surface
 * already shows.
 *
 * Model: docs/modules/wallet/specs/wallet_connectivity.md ("Dormancy")
 */

import type { Chain } from '@/features/chain/chain.contract';

/** Which receive address the Solana | EVM toggle picks. */
export type ReceiveChain = Chain;

/** The three panel states the issue names. */
export type ReceivePanelStateName =
  // 'connected' — QR card with the address and Copy.
  | 'connected'
  // 'dormant-evm' — EVM chain is on but the embedded wallet does not exist yet.
  | 'dormant-evm'
  // 'not-connected' — nothing to receive on; connect prompt.
  | 'not-connected';

export function receivePanelState({
  chain,
  solanaAddress,
  evmAddress,
  activeChains,
}: {
  chain: ReceiveChain;
  /** `useWallet().address` when connected — null otherwise. */
  solanaAddress: string | null;
  /** `usePrivyEvmWallet().address` — null while the EVM wallet is dormant. */
  evmAddress: string | null;
  /** Chains the user expressed intent for (`activeChains(activation)`). */
  activeChains: readonly Chain[];
}): ReceivePanelStateName {
  const address = chain === 'solana' ? solanaAddress : evmAddress;
  const active = activeChains.includes(chain);
  if (address !== null && active) return 'connected';
  // "Not set up yet" is EVM-specific: its chain activates before the embedded
  // wallet is provisioned, so an active chain may legitimately have no wallet
  // yet. Solana has no equivalent state — an addressless Solana is just not
  // connected (the account body shows its connect box on the same gate).
  if (chain === 'evm' && active) return 'dormant-evm';
  return 'not-connected';
}

/**
 * The two-line strip under the QR card and the Copy button label, one per
 * chain (issue #821; mock wallet.html `recvMid`, `.dstrip`/`.copybtn`).
 * One 0x address serves every EVM chain, so the EVM copy never names a chain.
 */
export function receivePanelCopy(chain: ReceiveChain): {
  strip: [string, string];
  copyLabel: string;
} {
  if (chain === 'solana') {
    return {
      strip: ['Solana address · SOL and SPL tokens', 'Send only Solana tokens to this address'],
      copyLabel: 'Copy Solana address',
    };
  }
  return {
    strip: ['One address for all EVM chains', 'Send only EVM tokens to this address'],
    copyLabel: 'Copy EVM address',
  };
}
