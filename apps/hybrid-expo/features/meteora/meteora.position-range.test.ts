import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_POSITION_DRAFT, type MeteoraPositionDraft } from './meteora.form';
import {
  applyDefaultTokenRange,
  getPositionTokenMode,
  getRangeBarAllocation,
  getRangeBarWeight,
} from './meteora.position-range';

const bounds = { minPrice: '90', maxPrice: '110' };

function draft(overrides: Partial<MeteoraPositionDraft> = {}): MeteoraPositionDraft {
  return { ...EMPTY_POSITION_DRAFT, ...overrides };
}

test('classifies manual, Auto-Fill, explicit Zap, zero, and malformed amounts', () => {
  assert.equal(getPositionTokenMode(draft({ amountX: '1' })), 'x_only');
  assert.equal(getPositionTokenMode(draft({ amountY: '2' })), 'y_only');
  assert.equal(getPositionTokenMode(draft({ amountX: '1', amountY: '2' })), 'both');
  assert.equal(getPositionTokenMode(draft({ amountX: '0', amountY: '' })), 'none');
  assert.equal(getPositionTokenMode(draft({ autoFill: true, amountX: '1' })), 'both');
  assert.equal(getPositionTokenMode(draft({ autoFill: true, amountX: '1', amountY: '2' })), 'both');
  assert.equal(getPositionTokenMode(draft({ amountX: '1e3' })), 'none');
  assert.equal(getPositionTokenMode(draft({ fundingMode: 'single', singleTokenSide: 'x', autoFill: true, amountX: '1' })), 'both');
  assert.equal(getPositionTokenMode(draft({ fundingMode: 'single', singleTokenSide: 'x', amountX: '1', amountY: '2' })), 'both');
  assert.equal(getPositionTokenMode(draft({ fundingMode: 'single', singleTokenSide: 'x', amountY: '2' })), 'none');
  assert.equal(getPositionTokenMode(draft({ fundingMode: 'single', singleTokenSide: 'x', amountX: '1', amountY: '-2' })), 'none');
  assert.equal(getPositionTokenMode(draft({ autoFill: true, amountX: '1', amountY: '0' })), 'both');
  assert.equal(getPositionTokenMode(draft({ amountX: '1', amountY: '0.0000000' })), 'none');
  assert.equal(getPositionTokenMode(draft({ autoFill: true, amountX: '1', amountY: '2' }), 9, 6, true), 'both');
});

test('defaults orient a one-token range around the canonical current price', () => {
  const xOnly = applyDefaultTokenRange({
    draft: draft({ amountX: '1' }), currentPrice: '100', bounds,
    rangeEdited: false, fixedRange: false, tokenXDecimals: 9, tokenYDecimals: 6,
  });
  assert.deepEqual([xOnly.requestedMinPrice, xOnly.requestedMaxPrice], ['100', '110']);

  const yOnly = applyDefaultTokenRange({
    draft: draft({ amountY: '2' }), currentPrice: '100', bounds,
    rangeEdited: false, fixedRange: false, tokenXDecimals: 9, tokenYDecimals: 6,
  });
  assert.deepEqual([yOnly.requestedMinPrice, yOnly.requestedMaxPrice], ['90', '100']);

  const both = applyDefaultTokenRange({
    draft: draft({ amountX: '1', amountY: '2' }), currentPrice: '100', bounds,
    rangeEdited: false, fixedRange: false, tokenXDecimals: 9, tokenYDecimals: 6,
  });
  assert.deepEqual([both.requestedMinPrice, both.requestedMaxPrice], ['90', '110']);
  const none = applyDefaultTokenRange({
    draft: draft(), currentPrice: '100', bounds,
    rangeEdited: false, fixedRange: false, tokenXDecimals: 9, tokenYDecimals: 6,
  });
  assert.deepEqual([none.requestedMinPrice, none.requestedMaxPrice], ['90', '110']);
});

