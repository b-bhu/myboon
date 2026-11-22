/**
 * Portfolio API totals helpers moved into shared (issue #723): the Expo app's
 * apps/hybrid-expo/features/polymarket/portfolio/portfolio-totals.ts keeps
 * rendering helpers like formatShowingLabel(); only the value-relevant part
 * below became a shared definition so the server can resolve the same
 * cash-out figure.
 */

/**
 * #454 review: a loaded portfolio with no cashOutNow in its summary is
 * "unknown", not $0. Only a real API number is shown.
 */
export function resolveCashOutNow(
  portfolio: { summary?: { cashOutNow?: number | null } | null } | null | undefined,
): number | null {
  return portfolio ? (portfolio.summary?.cashOutNow ?? null) : null;
}
