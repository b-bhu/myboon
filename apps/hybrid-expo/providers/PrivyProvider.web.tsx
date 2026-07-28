/**
 * PrivyProvider (web) — `@privy-io/react-auth`.
 *
 * The native app uses `@privy-io/expo`, which does not run in a browser. This
 * is the web equivalent, behind a flag, so the EVM path can be exercised in a
 * browser instead of only on a device.
 *
 * Why that matters: Privy is the only backend that can satisfy EVM (MWA is
 * Solana-only by specification), so with Privy stubbed on web the whole
 * Polymarket flow was untestable outside a device.
 *
 * Enabled by `EXPO_PUBLIC_PRIVY_WEB=1`. Off by default so the web build keeps
 * its previous behaviour unless the flag is set — this is a developer testing
 * affordance, not a shipping decision.
 *
 * Solana is deliberately NOT wired here. `@privy-io/react-auth/solana` needs
 * peer dependencies the app does not carry, and web already has a working
 * Solana path through the wallet-adapter extensions. Only the EVM gap needed
 * closing.
 *
 * Model: docs/modules/wallet/specs/wallet_connectivity.md
 */

import React from 'react';
import { PrivyProvider as BasePrivyProvider } from '@privy-io/react-auth';

const PRIVY_APP_ID = process.env.EXPO_PUBLIC_PRIVY_APP_ID ?? 'cmofdpvdb00h40cl7qftz9343';
const PRIVY_CLIENT_ID = process.env.EXPO_PUBLIC_PRIVY_CLIENT_ID ?? '';

export const PRIVY_WEB_ENABLED = process.env.EXPO_PUBLIC_PRIVY_WEB === '1';

export function PrivyProvider({ children }: { children: React.ReactNode }) {
  if (!PRIVY_WEB_ENABLED) return <>{children}</>;

  return (
    <BasePrivyProvider
      appId={PRIVY_APP_ID}
      clientId={PRIVY_CLIENT_ID || undefined}
      config={{
        // Matches the native provider exactly. A web build that eagerly
        // provisioned would break the dormancy invariant on one platform only,
        // which is worse than not supporting web at all — it would surface as
        // an address the user never asked for.
        embeddedWallets: {
          ethereum: { createOnLogin: 'off' },
          solana: { createOnLogin: 'off' },
        },
      }}
    >
      {children}
    </BasePrivyProvider>
  );
}
