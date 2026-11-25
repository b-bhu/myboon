/**
 * Pure text rule for a Portfolio Map tile (issue #871, wallet.html at
 * 02b98eba, frame "Portfolio · Map"): the frame's drawMaps shows the name,
 * the value and the portfolio-total percent only when the tile is wide and
 * tall enough — "wider than 70 and taller than 44" — and otherwise draws the
 * name only, smaller. No React, no imports: PortfolioMap applies the
 * returned shape, and the tests in portfolio-map.tiles.test.ts pin it.
 */

export interface PortfolioMapTileText {
  /** Draw the value line (`valueText` + whole-percent share) under the name. */
  detail: boolean;
  /** The value's share of the Portfolio total, a whole percent (rounded). */
  percent: number;
}

/**
 * The frame's `(w > 70 && h > 44)` detail test and
 * `Math.round(value / total * 100)` share, so the tile rendering and its
 * tests agree on one rule. A total that cannot be divided by (0, negative,
 * or non-finite) yields 0 — the Map only draws tiles with positive values
 * inside a positive Portfolio total, so in the UI the guard never fires.
 */
export function portfolioMapTileText(
  width: number,
  height: number,
  valueUsd: number,
  totalUsd: number,
): PortfolioMapTileText {
  return {
    detail: width > 70 && height > 44,
    percent:
      Number.isFinite(valueUsd) && Number.isFinite(totalUsd) && totalUsd > 0
        ? Math.round((valueUsd / totalUsd) * 100)
        : 0,
  };
}
