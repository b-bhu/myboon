import assert from 'node:assert/strict';
import test from 'node:test';
import { exchangeRateValue, formatBalance } from './swap.display';
import type { SwapOrderResponse, SwapToken } from './swap.types';

const input: SwapToken = {
  address: 'input',
  symbol: 'IN',
  name: 'Input',
  decimals: 6,
};
const output: SwapToken = {
  address: 'output',
  symbol: 'OUT',
  name: 'Output',
  decimals: 9,
};

test('formatBalance keeps exact atomic values and always shows three decimals', () => {
  assert.equal(formatBalance(undefined, 6), '—');
  assert.equal(formatBalance('0', 6), '0.000');
  assert.equal(formatBalance('123456789', 6), '123.456');
  assert.equal(formatBalance('1', 6), '0.000');
  assert.equal(formatBalance('123456789012345678901234567890', 6), '123456789012345678901234.567');
});

test('exchangeRateValue returns a numeric rate only for the matching pair', () => {
  const order = {
    inputMint: input.address,
    outputMint: output.address,
    inAmountAtomic: '1000000',
    outAmountAtomic: '2000000000',
  } as SwapOrderResponse;

  assert.equal(exchangeRateValue(order, input, output), 2);
  assert.equal(exchangeRateValue(order, output, input), null);
});
