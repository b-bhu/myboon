import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveCashOutNow } from './portfolio-totals.js';

test('resolveCashOutNow: unknown (null) when loaded portfolio has no cashOutNow, never $0', () => {
  assert.equal(resolveCashOutNow(null), null);
  assert.equal(resolveCashOutNow({ summary: null }), null);
  assert.equal(resolveCashOutNow({ summary: {} }), null);
  assert.equal(resolveCashOutNow({ summary: { cashOutNow: 0 } }), 0);
  assert.equal(resolveCashOutNow({ summary: { cashOutNow: 42.5 } }), 42.5);
});
