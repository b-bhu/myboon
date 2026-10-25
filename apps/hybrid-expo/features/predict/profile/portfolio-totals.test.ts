import assert from 'node:assert/strict';
import test from 'node:test';
import { APPROX_TOTAL_NOTE, formatApproxTotal, formatShowingLabel } from './portfolio-totals';

test('no showing label at or under the cap, or without a summary', () => {
  assert.equal(formatShowingLabel(null), null);
  assert.equal(formatShowingLabel({ totalsPartial: false, totalPositionCount: 0 }), null);
  assert.equal(formatShowingLabel({ totalsPartial: false, totalPositionCount: 12 }), null);
  assert.equal(formatShowingLabel({ totalsPartial: false, totalPositionCount: 100 }), null);
});

test('over the cap shows the full count', () => {
  assert.equal(formatShowingLabel({ totalsPartial: false, totalPositionCount: 170 }), 'Showing 100 of 170');
});

test('partial totals add commas and a trailing +', () => {
  assert.equal(formatShowingLabel({ totalsPartial: true, totalPositionCount: 2628 }), 'Showing 100 of 2,628+');
});

test('approx marker only when partial', () => {
  assert.equal(formatApproxTotal('$1,234.56', { totalsPartial: false, totalPositionCount: 170 }), '$1,234.56');
  assert.equal(formatApproxTotal('$1,234.56', { totalsPartial: true, totalPositionCount: 2628 }), '≈ $1,234.56');
  assert.equal(formatApproxTotal('$1,234.56', null), '$1,234.56');
  assert.equal(formatApproxTotal('--', { totalsPartial: true, totalPositionCount: 2628 }), '--');
  assert.equal(APPROX_TOTAL_NOTE, 'Approximate: very large wallet');
});
