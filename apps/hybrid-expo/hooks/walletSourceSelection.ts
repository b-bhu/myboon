export type NativeSolanaSelection = 'mwa' | 'privy' | 'none';

/** Pure signer-selection policy for the native Solana adapter. */
export function selectNativeSolanaSource({
  hasExternalAccount,
  privyAuthenticated,
  privyPreparing,
  activationHydrated,
  privySolanaActive,
  privyConnected,
}: {
  hasExternalAccount: boolean;
  privyAuthenticated: boolean;
  privyPreparing: boolean;
  activationHydrated: boolean;
  privySolanaActive: boolean;
  privyConnected: boolean;
}): NativeSolanaSelection {
  if (hasExternalAccount && !privyPreparing) return 'mwa';
  if (
    privyAuthenticated
    && activationHydrated
    && privySolanaActive
    && privyConnected
  ) {
    return 'privy';
  }
  return 'none';
}
