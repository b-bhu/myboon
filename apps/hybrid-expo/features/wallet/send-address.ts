/**
 * Send address validation — pure rules for the Wallet Send address card
 * (issue #823, design wallet.html frames "Send" and "Send · empty").
 *
 * A Solana address is 32 bytes in base58: a string of 32 to 44 characters
 * using the base58 alphabet (no 0, O, I, l). The rule is the same as
 * SOLANA_ADDRESS_PATTERN in packages/api/src/wallet-move/routes.ts, copied
 * into the app — same string tested raw, no trim, like the api route does.
 *
 * Format only: no network check of the address, and the slider keeps
 * gating on address and amount together (#825 owns the slider).
 */

export const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The one plain error line the address card shows for a bad address. */
export const SEND_ADDRESS_ERROR = 'This is not a Solana address.';

/**
 * The error line for a typed or pasted address, rechecked on every change:
 * null while the field is empty (no error) or holds a valid address, and the
 * plain error otherwise — so fixing the address clears the line.
 */
export function sendAddressError(address: string): string | null {
  if (address === '') return null;
  return SOLANA_ADDRESS_PATTERN.test(address) ? null : SEND_ADDRESS_ERROR;
}
