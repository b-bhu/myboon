/**
 * siwsAuthentication — Sign-In With Solana for the external wallet, as a pure
 * module. new (#948).
 *
 * The external wallet (Phantom or Seeker via Mobile Wallet Adapter) becomes the
 * main Privy account through SIWS (Decision D57). A fresh wallet user gets one
 * Privy account keyed to the wallet address; an existing email/Google user gets
 * the wallet linked onto their current account instead. Neither path creates an
 * embedded Solana wallet — the external wallet stays the main Solana account.
 *
 * Kept free of React and of both SDK packages so the login-vs-link decision,
 * the message signing and the submission order are testable without a device.
 * `hooks/usePrivySiws.native.ts` is the wiring that feeds it.
 */

import bs58 from 'bs58';

/**
 * The app's own identity for the SIWS message. Both platform ids in
 * `app.json` are `xyz.myboon.app`. Privy records these in the message; nothing
 * at runtime consults them, and the signature — not the domain vouches for the
 * address.
 */
export const SIWS_DOMAIN = 'xyz.myboon.app';
export const SIWS_URI = `https://${SIWS_DOMAIN}`;

export type SiwsMode = 'login' | 'link';

/** Privy's `useLoginWithSiws` / `useLinkWithSiws` generateMessage shape. */
export type SiwsGenerateMessage = (args: {
  wallet: { address: string };
  from: { domain: string; uri: string };
}) => Promise<{ message: string }>;

/** Privy's `login` / `link` submissions. */
export type SiwsSubmit = (args: { message: string; signature: string }) => Promise<unknown>;

export interface SiwsAuthenticationDeps {
  /** The external wallet address the SIWS message is keyed to. */
  address: string;
  /** Whether a Privy user is already authenticated. */
  authenticated: boolean;
  /** The external wallet's signer — the Mobile Wallet Adapter signer, never the embedded one. */
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
  /** Privy's SIWS generateMessage (both hook variants share one shape). */
  generateMessage: SiwsGenerateMessage;
  /** Privy's `useLoginWithSiws().login` — creates or resumes an account keyed to the wallet. */
  login: SiwsSubmit;
  /** Privy's `useLinkWithSiws().link` — links the wallet onto the current session. */
  link: SiwsSubmit;
}

export interface SiwsAuthenticationResult {
  /** Which submission ran — the callers' record of what happened. */
  mode: SiwsMode;
}

/**
 * Link vs login is decided by whether a Privy user is already authenticated.
 * Signing in when a session exists would mint a second account; linking when
 * none exists would reject with "Must be logged in". The hook that calls this
 * passes one boolean, read from the session, and this rule keeps the two
 * submissions apart in one testable place.
 */
export function pickSiwsMode(privyAuthenticated: boolean): SiwsMode {
  return privyAuthenticated ? 'link' : 'login';
}

/**
 * The Mobile Wallet Adapter returns the 64-byte Solana signature as raw bytes;
 * Privy's SIWS API expects the Solana convention, base58.
 */
export function encodeSiwsSignature(signature: Uint8Array): string {
  return bs58.encode(signature);
}

/**
 * One SIWS round trip: Privy generates the message for the address, the
 * external wallet signs exactly those bytes, Privy receives the message and
 * the base58 signature. Order matters — the message exists before the wallet
 * is asked to sign, and the submission never runs without both.
 */
export async function runSiwsAuthentication(
  deps: SiwsAuthenticationDeps,
): Promise<SiwsAuthenticationResult> {
  if (!deps.address) {
    throw new Error('Sign-In With Solana needs the connected wallet address.');
  }
  const mode = pickSiwsMode(deps.authenticated);
  const { message } = await deps.generateMessage({
    wallet: { address: deps.address },
    from: { domain: SIWS_DOMAIN, uri: SIWS_URI },
  });
  const signatureBytes = await deps.signMessage(
    Buffer.from(message, 'utf8'),
  );
  const signature = encodeSiwsSignature(signatureBytes);
  const submit: SiwsSubmit = mode === 'link' ? deps.link : deps.login;
  await submit({ message, signature });
  return { mode };
}
