import assert from 'node:assert/strict';
import test from 'node:test';
import { exchangeRateValue, formatBalance, swapSliderCopy } from './swap.display';
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

test('swapSliderCopy idle shows route, fees and time for a cross-chain swap', () => {
  assert.deepEqual(
    swapSliderCopy({
      state: 'idle',
      route: 'Solana → Base',
      fees: '$0.02',
      time: '~1s',
      action: 'Swipe to swap 1 SOL → 0.42 ETH',
    }),
    { small: 'Solana → Base · $0.02 fees · ~1s', strong: 'Swipe to swap 1 SOL → 0.42 ETH', feeSplit: null },
  );
});

test('swapSliderCopy idle same-chain swap shows the rate instead of fees and time', () => {
  assert.deepEqual(
    swapSliderCopy({
      state: 'idle',
      route: 'Jupiter',
      rate: '1 SOL = 142.3 USDC',
      fees: '$0.01',
      time: '~4s',
      action: 'Swipe to swap 1 SOL → 142.3 USDC',
    }),
    { small: 'Jupiter · 1 SOL = 142.3 USDC', strong: 'Swipe to swap 1 SOL → 142.3 USDC', feeSplit: null },
  );
});

test('swapSliderCopy idle without quote details falls back to the waiting line', () => {
  assert.deepEqual(
    swapSliderCopy({ state: 'idle', action: 'Swipe to swap for 142.3 USDC' }),
    { small: 'Route and fees update with the quote', strong: 'Swipe to swap for 142.3 USDC', feeSplit: null },
  );
});

test('swapSliderCopy idle exposes the fee split for the i button', () => {
  const copy = swapSliderCopy({
    state: 'idle',
    route: 'Solana → Base',
    fees: '$0.02',
    time: '~1s',
    action: 'Swipe to swap 1 SOL → 0.42 ETH',
    feeSplit: { execution: '$0.02', app: '$0.00', swap: '$0.01' },
  });
  assert.equal(copy.feeSplit, 'Exec $0.02 · App $0.00 · Swap $0.01');
});

test('swapSliderCopy pending shows the step and the step label', () => {
  assert.deepEqual(swapSliderCopy({ state: 'pending', step: 2, stepCount: 3, stepLabel: 'Confirm in your wallet' }), {
    small: 'Step 2 of 3',
    strong: 'Confirm in your wallet',
    feeSplit: null,
  });
});

test('swapSliderCopy done shows fees, time and the received amount', () => {
  assert.deepEqual(swapSliderCopy({ state: 'done', fees: '$0.02', time: '4s', received: '142.3 USDC' }), {
    small: 'Done · $0.02 fees · took 4s',
    strong: '+142.3 USDC received',
    feeSplit: null,
  });
});

test('swapSliderCopy failed shows the step and that the money is safe', () => {
  assert.deepEqual(swapSliderCopy({ state: 'failed', step: 2, stepCount: 3 }), {
    small: 'Step 2 of 3 failed · money is safe',
    strong: 'Tap to retry step 2',
    feeSplit: null,
  });
});

test('swapSliderCopy no-route shows the reason and the suggested chain', () => {
  assert.deepEqual(
    swapSliderCopy({ state: 'no-route', reason: 'Ethereum not supported yet', suggestion: 'Base' }),
    {
      small: 'No route · Ethereum not supported yet',
      strong: 'Tap to use Base',
      feeSplit: null,
    },
  );
  assert.deepEqual(swapSliderCopy({ state: 'no-route', reason: 'Ethereum not supported yet' }), {
    small: 'No route · Ethereum not supported yet',
    strong: 'Tap to switch to a supported chain',
    feeSplit: null,
  });
});
