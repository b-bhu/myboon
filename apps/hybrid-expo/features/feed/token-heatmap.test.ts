import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutVolumeTreemap, heatmapTone, formatHeatmapChange } from './token-heatmap-layout';
import { fetchTokenHeatmap } from './token-heatmap.api';
import type { HeatmapInterval, HeatmapToken, TokenHeatmapResult } from './token-heatmap.types';

const addresses = ['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', '11111111111111111111111111111111'];
const token = (volumeUsd: number, index: number, change: number | null = 0): HeatmapToken => ({
  address: addresses[index]!, symbol: `T${index}`, name: `Token ${index}`, volumeUsd, priceChangePct: change,
  priceUsd: 1, marketCapUsd: null, liquidityUsd: null,
});

export function heatmapFixture(interval: HeatmapInterval = '24h', overrides: Partial<TokenHeatmapResult> = {}): TokenHeatmapResult {
  return { interval, chain: 'solana', limit: 20, source: 'jupiter', status: 'ready',
    tokens: [token(80, 0, -1.25), token(20, 1, 2)], fetchedAt: '2026-10-07T10:00:00Z', nextRefreshAt: '2026-10-07T10:05:00Z',
    stale: false, partial: false, ...overrides };
}

test('treemap area represents interval volume exactly, covers the map, and never overlaps at mobile and wide sizes', () => {
  const tokens = [token(1, 3), token(80, 0), token(4, 2), token(15, 1)];
  for (const [width, height] of [[328, 320], [700, 300], [280, 450]]) {
    const tiles = layoutVolumeTreemap(tokens, width!, height!);
    assert.equal(tiles.length, 4);
    assert.equal(tiles[0]!.token.address, addresses[0]);
    const totalArea = width! * height!;
    for (const tile of tiles) {
      assert.ok(Math.abs(tile.width * tile.height / totalArea - tile.token.volumeUsd / 100) < 1e-10);
      assert.ok(tile.x >= 0 && tile.y >= 0 && tile.x + tile.width <= width! + 1e-8 && tile.y + tile.height <= height! + 1e-8);
      for (const other of tiles) {
        if (tile === other) continue;
        const overlapW = Math.min(tile.x + tile.width, other.x + other.width) - Math.max(tile.x, other.x);
        const overlapH = Math.min(tile.y + tile.height, other.y + other.height) - Math.max(tile.y, other.y);
        assert.ok(overlapW < 1e-8 || overlapH < 1e-8);
      }
    }
    assert.ok(Math.abs(tiles.reduce((sum, tile) => sum + tile.width * tile.height, 0) - totalArea) < 1e-7);
  }
});

test('unknown/zero volume cannot invent tile area, and extreme finite volumes keep their 2:1 area ratio', () => {
  assert.deepEqual(layoutVolumeTreemap([token(0, 0), token(-1, 1), token(NaN, 2)], 328, 320), []);
  assert.deepEqual(layoutVolumeTreemap([token(1, 0)], 0, 320), []);
  const tiles = layoutVolumeTreemap([token(Number.MAX_VALUE, 0), token(Number.MAX_VALUE / 2, 1)], 328, 320);
  assert.ok(Math.abs(tiles[0]!.width * tiles[0]!.height / (tiles[1]!.width * tiles[1]!.height) - 2) < 1e-10);
});

test('gain/loss comes from price change, including tiny changes, while missing and zero stay neutral', () => {
  assert.equal(heatmapTone(0.00001), 'up');
  assert.equal(heatmapTone(-0.00001), 'down');
  assert.equal(heatmapTone(null), 'neutral');
  assert.equal(heatmapTone(0), 'neutral');
  assert.equal(formatHeatmapChange(0.00001), '+<0.01%');
  assert.equal(formatHeatmapChange(-0.00001), '−<0.01%');
  assert.equal(formatHeatmapChange(null), 'Unavailable');
  assert.equal(formatHeatmapChange(0), '0.00%');
});

test('API adapter keeps unavailable separate from empty/stale and rejects another interval or invalid token data', async () => {
  const original = globalThis.fetch;
  let payload: unknown = heatmapFixture('1h', { tokens: [] });
  let status = 200;
  let requested = '';
  globalThis.fetch = async (input) => { requested = String(input); return Response.json(payload, { status }); };
  try {
    assert.deepEqual((await fetchTokenHeatmap('1h')).tokens, []);
    assert.equal(new URL(requested).searchParams.get('interval'), '1h');
    payload = heatmapFixture('1h', { status: 'unavailable', tokens: [], fetchedAt: null, error: { code: 'NOT_CONFIGURED', retryable: false, message: 'Unavailable' } });
    status = 503;
    assert.equal((await fetchTokenHeatmap('1h')).status, 'unavailable');
    status = 200;
    await assert.rejects(fetchTokenHeatmap('1h'), /could not be loaded/);
    payload = heatmapFixture('1h', { status: 'stale', stale: true });
    assert.equal((await fetchTokenHeatmap('1h')).stale, true);
    payload = heatmapFixture('24h');
    await assert.rejects(fetchTokenHeatmap('1h'), /could not be loaded/);
    payload = heatmapFixture('1h', { tokens: [token(-10, 0)] });
    await assert.rejects(fetchTokenHeatmap('1h'), /could not be loaded/);
    payload = heatmapFixture('1h', { tokens: [token(1, 0), token(2, 0)] });
    await assert.rejects(fetchTokenHeatmap('1h'), /could not be loaded/);
    payload = { ...heatmapFixture('1h'), source: 'birdeye' };
    await assert.rejects(fetchTokenHeatmap('1h'), /could not be loaded/);
    for (const interval of ['5m', '1h', '6h', '24h'] as const) {
      payload = heatmapFixture(interval);
      assert.equal((await fetchTokenHeatmap(interval)).interval, interval);
    }
  } finally { globalThis.fetch = original; }
});
