/**
 * Pure layout math for the Portfolio Map view (issue #870): places one
 * rectangle per holding inside a box, each rectangle's area in proportion
 * to its `valueUsd`. This is the squarified treemap algorithm (Bruls,
 * Huizing and van Wijk, "Squarified Treemaps", Data Visualization 2000):
 * rows of tiles are grown along the shorter side of the remaining box for
 * as long as growing does not make the worst tile aspect ratio worse, which
 * keeps tiles close to square.
 *
 * This issue adds the math only — no React, no imports from UI code. The
 * Map view child of #841 draws these rectangles. The caller applies the
 * dust filter ($1 rule, `DUST_USD` in wallet-portfolio.rows.ts) before
 * calling; dropping rows with 0, negative, NaN or infinite values here is
 * just a safety net so the layout always stays exact.
 */

export interface PortfolioMapItem {
  /** Stable identifier (app key or spot mint), passed through to the tile. */
  id: string;
  /** Portfolio value in USD. */
  valueUsd: number;
}

/** One placed rectangle, in the same points the mock measures. */
export interface PortfolioMapTile {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Only a positive, finite value makes a drawable tile. */
function isPositiveFinite(valueUsd: number): boolean {
  return Number.isFinite(valueUsd) && valueUsd > 0;
}

/**
 * Worst aspect ratio of any tile in a row laid in a strip of length
 * `length` (the side of the remaining box the strip spans). The strip's
 * shared side is t = sumRows / length and tile i is c_i / t long, so the
 * worst ratio is max(t^2 / c_min, c_max / t^2), with rowMax >= c >= rowMin.
 */
function worstRatio(
  sumRows: number,
  rowMax: number,
  rowMin: number,
  length: number,
): number {
  const t = sumRows / length;
  const t2 = t * t;
  return Math.max(t2 / rowMin, rowMax / t2);
}

/**
 * Lay `items` out in a `width` by `height` box so that each tile's area is
 * `valueUsd / total * width * height`, the tiles cover the box exactly with
 * no overlap and no gap, and tiles stay close to square. The returned
 * tiles are sorted by value, largest first. Items with a 0, negative, NaN
 * or infinite `valueUsd` are dropped; a non-positive or non-finite box
 * yields an empty array. The input is not mutated.
 */
export function layoutPortfolioMap(
  items: readonly PortfolioMapItem[],
  width: number,
  height: number,
): PortfolioMapTile[] {
  if (
    !(width > 0) ||
    !(height > 0) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return [];
  }

  const kept = items
    .filter((item) => isPositiveFinite(item.valueUsd))
    .sort((a, b) => b.valueUsd - a.valueUsd);
  if (kept.length === 0) {
    return [];
  }

  const total = kept.reduce((sum, item) => sum + item.valueUsd, 0);
  const scale = (width * height) / total;
  const areas = kept.map((item) => ({
    id: item.id,
    area: item.valueUsd * scale,
  }));

  const tiles: PortfolioMapTile[] = [];
  let x = 0;
  let y = 0;
  let w = width;
  let h = height;
  let first = 0; // first index of the row being grown

  while (first < areas.length) {
    // Rows are laid along the shorter side of the remaining rectangle.
    const length = Math.min(w, h);
    let sumRows = areas[first].area;
    let rowMax = sumRows;
    let rowMin = sumRows;
    let last = first; // last index (inclusive) of the row

    // Grow the row while the next tile keeps the worst aspect ratio no
    // worse (the paper's `>=` branch, so ties keep the row growing).
    while (last + 1 < areas.length) {
      const next = areas[last + 1].area;
      const grownSum = sumRows + next;
      const grownMax = Math.max(rowMax, next);
      const grownMin = Math.min(rowMin, next);
      if (
        worstRatio(sumRows, rowMax, rowMin, length) <
        worstRatio(grownSum, grownMax, grownMin, length)
      ) {
        break;
      }
      sumRows = grownSum;
      rowMax = grownMax;
      rowMin = grownMin;
      last++;
    }

    if (h <= w) {
      // Column on the left: full height h, advancing right.
      const thickness = sumRows / h;
      let cy = y;
      for (let j = first; j <= last; j++) {
        const tileHeight = areas[j].area / thickness;
        tiles.push({
          id: areas[j].id,
          x,
          y: cy,
          width: thickness,
          height: tileHeight,
        });
        cy += tileHeight;
      }
      x += thickness;
      w -= thickness;
    } else {
      // Row on top: full width w, advancing down.
      const thickness = sumRows / w;
      let cx = x;
      for (let j = first; j <= last; j++) {
        const tileWidth = areas[j].area / thickness;
        tiles.push({
          id: areas[j].id,
          x: cx,
          y,
          width: tileWidth,
          height: thickness,
        });
        cx += tileWidth;
      }
      y += thickness;
      h -= thickness;
    }
    first = last + 1;
  }

  return tiles;
}
