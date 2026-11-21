/**
 * Polymarket account-value composition (issue #723).
 *
 * Used by nothing in the Expo app yet; the server (GET /wallet/summary, #729)
 * computes the account's top-level value with it. The signature deliberately
 * has no open-order-cost parameter: the server cannot see open orders, and
 * cash already counts money reserved by an order. The Orders tab shows
 * orders on their own.
 */

export interface PolymarketValueInput {
  /** USD cash balance, or null when unknown. */
  cashUsd: number | null;
  /** USD value of the open (held) positions, or null when unknown. */
  openPositionsValueUsd: number | null;
  /** USD redeemable-now sum; null or omitted counts as 0. */
  readyToCollectUsd?: number | null;
}

/**
 * cash + open positions + ready to collect, or null when a component the
 * server must know (cash, open-positions value) is unknown. All inputs are
 * plain USD numbers; same rounding as the app (plain float addition).
 */
export function polymarketValueUsd({
  cashUsd,
  openPositionsValueUsd,
  readyToCollectUsd,
}: PolymarketValueInput): number | null {
  if (cashUsd === null || openPositionsValueUsd === null) return null;
  return cashUsd + openPositionsValueUsd + (readyToCollectUsd ?? 0);
}
