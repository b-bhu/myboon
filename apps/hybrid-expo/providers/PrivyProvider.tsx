import React from 'react';
import { PrivyProvider as BasePrivyProvider } from '@privy-io/expo';

/**
 * Both IDs come from the environment with no fallback.
 *
 * A hardcoded app-id default is not a secret leak — app IDs are public — but it
 * makes a misconfigured build *succeed* against whichever app that literal names,
 * which is the wrong failure mode for the thing that decides where every user's
 * wallet lives. Privy's own setup guide also requires a client ID for mobile, so
 * a build missing either one is broken regardless; failing here says so at
 * startup instead of surfacing later as unexplained auth behaviour.
 */
function requiredEnv(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(
      `Privy is not configured — missing ${name}. Both EXPO_PUBLIC_PRIVY_APP_ID and `
      + 'EXPO_PUBLIC_PRIVY_CLIENT_ID are required for mobile (see .env.example); '
      + 'copy them from the Privy dashboard.',
    );
  }
  return trimmed;
}

const PRIVY_APP_ID = requiredEnv('EXPO_PUBLIC_PRIVY_APP_ID', process.env.EXPO_PUBLIC_PRIVY_APP_ID);
const PRIVY_CLIENT_ID = requiredEnv('EXPO_PUBLIC_PRIVY_CLIENT_ID', process.env.EXPO_PUBLIC_PRIVY_CLIENT_ID);

export function PrivyProvider({ children }: { children: React.ReactNode }) {
  return (
    <BasePrivyProvider
      appId={PRIVY_APP_ID}
      clientId={PRIVY_CLIENT_ID}
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
