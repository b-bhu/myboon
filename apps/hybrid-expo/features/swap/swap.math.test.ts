import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatAtomicAmount,
  parseSlippagePercentToBps,
  parseUiAmountToAtomic,
  percentageOfAtomic,
} from './swap.math';

test('parses decimal UI amounts without floating point', () => {
  assert.equal(parseUiAmountToAtomic('10', 6), '10000000');
  assert.equal(parseUiAmountToAtomic('0.000001', 6), '1');
  assert.throws(() => parseUiAmountToAtomic('1e3', 6));
  assert.throws(() => parseUiAmountToAtomic('0.0000001', 6));
});

test('formats atomic amounts and preserves exact sell presets', () => {
  assert.equal(formatAtomicAmount('76420000', 6), '76.42');
  assert.equal(percentageOfAtomic('76420000', 25), '19105000');
  assert.equal(percentageOfAtomic('76420000', 50), '38210000');
  assert.equal(percentageOfAtomic('76420000', 75), '57315000');
  assert.equal(percentageOfAtomic('76420000', 100), '76420000');
});

test('converts bounded custom slippage to basis points exactly', () => {
  assert.equal(parseSlippagePercentToBps('0.5'), 50);
  assert.equal(parseSlippagePercentToBps('15.25'), 1525);
  assert.equal(parseSlippagePercentToBps('50'), 5000);
  assert.throws(() => parseSlippagePercentToBps('50.01'));
});
