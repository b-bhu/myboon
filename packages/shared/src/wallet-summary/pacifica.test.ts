import assert from 'node:assert/strict';
import test from 'node:test';

import { pacificaUnrealizedPnl, safeNum } from './pacifica.js';

test('safeNum passes finite numbers through', () => {
  assert.equal(safeNum(0), 0);
  assert.equal(safeNum(2.5), 2.5);
  assert.equal(safeNum(-3), -3);
});

test('safeNum parses numeric strings', () => {
  assert.equal(safeNum('4.25'), 4.25);
  assert.equal(safeNum('4.25 '), 4.25);
});

test('safeNum maps everything non-numeric to 0 (String() semantics pinned)', () => {
  assert.equal(safeNum(null), 0);
  assert.equal(safeNum(undefined), 0);
  assert.equal(safeNum('NaN'), 0);
  assert.equal(safeNum('not-a-number'), 0);
  assert.equal(safeNum(true), 0); // String(true) -> 'true'
  assert.equal(safeNum({ ui: '1' }), 0); // String({...}) -> '[object Object]'
});

test('unrealized PnL is (mark - entry) * size * direction', () => {
  assert.equal(pacificaUnrealizedPnl(10, 12, 3, 1), 6); // long gains
  assert.equal(pacificaUnrealizedPnl(10, 8, 3, 1), -6); // long loses
  assert.equal(pacificaUnrealizedPnl(10, 8, 3, -1), 6); // short gains
  assert.equal(pacificaUnrealizedPnl(10, 12, 3, -1), -6); // short loses
  assert.equal(pacificaUnrealizedPnl(10, 10, 3, 1), 0); // breakeven
  assert.equal(pacificaUnrealizedPnl(10, 10, 0, 1), 0); // flat
});
