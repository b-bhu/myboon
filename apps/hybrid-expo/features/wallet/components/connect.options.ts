/**
 * connect.options — which connection options a chain offers.
 *
 * Kept apart from `ConnectionSheet.tsx` so the rule is testable without loading
 * React Native, and so the answer to "why is there no wallet row on EVM?" lives
 * in one readable place.
 *
 * The list is *derived* from `CHAIN_BACKENDS`, which already encodes that Mobile
 * Wallet Adapter is Solana-only by specification. Adding an external EVM
 * transport later means changing the capability table and `BACKEND_OPTIONS` —
 * not the sheet.
 *
 * Model: docs/modules/wallet/specs/wallet_connectivity.md ("The connection modal")
 */

import { CHAIN_BACKENDS, type Chain, type WalletBackend } from '@/features/chain/chain.contract';

/**
 * A row the user can tap. `email` and `passkey` are two auth methods that both
 * land on the same Privy embedded wallet — which is why Privy is two rows, not
 * one.
 */
export type ConnectOption = 'external_wallet' | 'email' | 'passkey';

/** Which options each backend contributes. */
export const BACKEND_OPTIONS: Record<WalletBackend, readonly ConnectOption[]> = {
  privy_embedded: ['email', 'passkey'],
  external_mwa: ['external_wallet'],
};

/** Stable display order, independent of backend resolution preference. */
const OPTION_ORDER: readonly ConnectOption[] = ['email', 'passkey', 'external_wallet'];

/**
 * Options offered for a chain.
 *
 * Solana -> email + passkey + external wallet. EVM -> email + passkey, because
 * `CHAIN_BACKENDS.evm` contains no `external_mwa`. The EVM case drops the wallet
 * row and nothing else.
 */
export function availableOptions(chain: Chain): readonly ConnectOption[] {
  const offered = new Set<ConnectOption>();
  for (const backend of CHAIN_BACKENDS[chain]) {
    for (const option of BACKEND_OPTIONS[backend]) offered.add(option);
  }
  return OPTION_ORDER.filter((option) => offered.has(option));
}