test('range defaults transition with funding changes and preserve exact prices', () => {
  const currentPrice = '100.123456789';
  const exactBounds = { minPrice: '90.0001', maxPrice: '110.9999' };
  const options = { currentPrice, bounds: exactBounds, rangeEdited: false, fixedRange: false, tokenXDecimals: 9, tokenYDecimals: 6 };
  const xOnly = applyDefaultTokenRange({ ...options, draft: draft({ amountX: '1' }) });
  assert.deepEqual([xOnly.requestedMinPrice, xOnly.requestedMaxPrice], [currentPrice, exactBounds.maxPrice]);
  const both = applyDefaultTokenRange({ ...options, draft: { ...xOnly, amountY: '2' } });
  assert.deepEqual([both.requestedMinPrice, both.requestedMaxPrice], [exactBounds.minPrice, exactBounds.maxPrice]);
  const yOnly = applyDefaultTokenRange({ ...options, draft: { ...both, amountX: '' } });
  assert.deepEqual([yOnly.requestedMinPrice, yOnly.requestedMaxPrice], [exactBounds.minPrice, currentPrice]);
  const autoFill = applyDefaultTokenRange({ ...options, draft: { ...yOnly, autoFill: true, amountX: '1', amountY: '' } });
  assert.deepEqual([autoFill.requestedMinPrice, autoFill.requestedMaxPrice], [exactBounds.minPrice, exactBounds.maxPrice]);

  const edited = { ...yOnly, requestedMinPrice: '97', requestedMaxPrice: '103' };
  const preserved = applyDefaultTokenRange({ ...options, draft: { ...edited, amountX: '1', amountY: '2' }, rangeEdited: true });
  assert.deepEqual([preserved.requestedMinPrice, preserved.requestedMaxPrice], ['97', '103']);
  const reset = applyDefaultTokenRange({ ...options, draft: { ...edited, amountX: '1', amountY: '' }, rangeEdited: false });
  assert.deepEqual([reset.requestedMinPrice, reset.requestedMaxPrice], [currentPrice, exactBounds.maxPrice]);
});

test('preserves edited, fixed, missing, and invalid ranges by object identity', () => {
  const source = draft({ amountX: '1', requestedMinPrice: '88', requestedMaxPrice: '108' });
  for (const patch of [
    { rangeEdited: true, fixedRange: false },
    { rangeEdited: false, fixedRange: true },
    { rangeEdited: false, fixedRange: false, currentPrice: null },
    { rangeEdited: false, fixedRange: false, bounds: null },
    { rangeEdited: false, fixedRange: false, bounds: { minPrice: '110', maxPrice: '90' } },
    { rangeEdited: false, fixedRange: false, currentPrice: '120' },
  ]) {
    const result = applyDefaultTokenRange({
      draft: source, currentPrice: '100', bounds,
      tokenXDecimals: 9, tokenYDecimals: 6, ...patch,
    });
    assert.equal(result, source);
  }
});

test('refreshed defaults follow a moved pool price for mode changes and reset', () => {
  const original = applyDefaultTokenRange({
    draft: draft({ amountX: '1' }), currentPrice: '100', bounds,
    rangeEdited: false, fixedRange: false, tokenXDecimals: 9, tokenYDecimals: 6,
  });
  const refreshed = {
    currentPrice: '200.123456789', bounds: { minPrice: '190', maxPrice: '210' },
    rangeEdited: false, fixedRange: false, tokenXDecimals: 9, tokenYDecimals: 6,
  };
  const moved = applyDefaultTokenRange({ ...refreshed, draft: original });
  assert.deepEqual([moved.requestedMinPrice, moved.requestedMaxPrice], [refreshed.currentPrice, '210']);
  const changedMode = applyDefaultTokenRange({ ...refreshed, draft: { ...moved, amountX: '', amountY: '1' } });
  assert.deepEqual([changedMode.requestedMinPrice, changedMode.requestedMaxPrice], ['190', refreshed.currentPrice]);
  const custom = { ...changedMode, requestedMinPrice: '185', requestedMaxPrice: '205' };
  assert.equal(applyDefaultTokenRange({ ...refreshed, draft: custom, rangeEdited: true }), custom);
  const reset = applyDefaultTokenRange({ ...refreshed, draft: custom });
  assert.deepEqual([reset.requestedMinPrice, reset.requestedMaxPrice], ['190', refreshed.currentPrice]);
});

