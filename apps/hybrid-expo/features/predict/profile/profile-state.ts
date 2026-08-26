import type { ChainSignerStatus } from '@/features/chain/chain.resolution';

export type PredictProfileAccountState =
  | 'preparing'
  | 'signed_out'
  | 'wallet_setup'
  | 'predict_setup'
  | 'ready'
  | 'session_expired'
  | 'unsupported';

export interface PredictProfileAccountInput {
  signerStatus: ChainSignerStatus;
  isPrivyUser: boolean;
  hasSigner: boolean;
  predictReady: boolean;
  predictLoading: boolean;
  sessionExpired: boolean;
}

/**
 * The profile has two independent boundaries: identity/EVM signing and the
 * Polymarket CLOB session. Keeping this decision pure prevents a connected
 * wallet from being mislabeled as signed out, and keeps setup/reconnect copy
 * stable while the hooks hydrate.
 */
export function getPredictProfileAccountState(
  input: PredictProfileAccountInput,
): PredictProfileAccountState {
  if (input.signerStatus === 'unsupported') return 'unsupported';
  if (input.predictReady && input.sessionExpired) return 'session_expired';
  if (input.predictReady) return 'ready';
  if (input.signerStatus === 'preparing' || input.predictLoading) return 'preparing';
  if (input.hasSigner) return 'predict_setup';
  if (input.isPrivyUser) return 'wallet_setup';
  return 'signed_out';
}

export function getPredictProfileSetupCopy(state: PredictProfileAccountState): {
  title: string;
  description: string;
  action: string | null;
} {
  switch (state) {
    case 'signed_out':
      return {
        title: 'Connect to Predict',
        description: 'Sign in to create your Predict wallet and keep positions with your account.',
        action: 'Connect wallet',
      };
    case 'wallet_setup':
      return {
        title: 'Set up your Predict wallet',
        description: 'Your MyBoon account is ready. Create and activate its Polygon wallet to continue.',
        action: 'Set up wallet',
      };
    case 'predict_setup':
      return {
        title: 'Finish Predict setup',
        description: 'One signature prepares trading and connects this wallet to Polymarket.',
        action: 'Set up Polymarket',
      };
    case 'session_expired':
      return {
        title: 'Predict needs to reconnect',
        description: 'Your positions are unchanged. Reconnect the trading session to refresh balances and take action.',
        action: 'Reconnect',
      };
    case 'unsupported':
      return {
        title: 'Predict is unavailable',
        description: 'This wallet cannot provide the Polygon signing capabilities Predict needs.',
        action: null,
      };
    case 'preparing':
      return {
        title: 'Preparing Predict',
        description: 'Checking your account and wallet setup.',
        action: null,
      };
    case 'ready':
      return { title: '', description: '', action: null };
  }
}
