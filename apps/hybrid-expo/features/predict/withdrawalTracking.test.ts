import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPreparedWithdrawal,
  markWithdrawalAmbiguous,
  markWithdrawalSubmitted,
  markWithdrawalSubmitting,
  persistWithdrawalTracking,
  reconcileWithdrawalTracking,
} from './withdrawalTracking';
import type { BridgeQuote } from './predict.api';

const quote: BridgeQuote = {
  quoteId: 'quote',
  estCheckoutTimeMs: 60_000,
  estInputUsd: 25,
  estOutputUsd: 24.99,
  estToTokenBaseUnit: '24990000',
  estFeeBreakdown: {
    appFeePercent: null, appFeeUsd: null, fillCostPercent: null, fillCostUsd: null,
    gasUsd: null, maxSlippage: null, minReceived: 24.98, swapImpact: 0.01,
    totalImpact: 0.04, totalImpactUsd: 0.01,
  },
};

test('accepted transfer timeout survives serialization and reconciles after restart', () => {
  const prepared = createPreparedWithdrawal({
    amount: 25,
    recipientAddress: 'solana-recipient',
    bridgeAddress: '0xbridge',
    quote,
    now: 1_000,
  });
  assert.equal(prepared.status, 'PREPARED');
  assert.equal(prepared.bridgeAddress, '0xbridge');

  const submitting = markWithdrawalSubmitting(prepared, 1_100);
  const submitted = markWithdrawalSubmitted(submitting, 'relayer-123', '0xhash', 1_200);
  const timedOut = markWithdrawalAmbiguous(submitted, 'Confirmation timed out.', 1_300);
  const restored = JSON.parse(JSON.stringify(timedOut)) as typeof timedOut;

  assert.equal(restored.status, 'AMBIGUOUS');
  assert.equal(restored.transactionId, 'relayer-123');
  assert.equal(restored.bridgeAddress, '0xbridge');

  const relayed = reconcileWithdrawalTracking(restored, [], {
    state: 'STATE_CONFIRMED',
    transactionId: 'relayer-123',
    transactionHash: '0xhash',
    errorMessage: null,
  }, 1_400);
  assert.equal(relayed.status, 'BRIDGING');

  const completed = reconcileWithdrawalTracking(relayed, [{
    status: 'COMPLETED',
    fromAmountBaseUnit: '25000000',
    txHash: '0xbridgehash',
    createdTimeMs: 2_000,
  }], null, 2_100);
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.transactionHash, '0xbridgehash');
});

test('only authoritative relayer or Bridge failure makes a withdrawal retryable', () => {
  const prepared = createPreparedWithdrawal({
    amount: 25, recipientAddress: 'recipient', bridgeAddress: '0xbridge', quote, now: 1_000,
  });
  const ambiguous = markWithdrawalAmbiguous(markWithdrawalSubmitting(prepared), 'Network lost');
  assert.equal(reconcileWithdrawalTracking(ambiguous, [], null).status, 'AMBIGUOUS');
  assert.equal(reconcileWithdrawalTracking(ambiguous, [], {
    state: 'STATE_FAILED', transactionId: 'relayer-1', transactionHash: null, errorMessage: 'reverted',
  }).status, 'FAILED');
});

test('stale or empty reconciliation cannot regress COMPLETED tracking', () => {
  const prepared = createPreparedWithdrawal({
    amount: 25, recipientAddress: 'recipient', bridgeAddress: '0xbridge', quote, now: 1_000,
  });
  const submitted = markWithdrawalSubmitted(markWithdrawalSubmitting(prepared), 'relayer-1', '0xhash');
  const bridging = reconcileWithdrawalTracking(submitted, [], {
    state: 'STATE_CONFIRMED', transactionId: 'relayer-1', transactionHash: '0xhash', errorMessage: null,
  }, 1_500);
  assert.equal(bridging.status, 'BRIDGING');
  assert.strictEqual(reconcileWithdrawalTracking(bridging, [], {
    state: 'STATE_NEW', transactionId: 'relayer-1', transactionHash: '0xhash', errorMessage: null,
  }, 1_600), bridging);

  const completed = reconcileWithdrawalTracking(bridging, [{
    status: 'COMPLETED', fromAmountBaseUnit: '25000000', createdTimeMs: 2_000,
  }], null, 2_100);

  assert.equal(completed.status, 'COMPLETED');
  assert.strictEqual(reconcileWithdrawalTracking(completed, [], null, 2_200), completed);
  assert.strictEqual(reconcileWithdrawalTracking(completed, [], {
    state: 'STATE_NEW', transactionId: 'relayer-1', transactionHash: '0xhash', errorMessage: null,
  }, 2_300), completed);
});

test('persistWithdrawalTracking returns false and logs once per failed attempt', async () => {
  const attempts: string[] = [];
  const delays: number[] = [];
  const logged: number[] = [];
  let calls = 0;
  const result = await persistWithdrawalTracking(
    async () => {
      calls += 1;
      attempts.push(`attempt-${calls}`);
      throw new Error('storage unavailable');
    },
    'predict.withdraw.tracking.v1:test',
    '{"status":"PREPARED"}',
    {
      sleep: async (ms) => {
        delays.push(ms);
      },
      onError: (_error, attempt) => {
        logged.push(attempt);
      },
    },
  );

  assert.equal(result, false);
  assert.equal(calls, 3);
  assert.deepEqual(attempts, ['attempt-1', 'attempt-2', 'attempt-3']);
  assert.deepEqual(logged, [1, 2, 3]);
  assert.deepEqual(delays, [500, 1000]);
});

test('persistWithdrawalTracking succeeds when a later retry works', async () => {
  let calls = 0;
  const logged: number[] = [];
  const result = await persistWithdrawalTracking(
    async () => {
      calls += 1;
      if (calls === 1) throw new Error('storage unavailable');
    },
    'predict.withdraw.tracking.v1:test',
    '{"status":"SUBMITTED"}',
    {
      sleep: async () => {},
      onError: (_error, attempt) => {
        logged.push(attempt);
      },
    },
  );

  assert.equal(result, true);
  assert.equal(calls, 2);
  assert.deepEqual(logged, [1]);
});

test('persistWithdrawalTracking succeeds first try without logging', async () => {
  let calls = 0;
  let logged = 0;
  const result = await persistWithdrawalTracking(
    async () => {
      calls += 1;
    },
    'predict.withdraw.tracking.v1:test',
    '{"status":"BRIDGING"}',
    {
      sleep: async () => {
        throw new Error('sleep must not run when the first attempt succeeds');
      },
      onError: () => {
        logged += 1;
      },
    },
  );

  assert.equal(result, true);
  assert.equal(calls, 1);
  assert.equal(logged, 0);
});

test('default onError warns with attempt and message but no payload', async () => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const result = await persistWithdrawalTracking(
      async () => {
        throw new Error('quota exceeded');
      },
      'predict.withdraw.tracking.v1:test',
      '{"status":"PREPARED"}',
      { retries: 1, sleep: async () => {} },
    );
    assert.equal(result, false);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  const [message, detail] = warnings[0] as [string, string];
  assert.match(message, /attempt 1/);
  assert.match(detail, /quota exceeded/);
  for (const arg of warnings[0] as string[]) {
    assert.ok(!arg.includes('status'));
  }
});
