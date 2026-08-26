import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canCompleteTrackedDeposit,
  latestDepositTransaction,
  matchingDepositTransactions,
  type TrackedDepositEvidence,
} from './depositTracking';
import type { DepositBridgeTransaction } from './predict.api';

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

test('balance increase alone never completes deposit tracking', () => {
  assert.equal(canCompleteTrackedDeposit(true, null), false);
  assert.equal(canCompleteTrackedDeposit(true, { ...matching, status: 'FAILED' }), false);
  assert.equal(canCompleteTrackedDeposit(true, { ...matching, status: 'PROCESSING' }), false);
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

test('matching accepted Bridge evidence and balance are both required', () => {
  const transaction = latestDepositTransaction(matchingDepositTransactions([{
    ...matching,
    status: 'COMPLETED',
  }], tracked));
  assert.equal(canCompleteTrackedDeposit(false, transaction), false);
  assert.equal(canCompleteTrackedDeposit(true, transaction), true);
});

test('matching PROCESSING deposit plus unrelated balance increase does not complete', () => {
  const transaction = latestDepositTransaction(matchingDepositTransactions([matching], tracked));
  assert.equal(transaction?.status, 'PROCESSING');
  assert.equal(canCompleteTrackedDeposit(true, transaction), false);
});
