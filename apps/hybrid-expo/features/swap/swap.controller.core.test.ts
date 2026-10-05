import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSwapSession,
  endSwapSession,
  invalidatePreparedSession,
} from './swap.controller.core';
import { exchangeRate } from './swap.display';

test('ending a swap session clears elevated slippage and prepared review while preserving request sequencing', () => {
  const active = {
    ...createSwapSession(),
    slippageMode: 'custom' as const,
    customSlippage: '8',
    extremeConfirmation: 'CONFIRM',
    simulationWarningAccepted: true,
    preparedRequestId: 'order-1',
    asyncSequence: 4,
  };
  const ended = endSwapSession(active);
  assert.deepEqual(ended, {
    slippageMode: 'auto',
    customSlippage: '0.5',
    extremeConfirmation: '',
    simulationWarningAccepted: false,
    preparedRequestId: null,
    asyncSequence: 5,
  });
});

test('prepared review invalidation advances the stale async boundary', () => {
  const prepared = {
    ...createSwapSession(),
    preparedRequestId: 'order-2',
    simulationWarningAccepted: true,
    asyncSequence: 4,
  };
  const invalidated = invalidatePreparedSession(prepared);
  assert.equal(invalidated.preparedRequestId, null);
  assert.equal(invalidated.simulationWarningAccepted, false);
  assert.equal(invalidated.asyncSequence, 5);
});

test('exchange rate normalizes atomic amounts and decimals', () => {
  assert.equal(
    exchangeRate(
      {
        inputMint: 'in',
        outputMint: 'out',
        inAmountAtomic: '2000000000',
        outAmountAtomic: '300000000',
        kind: 'quote',
        requestId: 'r',
        minimumOutAmountAtomic: '1',
        inUsdValue: null,
        outUsdValue: null,
        priceImpactPct: null,
        slippageBps: 50,
        router: 'unknown',
        route: [],
        fees: {
          providerFeeBps: null,
          providerFeeAtomic: null,
          providerFeeMint: null,
          signatureFeeLamports: null,
          priorityFeeLamports: null,
          rentFeeLamports: null,
          myboonFeeAtomic: '0',
          gasless: false,
        },
        expiresAt: null,
        taker: null,
        transaction: null,
        lastValidBlockHeight: null,
      },
      { address: 'in', symbol: 'SOL', name: 'SOL', decimals: 9 },
      { address: 'out', symbol: 'USDC', name: 'USDC', decimals: 6 },
    ),
    '1 SOL = 150 USDC',
  );
});