test('maps funded ranges to canonical token sides and normalizes strategy positions', () => {
  const xAtCurrent = getRangeBarAllocation({
    mode: 'x_only', inverted: false, minPercent: 20, maxPercent: 80, currentPercent: 50, barPercent: 50,
  });
  assert.deepEqual(xAtCurrent, { token: 'x', normalizedPosition: 0 });
  assert.deepEqual(getRangeBarAllocation({
    mode: 'x_only', inverted: false, minPercent: 20, maxPercent: 80, currentPercent: 50, barPercent: 35,
  }), { token: null, normalizedPosition: 0 });
  assert.deepEqual(getRangeBarAllocation({
    mode: 'y_only', inverted: false, minPercent: 20, maxPercent: 80, currentPercent: 50, barPercent: 35,
  }), { token: 'y', normalizedPosition: 0.5 });
  assert.deepEqual(getRangeBarAllocation({
    mode: 'x_only', inverted: true, minPercent: 20, maxPercent: 80, currentPercent: 50, barPercent: 35,
  }), { token: 'x', normalizedPosition: 0.5 });
  assert.deepEqual(getRangeBarAllocation({
    mode: 'y_only', inverted: true, minPercent: 20, maxPercent: 80, currentPercent: 50, barPercent: 65,
  }), { token: 'y', normalizedPosition: 0.5 });
  assert.deepEqual(getRangeBarAllocation({
    mode: 'both', inverted: false, minPercent: 20, maxPercent: 80, currentPercent: 50, barPercent: 50,
  }), { token: 'x', normalizedPosition: 0 });
  assert.deepEqual(getRangeBarAllocation({
    mode: 'none', inverted: false, minPercent: 20, maxPercent: 80, currentPercent: 50, barPercent: 50,
  }), { token: null, normalizedPosition: 0 });
});

test('does not color wholly opposite-side ranges and keeps both-token ranges on one side', () => {
  const cases = [
    { mode: 'x_only' as const, inverted: false, currentPercent: 80, sameCurrent: 10 },
    { mode: 'x_only' as const, inverted: true, currentPercent: 10, sameCurrent: 90 },
    { mode: 'y_only' as const, inverted: false, currentPercent: 10, sameCurrent: 90 },
    { mode: 'y_only' as const, inverted: true, currentPercent: 80, sameCurrent: 10 },
  ];
  for (const item of cases) {
    for (const barPercent of [20, 30, 40]) {
      assert.equal(getRangeBarAllocation({
        mode: item.mode, inverted: item.inverted, minPercent: 20, maxPercent: 40,
        currentPercent: item.currentPercent, barPercent,
      }).token, null);
    }
    const first = getRangeBarAllocation({
      mode: item.mode, inverted: item.inverted, minPercent: 20, maxPercent: 40,
      currentPercent: item.sameCurrent, barPercent: 20,
    });
    const last = getRangeBarAllocation({
      mode: item.mode, inverted: item.inverted, minPercent: 20, maxPercent: 40,
      currentPercent: item.sameCurrent, barPercent: 40,
    });
    assert.equal(first.token, item.mode === 'x_only' ? 'x' : 'y');
    assert.equal(last.token, item.mode === 'x_only' ? 'x' : 'y');
    const firstPosition = item.mode === 'x_only' && !item.inverted || item.mode === 'y_only' && item.inverted ? 0 : 1;
    assert.equal(first.normalizedPosition, firstPosition);
    assert.equal(last.normalizedPosition, 1 - firstPosition);
  }

  for (const [inverted, current, expected] of [
    [false, 10, 'x'], [false, 90, 'y'], [true, 10, 'y'], [true, 90, 'x'],
  ] as const) {
    assert.equal(getRangeBarAllocation({
      mode: 'both', inverted, minPercent: 20, maxPercent: 40, currentPercent: current, barPercent: 30,
    }).token, expected);
  }
  assert.equal(getRangeBarAllocation({
    mode: 'both', inverted: false, minPercent: 20, maxPercent: 40, currentPercent: 50, barPercent: 10,
  }).token, null);
});

test('active-bin equality remains finite at either range endpoint', () => {
  for (const mode of ['x_only', 'y_only'] as const) {
    for (const inverted of [false, true]) {
      for (const currentPercent of [20, 40]) {
        assert.deepEqual(getRangeBarAllocation({
          mode, inverted, minPercent: 20, maxPercent: 40,
          currentPercent, barPercent: currentPercent,
        }), { token: mode === 'x_only' ? 'x' : 'y', normalizedPosition: 0 });
      }
    }
  }
});

test('directional strategies shape from the active price toward the funded edge', () => {
  assert.ok(getRangeBarWeight('curve', 0) > getRangeBarWeight('curve', 1));
  assert.ok(getRangeBarWeight('bid_ask', 0) < getRangeBarWeight('bid_ask', 1));
  assert.ok(getRangeBarWeight('spot', 0) > 0);
  assert.equal(getRangeBarWeight('spot', 0), getRangeBarWeight('spot', 1));
});
