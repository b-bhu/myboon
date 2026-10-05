import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY_POSITION_DRAFT, normalizePoolPrice } from './meteora.form';
import { resolveManualRangeForDisplay } from '@myboon/shared/meteora';
import {
  amountFromBalance,
  canUseMeteoraBalanceShortcut,
  autoFillPatch,
  exceedsBalance,
  mergePositionDraftPatch,
  priceDeltaLabel,
  nextMeteoraChartBinViewport,
  getMeteoraPoolLiquidityViewport,
  getMeteoraPoolStateSnapshotKey,
  rangeChartBinGeometry,
  reciprocalPrice,
  rangeBinDeltaPatch,
  rangePoolBinDeltaPatch,
  rangePoolBinShiftPatch,
  rangeChartGeometry,
  rangeHandleGeometry,
  tokenAmountPatch,
} from './meteora.position-form';

test('balance shortcuts round down without losing atomic precision', () => {
  assert.equal(amountFromBalance('18446744073.709551615', 9, 1), '18446744073.709551615');
  assert.equal(amountFromBalance('18446744073.709551615', 9, 2), '9223372036.854775807');
  assert.equal(amountFromBalance('0.000000001', 9, 2), '0');
  assert.equal(amountFromBalance('0.000001', 6, 1), '0.000001');
  assert.equal(amountFromBalance('3', 0, 2), '1');
  assert.equal(amountFromBalance('0.01', 9, 1, '0.0575'), '0');
  assert.equal(amountFromBalance('Checking…', 9, 1), null);
  assert.equal(amountFromBalance('0.0000000001', 9, 1), null);
  assert.equal(exceedsBalance('0.000000001', '0'), true);
  assert.equal(exceedsBalance('18446744073.709551615', '18446744073.709551614'), true);
  assert.equal(exceedsBalance('1', 'Unavailable'), false);
});

test('native deposits include the current fee and rent reserve in local balance validation', () => {
  assert.equal(amountFromBalance('0.07606', 9, 1, '0.0575'), '0.01856');
  assert.equal(exceedsBalance('0.02', '0.07606', false, '0.0575'), true);
  assert.equal(exceedsBalance('0.01856', '0.07606', false, '0.0575'), false);
  assert.equal(canUseMeteoraBalanceShortcut({ isNative: true, isCreating: true, nativeReserve: null, nativeBalance: '3' }), false);
  assert.equal(canUseMeteoraBalanceShortcut({ isNative: true, isCreating: true, nativeReserve: '0.0575', nativeBalance: null }), false);
  assert.equal(canUseMeteoraBalanceShortcut({ isNative: true, isCreating: true, nativeReserve: '0.0575', nativeBalance: '3' }), true);
  assert.equal(canUseMeteoraBalanceShortcut({ isNative: false, isCreating: true, nativeReserve: null, nativeBalance: null }), true);
});

test('inverted prices preserve decimal notation and reverse range order', () => {
  assert.equal(reciprocalPrice('100'), '0.01');
  assert.equal(reciprocalPrice('0.00000001'), '100000000');
  assert.equal(reciprocalPrice('100000000000000000000'), '0.00000000000000000001');
  assert.equal(reciprocalPrice('0'), '');
  assert.equal(reciprocalPrice('1e3'), '');
  assert.ok(Number(reciprocalPrice('110')) < Number(reciprocalPrice('90')));
  assert.equal(priceDeltaLabel('90', '100'), '-10.00%');
  assert.equal(priceDeltaLabel(reciprocalPrice('110'), reciprocalPrice('100')), '-9.09%');
});

test('editing the calculated side switches Auto-Fill inputs', () => {
  const draft = { ...EMPTY_POSITION_DRAFT, autoFill: true, amountX: '1', amountY: '' };
  assert.deepEqual(tokenAmountPatch(draft, 'y', '2'), { amountY: '2', amountX: '' });
  assert.deepEqual(tokenAmountPatch(draft, 'x', ''), { amountX: '', amountY: '' });
  assert.deepEqual(tokenAmountPatch({ ...draft, autoFill: false }, 'y', '2'), { amountY: '2' });
  assert.deepEqual(tokenAmountPatch(draft, 'y', '0'), { amountX: '1', amountY: '' });
  assert.deepEqual(tokenAmountPatch(draft, 'y', '-2'), { amountY: '-2', amountX: '' });
  assert.deepEqual(tokenAmountPatch({ ...draft, amountY: '2' }, 'x', '3'), {
    amountX: '3', amountY: '',
  });
});

