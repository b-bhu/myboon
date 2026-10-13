import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canCompleteTrackedDeposit,
  classifyDepositStatusCheck,
  latestDepositTransaction,
  matchingDepositTransactions,
  persistDepositTracking,
  statusViewToPersist,
  type PersistableDepositStatusView,
  type TrackedDepositEvidence,
} from './depositTracking';
import type { ClobBalance, DepositBridgeTransaction } from './predict.api';

const tracked: TrackedDepositEvidence = {
  chainId: '137',
  tokenAddress: '0xUSDC',
  tokenDecimals: 6,
  destinationChainId: '137',
  destinationTokenAddress: '0xpUSD',
  intendedAmount: 25,
  baselineTransactionKeys: [],
  hasStatusSnapshot: true,
  startedAt: 1_000_000,
};

const matching: DepositBridgeTransaction = {
  fromChainId: '137',
  fromTokenAddress: '0xusdc',
  fromAmountBaseUnit: '25000000',
  toChainId: '137',
  toTokenAddress: '0xpusd',
  status: 'PROCESSING',
  createdTimeMs: 1_001_000,
  txHash: 'matching',
};

test('matching spendable balance credit completes even while Bridge status lags', () => {
  assert.equal(canCompleteTrackedDeposit(25, 25, null), true);
  assert.equal(canCompleteTrackedDeposit(24.6, 25, { ...matching, status: 'FAILED' }), true);
  assert.equal(canCompleteTrackedDeposit(25, 25, { ...matching, status: 'PROCESSING' }), true);
});

test('an unrelated small balance increase does not complete deposit tracking', () => {
  assert.equal(canCompleteTrackedDeposit(1, 25, null), false);
  assert.equal(canCompleteTrackedDeposit(1, 25, { ...matching, status: 'PROCESSING' }), false);
});

test('deposit evidence must match chain, token, amount, and tracking window', () => {
  const transactions = [
    { ...matching, fromChainId: '1', txHash: 'wrong-chain' },
    { ...matching, fromTokenAddress: '0xother', txHash: 'wrong-token' },
    { ...matching, fromAmountBaseUnit: '20000000', txHash: 'wrong-amount' },
    { ...matching, toTokenAddress: '0xother', txHash: 'wrong-destination' },
    { ...matching, createdTimeMs: 900_000, txHash: 'old' },
    matching,
  ];
  assert.deepEqual(matchingDepositTransactions(transactions, tracked), [matching]);
});

test('matching completed Bridge evidence completes when balance polling is unavailable', () => {
  const transaction = latestDepositTransaction(matchingDepositTransactions([{
    ...matching,
    status: 'COMPLETED',
  }], tracked));
  assert.equal(canCompleteTrackedDeposit(null, 25, transaction), true);
});

test('matching PROCESSING deposit plus unrelated balance increase does not complete', () => {
  const transaction = latestDepositTransaction(matchingDepositTransactions([matching], tracked));
  assert.equal(transaction?.status, 'PROCESSING');
  assert.equal(canCompleteTrackedDeposit(1, 25, transaction), false);
});

// --- persistDepositTracking --------------------------------------------------

test('save failure logs every attempt and returns false after retries', async () => {
  const delays: number[] = [];
  const failures: string[] = [];
  let calls = 0;
  const saved = await persistDepositTracking(
    () => {
      calls += 1;
      return Promise.reject(new Error('disk full'));
    },
    'storage-key',
    'payload',
    {
      retries: 3,
      baseDelayMs: 500,
      sleep: async (ms) => {
        delays.push(ms);
      },
      onError: (message) => {
        failures.push(message);
      },
    },
  );
  assert.equal(saved, 'failed', 'exhausted retries report failure for the user');
  assert.equal(calls, 3);
  assert.equal(delays.length, 2, 'no sleep after the final attempt');
  assert.deepEqual(delays, [500, 1000]);
  assert.equal(failures.length, 3);
  assert.ok(failures.every((message) => message.includes('attempt 1/3') || message.includes('attempt 2/3') || message.includes('attempt 3/3')));
  assert.ok(failures.every((message) => message.includes('disk full')));
  // The storage key and payload must never reach the log line.
  assert.ok(failures.every((message) => !message.includes('storage-key') && !message.includes('payload')));
});

