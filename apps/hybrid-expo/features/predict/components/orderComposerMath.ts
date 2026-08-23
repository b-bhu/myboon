/**
 * Pure math for the shared OrderComposerSheet (Predict redesign PRD §6).
 *
 * Kept free of React Native imports so node-based tests can exercise it
 * directly (`pnpm --filter hybrid-expo test:predict`).
 */

export interface ComposerReviewInput {
  /** pUSD amount the user is spending. */
  amount: number;
  /**
   * Expected execution price per share (0–1). Market mode: the book's
   * executable average from `buildExecutableBuyQuote`. Limit mode: the
   * resting limit price.
   */
  executionPrice: number | null;
}

export interface ComposerReview {
  /** pUSD paid out of pocket. Null when the amount is not a valid spend. */
  youPay: number | null;
  /** Execution price in contract cents (e.g. 57 for 57¢). */
  averagePriceCents: number | null;
  /** Estimated shares bought (each pays $1.00 if right). */
  shares: number | null;
  /** "If you're right" payout: shares × $1.00. */
  payoutIfRight: number | null;
  /** Most that can be lost — the full spend. */
  maximumLoss: number | null;
}

export function buildComposerReview({ amount, executionPrice }: ComposerReviewInput): ComposerReview {
  const spendValid = Number.isFinite(amount) && amount > 0;
  const priceValid =
    executionPrice !== null && Number.isFinite(executionPrice) && executionPrice > 0 && executionPrice < 1;

  if (!spendValid || !priceValid) {
    return {
      youPay: spendValid ? amount : null,
      averagePriceCents: priceValid ? Math.round((executionPrice as number) * 100) : null,
      shares: null,
      payoutIfRight: null,
      maximumLoss: spendValid ? amount : null,
    };
  }

  const shares = amount / (executionPrice as number);
  return {
    youPay: amount,
    averagePriceCents: Math.round((executionPrice as number) * 100),
    shares,
    payoutIfRight: shares,
    maximumLoss: amount,
  };
}

/** Polymarket share prices trade between 1¢ and 99¢. Clamp to that band on 1¢ steps. */
export function clampLimitPrice(priceCents: number): number {
  if (!Number.isFinite(priceCents)) return 50;
  return Math.min(99, Math.max(1, Math.round(priceCents)));
}

export function limitPriceToDollars(priceCents: number): number {
  return clampLimitPrice(priceCents) / 100;
}
