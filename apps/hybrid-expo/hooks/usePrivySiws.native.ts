/**
 * usePrivySiws — Sign-In With Solana for the external wallet. new (#948).
 *
 * Wraps Privy's `useLoginWithSiws` and `useLinkWithSiws` and chooses between
 * them by whether a Privy user is already authenticated (`pickSiwsMode`):
 * a wallet sign-in creates one Privy account keyed to the wallet address;
 * an existing email/Google session has the wallet linked onto it instead.
 *
 * The SIWS message is signed with the Mobile Wallet Adapter signer taken
 * directly from `useMobileWallet` — deliberately not `useWallet().signMessage`,
 * which for a signed-in email user is the Privy embedded wallet's signer, the
 * wrong key for SIWS.
 *
 * The path never provisions an embedded Solana wallet: nothing here touches
 * `create()` / `waitForWallet()`, and `createOnLogin` stays 'off' for Solana
 * (Decision D57 — external users never get an embedded Solana wallet).
 */

import { useCallback } from 'react';
import { useLinkWithSiws, useLoginWithSiws } from '@privy-io/expo';
import { useMobileWallet } from '@wallet-ui/react-native-web3js';
import { usePrivyWallet } from '@/hooks/usePrivyWallet';
import {
  runSiwsAuthentication,
  type SiwsMode,
} from '@/hooks/siwsAuthentication';

export interface PrivySiwsState {
  /**
   * Run the SIWS round trip for the connected external wallet. Resolves with
   * the mode that ran ('login' for a fresh wallet-only account, 'link' when
   * the wallet joined an existing session). Null where SIWS does not run —
   * the web sheet keeps its adapter-only external path (`usePrivySiws.web`).
   */
  authenticate: ((input: { address: string }) => Promise<SiwsMode>) | null;
}

export function usePrivySiws(): PrivySiwsState {
  const privy = usePrivyWallet();
  const { signMessage } = useMobileWallet();
  const loginSiws = useLoginWithSiws();
  const linkSiws = useLinkWithSiws();

  const authenticated = privy.isPrivyUser;

  const authenticate = useCallback(
    async ({ address }: { address: string }): Promise<SiwsMode> => {
      const result = await runSiwsAuthentication({
        address,
        authenticated,
        signMessage,
        generateMessage: loginSiws.generateMessage,
        login: ({ message, signature }) => loginSiws.login({ message, signature }),
        link: ({ message, signature }) => linkSiws.link({ message, signature }),
      });
      return result.mode;
    },
    [authenticated, linkSiws, loginSiws, signMessage],
  );

  return { authenticate };
}
