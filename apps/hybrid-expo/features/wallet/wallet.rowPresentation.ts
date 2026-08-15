import type { WalletSourceState } from '@/features/wallet/wallet.types';

/**
 * Visual state for one protocol row in Home's Wallet section.
 *
 * Fetch state and presentation state deliberately differ during a warm
 * refresh: the request is loading, but the last successful value remains the
 * truthful value to display. Only a failed warm refresh is presented as stale.
 */
export interface WalletRowPresentation {
  hasValue: boolean;
  isPending: boolean;
  showColdRetry: boolean;
  showStaleRetry: boolean;
}

export function deriveWalletRowPresentation(
  source: WalletSourceState,
): WalletRowPresentation {
  const hasValue = source.valueUsd !== null && source.resolvedAt !== null;
  const isCold = !hasValue;

  return {
    hasValue,
    isPending:
      isCold &&
      (source.status === 'idle' ||
        source.status === 'loading' ||
        source.status === 'failed'),
    showColdRetry: isCold && source.status === 'failed',
    showStaleRetry: hasValue && source.status === 'stale',
  };
}
