/**
 * Pacifica perps value helpers (issue #723), moved from the Expo app's
 * apps/hybrid-expo/features/perps/perps.public-api.ts so the server computes
 * the same unrealized P&L as the app.
 */

/** Parses whatever the Pacifica API sends (string | number | garbage) to a finite number; 0 otherwise. */
export function safeNum(val: unknown): number {
  const n = parseFloat(String(val));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Pacifica unrealized P&L for one position: (mark - entry) * size * direction
 * (direction 1 = long, -1 = short). Same rounding as the app: plain float
 * multiplication, no normalization.
 */
export function pacificaUnrealizedPnl(
  entryPrice: number,
  markPrice: number,
  size: number,
  direction: number,
): number {
  return (markPrice - entryPrice) * size * direction;
}
