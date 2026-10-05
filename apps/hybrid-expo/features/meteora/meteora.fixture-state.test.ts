import assert from 'node:assert/strict';
import test from 'node:test';
import { getMeteoraFixturePoolSnapshot } from './meteora.fixture-state';

test('fixture pool-movement control advances the active SDK snapshot without replacing the adapter', () => {
  const movement = { moved: false };
  const initial = getMeteoraFixturePoolSnapshot('sdk-move', movement);
  movement.moved = true;
  const moved = getMeteoraFixturePoolSnapshot('sdk-move', movement);
  assert.notEqual(initial.activeBinId, moved.activeBinId);
  assert.notEqual(initial.currentPrice, moved.currentPrice);
});
