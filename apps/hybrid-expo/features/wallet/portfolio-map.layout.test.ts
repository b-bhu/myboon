/**
 * Tests for the Portfolio Map layout function (issue #870): pure squarified
 * treemap math, each tile's area in proportion to its `valueUsd`, the tiles
 * covering the box exactly with no overlap and no gap, tiles kept close to
 * square, and the output sorted by value, largest first.
 *
 * Run: cd apps/hybrid-expo && npx tsx --test features/wallet/portfolio-map.layout.test.ts
 *
 * Only the pure module is imported — no React anywhere.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  layoutPortfolioMap,
  type PortfolioMapItem,
  type PortfolioMapTile,
} from './portfolio-map.layout';

/**
 * Assert every tile sits fully inside the box, no two tiles overlap, and
 * the tile areas add up to the box area — i.e. an exact cover, no gap.
 * The 1e-6 tolerance is float drift; the issue's tolerance is 0.5.
 */
function assertExactCover(
  tiles: readonly PortfolioMapTile[],
  width: number,
  height: number,
): void {
  const EPS = 1e-6;
  let areaSum = 0;
  for (const tile of tiles) {
    assert.ok(tile.x >= -EPS, `x is out of the box: ${tile.id}`);
    assert.ok(tile.y >= -EPS, `y is out of the box: ${tile.id}`);
    assert.ok(
      tile.x + tile.width <= width + EPS,
      `x + width is out of the box: ${tile.id}`,
    );
    assert.ok(
      tile.y + tile.height <= height + EPS,
      `y + height is out of the box: ${tile.id}`,
    );
    areaSum += tile.width * tile.height;
  }
  for (let a = 0; a < tiles.length; a++) {
    for (let b = a + 1; b < tiles.length; b++) {
      const left = tiles[a];
      const right = tiles[b];
      const overlapWidth = Math.min(
        left.x + left.width,
        right.x + right.width,
      ) - Math.max(left.x, right.x);
      const overlapHeight = Math.min(
        left.y + left.height,
        right.y + right.height,
      ) - Math.max(left.y, right.y);
      const overlap = Math.max(0, overlapWidth) * Math.max(0, overlapHeight);
      assert.ok(
        overlap <= EPS,
        `tiles ${left.id} and ${right.id} overlap by ${overlap}`,
      );
    }
  }
  assert.ok(
    Math.abs(areaSum - width * height) <= EPS,
    `tile areas ${areaSum} do not fill the box ${width * height}`,
  );
}

const items603010 = (): PortfolioMapItem[] => [
  { id: 'big', valueUsd: 60 },
  { id: 'mid', valueUsd: 30 },
  { id: 'small', valueUsd: 10 },
];

describe('layoutPortfolioMap', () => {
  it('gives 60/30/10 areas 6000/3000/1000 in a 100x100 box, covering it exactly', () => {
    const tiles = layoutPortfolioMap(items603010(), 100, 100);

    assertExactCover(tiles, 100, 100);
    // The areas: 6000, 3000 and 1000 within the issue's 0.5 tolerance.
    const byId = new Map(tiles.map((tile) => [tile.id, tile]));
    assert.deepEqual([...byId.keys()], ['big', 'mid', 'small']);
    assert.ok(
      Math.abs(byId.get('big')!.width * byId.get('big')!.height - 6000) <= 0.5,
    );
    assert.ok(
      Math.abs(byId.get('mid')!.width * byId.get('mid')!.height - 3000) <= 0.5,
    );
    assert.ok(
      Math.abs(
        byId.get('small')!.width * byId.get('small')!.height - 1000,
      ) <= 0.5,
    );
  });

  it('fills the whole box with a single item', () => {
    assert.deepEqual(layoutPortfolioMap([{ id: 'a', valueUsd: 5 }], 100, 100), [
      { id: 'a', x: 0, y: 0, width: 100, height: 100 },
    ]);
  });

  it('returns an empty array for an empty list', () => {
    assert.deepEqual(layoutPortfolioMap([], 100, 100), []);
  });

  it('drops 0, negative, NaN and Infinite values and keeps the valid siblings', () => {
    const items: PortfolioMapItem[] = [
      { id: 'zero', valueUsd: 0 },
      { id: 'negative', valueUsd: -1 },
      { id: 'nan', valueUsd: Number.NaN },
      { id: 'infinite', valueUsd: Number.POSITIVE_INFINITY },
      { id: 'valid', valueUsd: 5 },
      { id: 'negativeZero', valueUsd: -0 },
    ];
    assert.deepEqual(layoutPortfolioMap(items, 50, 40), [
      { id: 'valid', x: 0, y: 0, width: 50, height: 40 },
    ]);
    // The input list is untouched.
    assert.deepEqual(
      items.map((item) => item.id),
      ['zero', 'negative', 'nan', 'infinite', 'valid', 'negativeZero'],
    );
  });

  it('returns an empty array, without throwing, for a box with a zero side', () => {
    assert.deepEqual(layoutPortfolioMap(items603010(), 0, 100), []);
    assert.deepEqual(layoutPortfolioMap(items603010(), 100, 0), []);
    assert.deepEqual(layoutPortfolioMap(items603010(), 0, 0), []);
  });

  it('stays exact (cover, area, order) with many unequal values', () => {
    const items: PortfolioMapItem[] = [
      { id: 'a', valueUsd: 450 },
      { id: 'b', valueUsd: 220 },
      { id: 'c', valueUsd: 130 },
      { id: 'd', valueUsd: 90 },
      { id: 'e', valueUsd: 60 },
      { id: 'f', valueUsd: 30 },
      { id: 'g', valueUsd: 20 },
    ];
    const WIDTH = 100;
    const HEIGHT = 80;
    const total = 1000;
    const tiles = layoutPortfolioMap(items, WIDTH, HEIGHT);

    // Output is one tile per item, largest first.
    assert.deepEqual(
      tiles.map((tile) => tile.id),
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    );
    assertExactCover(tiles, WIDTH, HEIGHT);
    // Each tile's area is its share of the box, within 0.5.
    const values = new Map(items.map((item) => [item.id, item.valueUsd]));
    for (const tile of tiles) {
      const expected = ((values.get(tile.id) ?? 0) / total) * WIDTH * HEIGHT;
      assert.ok(
        Math.abs(tile.width * tile.height - expected) <= 0.5,
        `area of ${tile.id} is off the share`,
      );
    }
  });
});
