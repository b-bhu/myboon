import React from 'react';
import { PrivyProvider as BasePrivyProvider } from '@privy-io/expo';

const PRIVY_APP_ID = process.env.EXPO_PUBLIC_PRIVY_APP_ID ?? 'cmofdpvdb00h40cl7qftz9343';
const PRIVY_CLIENT_ID = process.env.EXPO_PUBLIC_PRIVY_CLIENT_ID ?? '';

export function PrivyProvider({ children }: { children: React.ReactNode }) {
  return (
    <BasePrivyProvider
      appId={PRIVY_APP_ID}
      clientId={PRIVY_CLIENT_ID || undefined}
      config={{
        embedded: {
          // Both chains are 'off' deliberately. Provisioning happens on
          // activation via the embedded wallet hooks' `create()`, never at
          // login — see docs/modules/wallet/specs/wallet_connectivity.md
          // ("Dormancy"). A dormant chain must have no wallet in existence, so
          // it has no address that can receive funds by accident. Eager
          // creation is precisely what dormancy exists to prevent.
          solana: {
            createOnLogin: 'off',
          },
          ethereum: {
            createOnLogin: 'off',
          },
        },
      }}
    >
      {children}
    </BasePrivyProvider>
  );
}
