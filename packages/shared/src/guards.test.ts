import assert from 'node:assert/strict';
import test from 'node:test';

import { asRecord, asString, isRecord, toNumber } from './guards.js';

/**
 * Pins the one canonical behavior of the shared guards (issue #896): a file's
 * private copy is only replaced by these when it matches on every input here;
 * a copy that differs on any of them keeps a renamed local function instead.
 */

test('isRecord accepts non-null plain objects and rejects null, arrays and primitives', () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isRecord(new Date()), true); // any non-array object passes
  assert.equal(isRecord(null), false);
  assert.equal(isRecord(undefined), false);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(['a']), false);
  assert.equal(isRecord('x'), false);
  assert.equal(isRecord(42), false);
  assert.equal(isRecord(true), false);
  assert.equal(isRecord(() => {}), false); // typeof 'function', excluded
});

test('isRecord narrows the type to Record<string, unknown>', () => {
  const value: unknown = { a: 1 };
  if (isRecord(value)) {
    const narrowed: Record<string, unknown> = value;
    assert.equal(narrowed['a'], 1);
  } else {
    assert.fail('isRecord did not narrow a plain object');
  }
});

test('asRecord maps non-null non-array objects to themselves and everything else to null', () => {
  const record = asRecord({ a: 1 });
  assert.notEqual(record, null);
  if (record) assert.equal(record['a'], 1);
  const date = asRecord(new Date()); // any non-array object passes
  assert.ok(date instanceof Date);
  assert.equal(asRecord(null), null);
  assert.equal(asRecord(undefined), null);
  assert.equal(asRecord([]), null);
  assert.equal(asRecord('x'), null);
  assert.equal(asRecord(42), null);
  assert.equal(asRecord(true), null);
  assert.equal(asRecord(() => {}), null);
});

test('asString passes non-blank strings verbatim, stringifies finite numbers, nulls everything else', () => {
  assert.equal(asString('x'), 'x');
  assert.equal(asString('  x  '), '  x  '); // verbatim, never trimmed
  assert.equal(asString('42'), '42'); // numeric strings are just strings
  assert.equal(asString(''), null);
  assert.equal(asString('   '), null); // blank after trim
  assert.equal(asString(42), '42'); // String() of a finite number
  assert.equal(asString(42.5), '42.5');
  assert.equal(asString(-0.5), '-0.5');
  assert.equal(asString(NaN), null);
  assert.equal(asString(Infinity), null);
  assert.equal(asString(0), '0');
  assert.equal(asString(null), null);
  assert.equal(asString(undefined), null);
  assert.equal(asString(true), null);
  assert.equal(asString([]), null);
  assert.equal(asString({}), null);
});

test("toNumber passes finite numbers and parses numeric strings, nulls NaN, blanks, records and arrays", () => {
  assert.equal(toNumber(42), 42);
  assert.equal(toNumber(42.5), 42.5);
  assert.equal(toNumber(-0.5), -0.5);
  assert.equal(toNumber(NaN), null);
  assert.equal(toNumber(Infinity), null);
  assert.equal(toNumber(-Infinity), null);
  assert.equal(toNumber('42'), 42);
  assert.equal(toNumber('42.5'), 42.5);
  assert.equal(toNumber('  42.5  '), 42.5); // parseFloat ignores surrounding whitespace
  assert.equal(toNumber('12abc'), 12); // parseFloat prefix rule, pinned deliberately
  assert.equal(toNumber('1e3'), 1000);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber('   '), null);
  assert.equal(toNumber('abc'), null);
  assert.equal(toNumber('NaN'), null);
  assert.equal(toNumber('Infinity'), null);
  assert.equal(toNumber(null), null);
  assert.equal(toNumber(undefined), null);
  assert.equal(toNumber(true), null);
  assert.equal(toNumber([]), null);
  assert.equal(toNumber({ ui: '42' }), null); // records are not amounts here
});