test('fail-then-succeed save retries and returns true', async () => {
  let calls = 0;
  const delays: number[] = [];
  const saved = await persistDepositTracking(
    () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('busy')) : Promise.resolve();
    },
    'storage-key',
    'payload',
    {
      retries: 3,
      baseDelayMs: 500,
      sleep: async (ms) => {
        delays.push(ms);
      },
      onError: () => {},
    },
  );
  assert.equal(saved, 'confirmed', 'a landed write is confirmed');
  assert.equal(calls, 2);
  assert.deepEqual(delays, [500]);
});

test('a successful first save never logs or sleeps', async () => {
  let calls = 0;
  const failures: string[] = [];
  const saved = await persistDepositTracking(
    () => {
      calls += 1;
      return Promise.resolve();
    },
    'storage-key',
    'payload',
    {
      retries: 3,
      baseDelayMs: 500,
      sleep: async () => {
        throw new Error('no retry expected');
      },
      onError: (message) => {
        failures.push(message);
      },
    },
  );
  assert.equal(saved, 'confirmed', 'first-try success is confirmed');
  assert.equal(calls, 1);
  assert.deepEqual(failures, []);
});

// --- persistDepositTracking (superseded saves) --------------------------------

test('a superseded save stops before the next attempt and never writes again', async () => {
  let calls = 0;
  const failures: string[] = [];
  let continueSaving = true;
  const result = await persistDepositTracking(
    () => {
      calls += 1;
      return Promise.reject(new Error('busy'));
    },
    'storage-key',
    'payload',
    {
      retries: 3,
      baseDelayMs: 500,
      // While this older save waits out its backoff, a newer save starts and
      // supersedes it; the gate must stop the loop before attempt 2.
      sleep: async () => {
        continueSaving = false;
      },
      onError: (message) => {
        failures.push(message);
      },
      shouldContinue: () => continueSaving,
    },
  );
  assert.equal(result, 'superseded');
  assert.equal(calls, 1, 'a superseded save must not call setItem again');
  assert.equal(failures.length, 1);
});

test('the cancel gate is checked before every attempt and around the sleep', async () => {
  const events: string[] = [];
  let calls = 0;
  let newerSaveStarted = false;
  const result = await persistDepositTracking(
    () => {
      calls += 1;
      events.push(`attempt-${calls}`);
      return Promise.reject(new Error('offline'));
    },
    'storage-key',
    'payload',
    {
      retries: 3,
      baseDelayMs: 100,
      sleep: async () => {
        events.push('sleep');
        // A newer save starts during the backoff wait.
        newerSaveStarted = true;
      },
      onError: () => {},
      shouldContinue: () => !newerSaveStarted,
    },
  );
  assert.equal(result, 'superseded');
  assert.equal(calls, 1, 'the gate became false during the wait: no second attempt');
  assert.deepEqual(events, ['attempt-1', 'sleep']);
});

test('an older generation cannot overwrite a newer one', async () => {
  const stored = new Map<string, string>();
  const setItem = (key: string, value: string): Promise<void> => {
    stored.set(key, value);
    return Promise.resolve();
  };
  // Older save keeps retrying through a still-failing store.
  const olderSave = persistDepositTracking(
    () => {
      // Succeeds only once the newer save has already landed its value.
      if (stored.get('key') === 'newer') return Promise.resolve();
      return Promise.reject(new Error('still busy'));
    },
    'key',
    'older',
    {
      retries: 5,
      baseDelayMs: 1,
      sleep: async () => {},
      onError: () => {},
      shouldContinue: () => stored.get('key') !== 'newer',
    },
  );
  const newerSave = persistDepositTracking(setItem, 'key', 'newer', {
    retries: 1,
    sleep: async () => {},
    onError: () => {},
  });
  const [olderResult, newerResult] = await Promise.all([olderSave, newerSave]);
  assert.equal(newerResult, 'confirmed');
  assert.equal(olderResult, 'superseded');
  assert.equal(stored.get('key'), 'newer', 'the stale save must never land after the fresh one');
});

