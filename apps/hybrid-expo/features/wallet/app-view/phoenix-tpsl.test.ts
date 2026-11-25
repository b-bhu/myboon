/**
 * Pure test for the Phoenix Edit TP/SL sheet helpers (issue #851): P&L at a
 * price for long and short, empty or invalid input, both validation messages.
 *
 * Run: pnpm --filter hybrid-expo exec tsx --test features/wallet/app-view/phoenix-tpsl.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { pnlAtPrice, prefill, validateTpsl, TPSL_EMPTY_MESSAGE, TPSL_INVALID_MESSAGE } from './phoenix-tpsl';

const long = { side: 'long' as const, size: 2, entryPriceUsd: 150 };
const short = { side: 'short' as const, size: 2, entryPriceUsd: 150 };

describe('pnlAtPrice', () => {
  it('long: gains above entry, loses below', () => {
    assert.equal(pnlAtPrice(long, '175'), 50);
    assert.equal(pnlAtPrice(long, '140'), -20);
  });
  it('short: the sign is flipped for the same prices', () => {
    assert.equal(pnlAtPrice(short, '175'), -50);
    assert.equal(pnlAtPrice(short, '140'), 20);
  });
  it('is null for empty, invalid, non-positive input or an unknown entry', () => {
    assert.equal(pnlAtPrice(long, ''), null);
    assert.equal(pnlAtPrice(long, 'abc'), null);
    assert.equal(pnlAtPrice(long, '0'), null);
    assert.equal(pnlAtPrice({ ...long, entryPriceUsd: null }, '175'), null);
  });
});

describe('validateTpsl', () => {
  it('both empty gives the enter-a-price message', () => {
    assert.deepEqual(validateTpsl('', '  '), { ok: false, message: TPSL_EMPTY_MESSAGE });
  });
  it('zero or text gives the greater-than-zero message', () => {
    assert.deepEqual(validateTpsl('0', ''), { ok: false, message: TPSL_INVALID_MESSAGE });
    assert.deepEqual(validateTpsl('175', 'abc'), { ok: false, message: TPSL_INVALID_MESSAGE });
    assert.deepEqual(validateTpsl('-3', ''), { ok: false, message: TPSL_INVALID_MESSAGE });
  });
  it('returns the trimmed prices; an empty field stays null', () => {
    assert.deepEqual(validateTpsl(' 175.5 ', ''), { ok: true, takeProfit: '175.5', stopLoss: null });
    assert.deepEqual(validateTpsl('175', '140'), { ok: true, takeProfit: '175', stopLoss: '140' });
  });
});

describe('prefill', () => {
  it('shows the price, or empty when null', () => {
    assert.equal(prefill(175), '175');
    assert.equal(prefill(null), '');
  });
});