test('Auto-Fill toggles preserve entered amounts and copy only live quoted amounts', () => {
  const draft = { ...EMPTY_POSITION_DRAFT, amountX: '0', amountY: '2.00' };
  assert.deepEqual(autoFillPatch(draft, true), { autoFill: true, amountX: '0', amountY: '2.00' });
  assert.deepEqual(autoFillPatch({ ...draft, amountX: '1' }, true), { autoFill: true, amountX: '1', amountY: '2.00' });
  assert.deepEqual(autoFillPatch({ ...draft, amountY: '' }, true), { autoFill: true, amountX: '0', amountY: '' });
  assert.deepEqual(autoFillPatch({ ...draft, amountX: '1', amountY: '2.00' }, true), {
    autoFill: true, amountX: '1', amountY: '2.00',
  });
  const enabled = { ...draft, autoFill: true, amountX: '1', amountY: '' };
  assert.deepEqual(autoFillPatch(enabled, false), { autoFill: false, amountX: '1', amountY: '' });
  assert.deepEqual(autoFillPatch(enabled, false, { amountX: '1', amountY: '120.123456' }), {
    autoFill: false, amountX: '1', amountY: '120.123456',
  });
  const cycled = autoFillPatch(enabled, false, { amountY: '120.123456' });
  assert.deepEqual(autoFillPatch({ ...enabled, ...cycled }, true), {
    autoFill: true, amountX: '1', amountY: '120.123456',
  });
  assert.deepEqual(autoFillPatch({ ...enabled, amountX: 'not-a-number' }, true), {
    autoFill: true, amountX: 'not-a-number', amountY: '',
  });
  assert.deepEqual(autoFillPatch({ ...enabled, amountX: 'not-a-number' }, false, {
    amountX: '9', amountY: '120.123456',
  }), {
    autoFill: false, amountX: 'not-a-number', amountY: '120.123456',
  });
});

test('charts keep off-center ranges and the pool price in the same bin domain', () => {
  const geometry = rangeChartGeometry('90', '110', '100', 100);
  assert.ok(geometry);
  assert.ok(geometry.currentPercent > 3 && geometry.currentPercent < 97);
  assert.ok(geometry.minPercent < geometry.currentPercent);
  assert.ok(geometry.maxPercent > geometry.currentPercent);
  const abovePrice = rangeChartGeometry('200', '300', '100', 100);
  assert.ok(abovePrice);
  assert.ok(abovePrice.currentPercent < abovePrice.minPercent);
  assert.ok(abovePrice.maxPercent <= 97);
  assert.ok(abovePrice.binSpan > 0);
  assert.equal(rangeChartGeometry('', '110', '100', 100), null);
  assert.equal(rangeChartGeometry('110', '90', '100', 100), null);
});

test('narrow ranges preserve exact handle positions at either chart edge', () => {
  assert.deepEqual(rangeHandleGeometry(96.8, 97, 50), {
    minPercent: 96.8, maxPercent: 97, currentPercent: 50,
  });
  assert.deepEqual(rangeHandleGeometry(3, 3.2, 50), {
    minPercent: 3, maxPercent: 3.2, currentPercent: 50,
  });
  const reversed = rangeHandleGeometry(80, 20, NaN);
  assert.equal(reversed.minPercent, reversed.maxPercent);
  assert.equal(reversed.currentPercent, 50);
});

test('pool prices retain API precision before charting and display inversion', () => {
  const price = '120.516123456789123456';
  assert.equal(normalizePoolPrice(price), price);
  assert.equal(normalizePoolPrice('1.20516123456789123456e2'), price);
  assert.equal(normalizePoolPrice('1.23456789123456789e-8'), '0.0000000123456789123456789');
  assert.equal(normalizePoolPrice('001.2300'), '1.23');
  for (const value of [null, '', '0', 'NaN', '-1', '1e1000']) {
    assert.equal(normalizePoolPrice(value), null);
  }
});

test('queued range drag steps accumulate without changing deposit amounts', () => {
  const initial = {
    ...EMPTY_POSITION_DRAFT,
    amountX: '0.02', amountY: '10', requestedMinPrice: '95', requestedMaxPrice: '105',
  };
  const deltas = [1, 2, -1, 3];
  const queuedSteps = deltas.map((deltaBins) => (current: typeof initial) => ({
    ...current,
    ...rangeBinDeltaPatch(current, { currentPrice: '100', binStep: 100, edge: 'min', deltaBins }),
  }));
  const updated = queuedSteps.reduce((current, step) => step(current), initial);
  assert.ok(Math.abs(Number(updated.requestedMinPrice) - 95 * 1.01 ** 5) < 1e-10);
  assert.equal(updated.requestedMaxPrice, '105');
  assert.deepEqual([updated.amountX, updated.amountY], ['0.02', '10']);
  assert.deepEqual(rangeBinDeltaPatch(updated, {
    currentPrice: '100', binStep: 100, edge: 'min', deltaBins: 100,
  }), {});
  assert.equal(mergePositionDraftPatch(updated, rangeBinDeltaPatch(updated, {
    currentPrice: '100', binStep: 100, edge: 'min', deltaBins: 100,
  })), updated, 'a rejected movement must keep the draft used by the prepared preview');
  assert.equal(mergePositionDraftPatch(updated, { amountX: '0.02' }), updated);
});

