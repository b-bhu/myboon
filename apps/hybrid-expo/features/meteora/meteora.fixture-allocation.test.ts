import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureDecimalToAtomic, getFixtureSdkStrategyAllocation } from './meteora.fixture-allocation';

function total(rows: readonly { xAtomic: string; yAtomic: string }[], side: 'xAtomic' | 'yAtomic'): bigint {
  return rows.reduce((sum, row) => sum + BigInt(row[side]), 0n);
}

test('fixture upper bars are produced by Meteora official strategy allocator', () => {
  const spot = getFixtureSdkStrategyAllocation({
    activeBinId: 0, binStep: 25, minBinId: -34, maxBinId: 35,
    amountXAtomic: '1000000000', amountYAtomic: '100000000', strategy: 'spot',
  });
  const curve = getFixtureSdkStrategyAllocation({
    activeBinId: 0, binStep: 25, minBinId: -34, maxBinId: 35,
    amountXAtomic: '1000000000', amountYAtomic: '100000000', strategy: 'curve',
  });
  assert.equal(spot.length, 70);
  assert.ok(total(spot, 'xAtomic') <= 1_000_000_000n);
  assert.ok(total(spot, 'yAtomic') <= 100_000_000n);
  assert.notDeepEqual(spot, curve);
});

test('fixture allocation preserves unused X or Y as zero atomic amount', () => {
  assert.equal(fixtureDecimalToAtomic('1', 9), '1000000000');
  assert.equal(fixtureDecimalToAtomic('0', 9), '0');
  assert.equal(fixtureDecimalToAtomic('', 6), '0');
  assert.equal(fixtureDecimalToAtomic('0.000000', 6), '0');
});
