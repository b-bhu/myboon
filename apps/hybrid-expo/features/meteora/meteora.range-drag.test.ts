import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_POSITION_DRAFT } from './meteora.form';
import { mergePositionDraftPatch, rangeBinDeltaPatch } from './meteora.position-form';
import { rangeDragDelta, rangeShiftPatch } from './meteora.range-drag';

const draft = {
  ...EMPTY_POSITION_DRAFT, amountX: '0.02', amountY: '10',
  requestedMinPrice: '95', requestedMaxPrice: '105',
};

test('center drag shifts both bounds by the same bins and preserves token amounts', () => {
  const shifted = mergePositionDraftPatch(draft, rangeShiftPatch(draft, 100, 3));
  assert.ok(Math.abs(Number(shifted.requestedMinPrice) - 95 * 1.01 ** 3) < 1e-9);
  assert.ok(Math.abs(Number(shifted.requestedMaxPrice) - 105 * 1.01 ** 3) < 1e-9);
  assert.ok(Math.abs(Number(shifted.requestedMaxPrice) / Number(shifted.requestedMinPrice) - 105 / 95) < 1e-10);
  assert.deepEqual([shifted.amountX, shifted.amountY], [draft.amountX, draft.amountY]);
  const returned = mergePositionDraftPatch(shifted, rangeShiftPatch(shifted, 100, -3));
  assert.ok(Math.abs(Number(returned.requestedMinPrice) - 95) < 1e-9);
  assert.ok(Math.abs(Number(returned.requestedMaxPrice) - 105) < 1e-9);
});

test('queued center movements use the latest selected window', () => {
  const shifted = [1, 2, -1].reduce((current, delta) => (
    mergePositionDraftPatch(current, rangeShiftPatch(current, 100, delta))
  ), draft);
  assert.ok(Math.abs(Number(shifted.requestedMinPrice) - 95 * 1.01 ** 2) < 1e-9);
  assert.ok(Math.abs(Number(shifted.requestedMaxPrice) - 105 * 1.01 ** 2) < 1e-9);
});

test('rejected movements do not consume drag steps or invalidate the draft', () => {
  let applied = 0;
  let current = draft;
  const move = (bins: number) => {
    const delta = rangeDragDelta(bins * 300 * 0.94 / 68, 300, 68, applied);
    const next = mergePositionDraftPatch(current, rangeBinDeltaPatch(current, {
      currentPrice: '100', binStep: 100, edge: 'min', deltaBins: delta,
    }));
    if (next !== current) applied += delta;
    current = next;
  };
  move(5);
  const accepted = current;
  move(20); // This would cross the maximum price, so it is rejected.
  assert.equal(current, accepted);
  move(0);
  assert.ok(Math.abs(Number(current.requestedMinPrice) - 95) < 1e-9);
  assert.equal(current.requestedMaxPrice, '105');
  for (const delta of [0, NaN, Infinity, 0.5]) {
    assert.equal(mergePositionDraftPatch(draft, rangeShiftPatch(draft, 100, delta)), draft);
  }
  assert.deepEqual(rangeShiftPatch({ ...draft, requestedMinPrice: '110' }, 100, 1), {});
});

test('drag scale stays tied to the gesture start and accepted movement', () => {
  const width = 300;
  const first = rangeDragDelta(width * 0.94 / 68 * 5, width, 68, 0);
  assert.equal(first, 5);
  const second = rangeDragDelta(width * 0.94 / 68 * 8, width, 68, first);
  assert.equal(second, 3);
  assert.equal(rangeDragDelta(NaN, width, 68, 0), 0);
  assert.equal(rangeDragDelta(10, 0, 68, 0), 0);
});
