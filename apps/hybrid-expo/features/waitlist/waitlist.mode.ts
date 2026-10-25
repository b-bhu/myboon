/**
 * Build-time switch for the v1.0.5 waitlist build (#432).
 *
 * `EXPO_PUBLIC_` values are inlined at build time, so this is a constant in the
 * bundle. Only the exact string `1` turns it on; unset (the full build) keeps
 * every screen exactly as it is.
 */
export const WAITLIST_MODE = process.env.EXPO_PUBLIC_WAITLIST_MODE === '1';

export const WAITLIST_CTA = 'Join the waitlist';
export const WAITLIST_PITCH = 'Wallet and trading are coming soon. Join for early access.';
export const WAITLIST_SOURCE = 'app-v1.0.5';
export const PRIVACY_URL = 'https://myboon.tech/privacy';
export const TERMS_URL = 'https://myboon.tech/terms';

/** The label a wallet/trade button shows: the waitlist CTA in waitlist mode. */
export function waitlistLabel(fullLabel: string): string {
  return WAITLIST_MODE ? WAITLIST_CTA : fullLabel;
}
