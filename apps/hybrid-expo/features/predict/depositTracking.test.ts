import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canCompleteTrackedDeposit,
  classifyDepositStatusCheck,
  latestDepositTransaction,
  matchingDepositTransactions,
  persistDepositTracking,
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
  assert.equal(saved, false);
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
  assert.equal(saved, true);
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
  assert.equal(saved, true);
  assert.equal(calls, 1);
  assert.deepEqual(failures, []);
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
