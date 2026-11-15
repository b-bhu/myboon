import type { ChainSignerStatus } from '@/features/chain/chain.resolution';

export type PolymarketProfileAccountState =
  | 'preparing'
  | 'signed_out'
  | 'wallet_setup'
  | 'polymarket_setup'
  | 'ready'
  | 'session_expired'
  | 'unsupported';

export interface PolymarketProfileAccountInput {
  signerStatus: ChainSignerStatus;
  isPrivyUser: boolean;
  hasSigner: boolean;
  polymarketReady: boolean;
  polymarketLoading: boolean;
  sessionExpired: boolean;
}

/**
 * The profile has two independent boundaries: identity/EVM signing and the
 * Polymarket CLOB session. Keeping this decision pure prevents a connected
 * wallet from being mislabeled as signed out, and keeps setup/reconnect copy
 * stable while the hooks hydrate.
 */
export function getPolymarketProfileAccountState(
  input: PolymarketProfileAccountInput,
): PolymarketProfileAccountState {
  if (input.signerStatus === 'unsupported') return 'unsupported';
  if (input.polymarketReady && input.sessionExpired) return 'session_expired';
  if (input.polymarketReady) return 'ready';
  if (input.signerStatus === 'preparing' || input.polymarketLoading) return 'preparing';
  if (input.hasSigner) return 'polymarket_setup';
  if (input.isPrivyUser) return 'wallet_setup';
  return 'signed_out';
}

export function getPolymarketProfileSetupCopy(state: PolymarketProfileAccountState): {
  title: string;
  description: string;
  action: string | null;
} {
  switch (state) {
    case 'signed_out':
      return {
        title: 'Connect to Polymarket',
        description: 'Sign in to create your Polymarket wallet and keep positions with your account.',
        action: 'Connect wallet',
      };
    case 'wallet_setup':
      return {
        title: 'Set up your Polymarket wallet',
        description: 'Your MyBoon account is ready. Create and activate its Polygon wallet to continue.',
        action: 'Set up wallet',
      };
    case 'polymarket_setup':
      return {
        title: 'Finish Polymarket setup',
        description: 'One signature prepares trading and connects this wallet to Polymarket.',
        action: 'Set up Polymarket',
      };
    case 'session_expired':
      return {
        title: 'Polymarket needs to reconnect',
        description: 'Your positions are unchanged. Reconnect the trading session to refresh balances and take action.',
        action: 'Reconnect',
      };
    case 'unsupported':
      return {
        title: 'Polymarket is unavailable',
        description: 'This wallet cannot provide the Polygon signing capabilities Polymarket needs.',
        action: null,
      };
    case 'preparing':
      return {
        title: 'Preparing Polymarket',
        description: 'Checking your account and wallet setup.',
        action: null,
      };
    case 'ready':
      return { title: '', description: '', action: null };
  }
}
