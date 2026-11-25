/**
 * Tests for the Portfolio Map tile text rule (issue #871): the frame's
 * "wider than 70 and taller than 44" detail test at its exact limits, and
 * the whole-percent share's rounding. Pure scenarios — the placement itself
 * is #870's layoutPortfolioMap, unchanged.
 *
 * Run: pnpm --filter hybrid-expo test:wallet
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { portfolioMapTileText } from './portfolio-map.tiles';

describe('portfolioMapTileText detail', () => {
  it('is off at the frame limits themselves (wider than 70, taller than 44)', () => {
    // 70 is not wider than 70; 44 is not taller than 44 (drawMaps: w > 70 && h > 44).
    assert.equal(portfolioMapTileText(70, 45, 100, 1000).detail, false);
    assert.equal(portfolioMapTileText(71, 44, 100, 1000).detail, false);
    assert.equal(portfolioMapTileText(70, 44, 100, 1000).detail, false);
  });

  it('needs both width and height to show the value line', () => {
    assert.equal(portfolioMapTileText(71, 45, 100, 1000).detail, true);
    assert.equal(portfolioMapTileText(300, 44, 100, 1000).detail, false);
    assert.equal(portfolioMapTileText(70, 260, 100, 1000).detail, false);
  });

  it('shows the value line on a roomy tile whatever its value', () => {
    assert.equal(portfolioMapTileText(120, 70, 12.34, 1000).detail, true);
    assert.equal(portfolioMapTileText(120, 70, 0.99, 1000).detail, true);
  });
});

describe('portfolioMapTileText percent', () => {
  it('rounds the value/total share to a whole percent', () => {
    assert.equal(portfolioMapTileText(120, 70, 123.4, 1000).percent, 12);
    assert.equal(portfolioMapTileText(120, 70, 125.0, 1000).percent, 13);
    assert.equal(portfolioMapTileText(120, 70, 124.9, 1000).percent, 12);
    assert.equal(portfolioMapTileText(120, 70, 666.6, 1000).percent, 67);
    assert.equal(portfolioMapTileText(120, 70, 333.3, 1000).percent, 33);
    assert.equal(portfolioMapTileText(120, 70, 1000, 1000).percent, 100);
  });

  it('is not clamped to 100 when the total leaves a value out', () => {
    // The frame computes Math.round regardless; the UI never asks (every
    // tile's value is inside the total), this only pins the rule.
    assert.equal(portfolioMapTileText(120, 70, 205.4, 100).percent, 205);
  });

  it('is 0 when the total cannot be divided by', () => {
    assert.equal(portfolioMapTileText(120, 70, 12.34, 0).percent, 0);
    assert.equal(portfolioMapTileText(120, 70, 12.34, Number.NaN).percent, 0);
    assert.equal(portfolioMapTileText(120, 70, Number.NaN, 1000).percent, 0);
  });
});