test('retained chart viewport lets a range move before recentering and reverses canonical bins', () => {
  const initial = nextMeteoraChartBinViewport({ minBinId: 100, maxBinId: 169 });
  assert.deepEqual(initial, { minBinId: 97, maxBinId: 172 });
  const translated = nextMeteoraChartBinViewport({ minBinId: 102, maxBinId: 171 }, initial);
  assert.deepEqual(translated, initial);
  const escaped = nextMeteoraChartBinViewport({ minBinId: 104, maxBinId: 173 }, initial);
  assert.ok(escaped);
  assert.notDeepEqual(escaped, initial);
  const normal = rangeChartBinGeometry({
    activeBinId: 100, minBinId: 110, maxBinId: 169, viewport: initial!,
  });
  const inverted = rangeChartBinGeometry({
    activeBinId: 100, minBinId: 110, maxBinId: 169, viewport: initial!, inverted: true,
  });
  assert.ok(normal && inverted);
  assert.ok(normal.currentPercent < normal.minPercent, 'active marker stays outside an above-active range');
  assert.ok(inverted.currentPercent > inverted.maxPercent, 'inversion reverses the same canonical bins');
  assert.equal(normal.minPercent + inverted.maxPercent, 100);
  assert.equal(normal.maxPercent + inverted.minPercent, 100);
});

test('lower liquidity reads the entire retained viewport and bounds RPC windows', () => {
  const selected = { minBinId: 100, maxBinId: 169 };
  const retained = { minBinId: 97, maxBinId: 172 };
  assert.deepEqual(getMeteoraPoolLiquidityViewport(selected, retained), retained);
  assert.equal(getMeteoraPoolLiquidityViewport(selected, { minBinId: 0, maxBinId: 128 }), null);
});

test('a compact far range recovers real liquidity after a temporary oversized price edit', () => {
  const initial = nextMeteoraChartBinViewport({ minBinId: -69, maxBinId: 0 })!;
  const provisional = { minBinId: -69, maxBinId: 440 };
  const oversized = nextMeteoraChartBinViewport(provisional, initial)!;
  assert.equal(getMeteoraPoolLiquidityViewport(provisional, oversized), null);
  const selected = { minBinId: 411, maxBinId: 440 }; // 30 canonical bins at the far range.
  const recovered = nextMeteoraChartBinViewport(selected, oversized)!;
  assert.deepEqual(recovered, { minBinId: 408, maxBinId: 443 });
  assert.equal(recovered.maxBinId - recovered.minBinId + 1, 36);
  assert.deepEqual(getMeteoraPoolLiquidityViewport(selected, recovered), recovered);
  assert.deepEqual(nextMeteoraChartBinViewport({ minBinId: 412, maxBinId: 441 }, recovered), recovered,
    'normal dragging keeps the recovered viewport stable');
});

test('active SDK snapshot identity changes when price or active bin changes', () => {
  const original = getMeteoraPoolStateSnapshotKey({ poolAddress: 'pool', activeBinId: 10, activePrice: '100' });
  assert.notEqual(original, getMeteoraPoolStateSnapshotKey({ poolAddress: 'pool', activeBinId: 11, activePrice: '100' }));
  assert.notEqual(original, getMeteoraPoolStateSnapshotKey({ poolAddress: 'pool', activeBinId: 10, activePrice: '100.01' }));
  assert.equal(getMeteoraPoolStateSnapshotKey(null), null);
});

test('canonical bin gestures recover 70 bins after an over-wide edge and preserve width on shifts', () => {
  const poolState = {
    poolAddress: 'fixture', activeBinId: 0, activePrice: '76.33028516759326', binStep: 4,
    tokenX: { address: 'x', symbol: 'X', decimals: 9 }, tokenY: { address: 'y', symbol: 'Y', decimals: 6 }, refreshedAt: 'now',
  };
  const initial = {
    ...EMPTY_POSITION_DRAFT,
    requestedMinPrice: '76.33028516759326',
    requestedMaxPrice: '78.46591002409725',
  };
  const widened = mergePositionDraftPatch(initial, rangePoolBinDeltaPatch(initial, {
    poolState, edge: 'max', deltaBins: 1,
  }));
  assert.equal(resolveManualRangeForDisplay(poolState, widened.requestedMinPrice, widened.requestedMaxPrice).binCount, 71);
  const recovered = mergePositionDraftPatch(widened, rangePoolBinDeltaPatch(widened, {
    poolState, edge: 'max', deltaBins: -1,
  }));
  const recoveredRange = resolveManualRangeForDisplay(poolState, recovered.requestedMinPrice, recovered.requestedMaxPrice);
  assert.equal(recoveredRange.binCount, 70);
  assert.equal(recoveredRange.maxBinId, 69);
  const shifted = mergePositionDraftPatch(recovered, rangePoolBinShiftPatch(recovered, poolState, 5));
  const shiftedRange = resolveManualRangeForDisplay(poolState, shifted.requestedMinPrice, shifted.requestedMaxPrice);
  assert.equal(shiftedRange.binCount, 70);
  assert.equal(shiftedRange.minBinId, recoveredRange.minBinId + 5);
  assert.equal(shiftedRange.maxBinId, recoveredRange.maxBinId + 5);
});