test('superseded is not reported as failure, and a gate closing before the first attempt writes nothing', async () => {
  let writes = 0;
  const failures: string[] = [];
  const result = await persistDepositTracking(
    () => {
      writes += 1;
      return Promise.resolve();
    },
    'storage-key',
    'payload',
    {
      retries: 2,
      baseDelayMs: 10,
      sleep: async () => {
        throw new Error('unexpected sleep');
      },
      onError: (message) => {
        failures.push(message);
      },
      shouldContinue: () => false,
    },
  );
  assert.equal(result, 'superseded');
  assert.notEqual(result, 'failed');
  assert.equal(writes, 0);
  assert.deepEqual(failures, []);
});

// --- statusViewToPersist -------------------------------------------------------

test('a retryable error status view is never persisted', () => {
  const retryableError: PersistableDepositStatusView = {
    tone: 'error',
    retryable: true,
  };
  assert.equal(statusViewToPersist(retryableError), null);
});

test('a non-retryable status view is persisted', () => {
  const failedDeposit: PersistableDepositStatusView = { tone: 'error' };
  assert.equal(statusViewToPersist(failedDeposit), failedDeposit);
  const explicitlyNonRetryable: PersistableDepositStatusView = {
    tone: 'error',
    retryable: false,
  };
  assert.equal(statusViewToPersist(explicitlyNonRetryable), explicitlyNonRetryable);
});

test('normal status views are persisted', () => {
  const waiting: PersistableDepositStatusView = { tone: 'waiting' };
  assert.equal(statusViewToPersist(waiting), waiting);
  const active: PersistableDepositStatusView = { tone: 'active' };
  assert.equal(statusViewToPersist(active), active);
  const success: PersistableDepositStatusView = { tone: 'success' };
  assert.equal(statusViewToPersist(success), success);
});

test('null and undefined status views persist as null', () => {
  assert.equal(statusViewToPersist(null), null);
  assert.equal(statusViewToPersist(undefined), null);
});

// --- classifyDepositStatusCheck ---------------------------------------------

const fulfilledBalance: PromiseSettledResult<ClobBalance | null> = {
  status: 'fulfilled',
  value: { balance: 10, allowance: 10 },
};

test('a rejected status fetch classifies as an error, not an empty result', () => {
  assert.deepEqual(
    classifyDepositStatusCheck({
      transactionsResult: { status: 'rejected', reason: new Error('offline') },
      balanceResult: fulfilledBalance,
    }),
    { outcome: 'error', balanceFailed: false },
  );
  assert.deepEqual(
    classifyDepositStatusCheck({
      transactionsResult: { status: 'rejected', reason: new Error('offline') },
      balanceResult: { status: 'rejected', reason: new Error('offline') },
    }),
    { outcome: 'error', balanceFailed: true },
  );
});

test('a fulfilled empty transaction list is genuinely empty, not an error', () => {
  assert.deepEqual(
    classifyDepositStatusCheck({
      transactionsResult: { status: 'fulfilled', value: [] },
      balanceResult: fulfilledBalance,
    }),
    { outcome: 'empty', balanceFailed: false },
  );
  assert.deepEqual(
    classifyDepositStatusCheck({
      transactionsResult: { status: 'fulfilled', value: [] },
      balanceResult: { status: 'rejected', reason: new Error('offline') },
    }),
    { outcome: 'empty', balanceFailed: true },
  );
});

test('fulfilled transactions classify as data regardless of balance outcome', () => {
  assert.deepEqual(
    classifyDepositStatusCheck({
      transactionsResult: { status: 'fulfilled', value: [matching] },
      balanceResult: fulfilledBalance,
    }),
    { outcome: 'data', balanceFailed: false },
  );
});
