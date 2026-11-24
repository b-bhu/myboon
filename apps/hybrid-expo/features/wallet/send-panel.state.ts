/**
 * Send panel state — pure helpers for the Wallet Send body (issue #822).
 *
 * The chips (25 / 50 / 75 / Max) fill the amount from the Spot USDC balance
 * the wallet summary already carries (decision, issue #822: read it through
 * `useWalletSummary`; no controller read, no new balance fetch). The summary
 * holds the token's USD value, not a raw balance — for a dollar stablecoin
 * that is the balance to the cent, and it is floored to the 6th decimal so a
 * chip never offers more than the wallet holds.
 *
 * No validation of the amount or address lives here (#823 owns it).
 */

import type { WalletSummary } from '@myboon/shared/wallet-summary';
import { formatAtomicAmount, percentageOfAtomic } from '../swap/swap.math';

export const SEND_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SEND_USDC_DECIMALS = 6;

export const SEND_CHIPS = [
  { label: '25%', percent: 25 },
  { label: '50%', percent: 50 },
  { label: '75%', percent: 75 },
  { label: 'Max', percent: 100 },
] as const;

export type SendChipPercent = (typeof SEND_CHIPS)[number]['percent'];

/**
 * Spot USDC balance in atomic units (6 decimals), or null when the summary has
 * no Spot USDC to read: still loading, source unavailable or not connected.
 */
export function spotUsdcAtomic(summary: WalletSummary | null): string | null {
  const spot = summary?.apps.spot;
  if (!spot || spot.status !== 'ok' || !spot.summary) return null;
  const usdc = spot.summary.tokens.find((token) => token.mint === SEND_USDC_MINT);
  if (!usdc || usdc.valueUsd === null || !Number.isFinite(usdc.valueUsd) || usdc.valueUsd < 0) return null;
  return BigInt(Math.floor(usdc.valueUsd * 10 ** SEND_USDC_DECIMALS)).toString();
}

/** The amount-input text a chip puts in: `percent` of the balance, plain decimal. */
export function chipAmountText(balanceAtomic: string, percent: SendChipPercent): string {
  return formatAtomicAmount(
    percentageOfAtomic(balanceAtomic, percent),
    SEND_USDC_DECIMALS,
    SEND_USDC_DECIMALS,
  );
}

/** The balance as shown on the amount card ("Bal 250.5"). */
export function balanceText(balanceAtomic: string): string {
  return formatAtomicAmount(balanceAtomic, SEND_USDC_DECIMALS, 2);
}

/** Keep typed amount text to digits and one decimal point, at most 6 decimals. */
export function sanitizeAmountText(text: string): string {
  const cleaned = text.replace(',', '.').replace(/[^\d.]/g, '');
  const [whole = '', ...rest] = cleaned.split('.');
  if (rest.length === 0) return whole;
  return `${whole}.${rest.join('').slice(0, SEND_USDC_DECIMALS)}`;
}
