import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SpotDataApiClient, SpotTokenBalance } from '@myboon/shared/spot';
import {
  formatWalletAtomicAmount,
  readMeteoraWalletBalances,
} from './meteora.wallet-balances';

const WALLET = 'wallet-1';
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'usdc-mint';

function row(mint: string, amount: string, decimals: number): SpotTokenBalance {
  return {
    mint,
    symbol: null,
    name: null,
    iconUrl: null,
    decimals,
    amount,
    uiAmount: 0,
    priceUsd: null,
    valueUsd: null,
  };
}

function client(tokens: SpotTokenBalance[], state: 'live' | 'fresh' | 'stale' = 'live') {
  return {
    getWalletBalances: async () => ({
      data: { wallet: WALLET, totalValueUsd: null, tokens },
      freshness: { state, source: 'spot_balances_api', servedAt: 'now', ageMs: 0 },
    }),
  } as Pick<SpotDataApiClient, 'getWalletBalances'>;
}

async function testAggregatesNativeAndWrappedRows(): Promise<void> {
  const result = await readMeteoraWalletBalances(
    client([row(SOL, '500000000', 9), row(SOL, '250000000', 9), row(USDC, '1234500', 6)]),
    WALLET,
    { tokenX: { address: SOL, decimals: 9 }, tokenY: { address: USDC, decimals: 6 } },
  );
  assert.equal(result.x.atomic, 750000000n);
  assert.equal(result.x.display, '0.75');
  assert.equal(result.y.display, '1.2345');
}

async function testPreservesLargeAtomicValues(): Promise<void> {
  const amount = '90071992547409931234567890';
  const result = await readMeteoraWalletBalances(
    client([row(USDC, amount, 0)]),
    WALLET,
    { tokenX: { address: USDC, decimals: 0 }, tokenY: { address: SOL, decimals: 9 } },
  );
  assert.equal(result.x.atomic, BigInt(amount));
  assert.equal(result.x.display, amount);
  assert.equal(result.y.atomic, 0n);
}

async function testFormatsZeroDecimalsAndFractions(): Promise<void> {
  assert.equal(formatWalletAtomicAmount('0', 0), '0');
  assert.equal(formatWalletAtomicAmount('1000', 3), '1');
  assert.equal(formatWalletAtomicAmount('1005', 3), '1.005');
}

async function testRejectsInvalidResponses(): Promise<void> {
  await assert.rejects(
    () => readMeteoraWalletBalances(client([row(USDC, '1.2', 6)]), WALLET, {
      tokenX: { address: USDC, decimals: 6 }, tokenY: { address: SOL, decimals: 9 },
    }),
    /unsigned integer/,
  );
  await assert.rejects(
    () => readMeteoraWalletBalances(client([row(USDC, '1', 9)]), WALLET, {
      tokenX: { address: USDC, decimals: 6 }, tokenY: { address: SOL, decimals: 9 },
    }),
    /Unexpected decimals/,
  );
  const wrongWallet = {
    getWalletBalances: async () => ({
      data: { wallet: 'other-wallet', totalValueUsd: null, tokens: [] },
      freshness: { state: 'live', source: 'spot_balances_api', servedAt: 'now', ageMs: 0 },
    }),
  } as Pick<SpotDataApiClient, 'getWalletBalances'>;
  await assert.rejects(
    () => readMeteoraWalletBalances(wrongWallet, WALLET, {
      tokenX: { address: USDC, decimals: 6 }, tokenY: { address: SOL, decimals: 9 },
    }),
    /different wallet/,
  );
  await assert.rejects(
    () => readMeteoraWalletBalances(client([], 'stale'), WALLET, {
      tokenX: { address: USDC, decimals: 6 }, tokenY: { address: SOL, decimals: 9 },
    }),
    /stale/,
  );
}

async function testPropagatesClientRejections(): Promise<void> {
  const failure = new Error('injected failure');
  const failingClient = {
    getWalletBalances: async () => { throw failure; },
  } as Pick<SpotDataApiClient, 'getWalletBalances'>;
  await assert.rejects(
    () => readMeteoraWalletBalances(failingClient, WALLET, {
      tokenX: { address: USDC, decimals: 6 }, tokenY: { address: SOL, decimals: 9 },
    }),
    failure,
  );
}

test('native SOL and wrapped SOL are summed by mint using exact atomic balances', testAggregatesNativeAndWrappedRows);
test('large atomic balances and missing pool tokens retain exact values', testPreservesLargeAtomicValues);
test('zero-decimal and fractional token amounts format correctly', testFormatsZeroDecimalsAndFractions);
test('invalid amounts, wrong decimals, wrong wallets, and stale responses fail', testRejectsInvalidResponses);
test('balance API failures propagate instead of becoming zero', testPropagatesClientRejections);
