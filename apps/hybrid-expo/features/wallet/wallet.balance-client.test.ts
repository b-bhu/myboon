import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readMeteoraWalletBalances } from '../meteora/meteora.wallet-balances';

test('wallet and Meteora share the configured backend, cached balances, and refresh', async () => {
  const previousBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;
  const previousFetch = globalThis.fetch;
  const wallet = '11111111111111111111111111111111';
  const mint = 'So11111111111111111111111111111111111111112';
  const urls: string[] = [];
  let amount = '500000000';
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://balance-tests.example/';
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return Response.json({
      wallet,
      totalValueUsd: null,
      tokens: [{ mint, symbol: 'SOL', name: 'Solana', icon: null, decimals: 9, amount, uiAmount: 0, priceUsd: null, valueUsd: null }],
    });
  };

  try {
    const { walletBalanceClient } = await import('./wallet.balance-client');
    await walletBalanceClient.getWalletBalances(wallet);
    const tokens = { tokenX: { address: mint, decimals: 9 }, tokenY: { address: 'missing-mint', decimals: 6 } };
    const balances = await readMeteoraWalletBalances(walletBalanceClient, wallet, tokens);
    assert.equal(balances.x.display, '0.5');
    assert.equal(balances.y.display, '0');
    assert.deepEqual(urls, [`https://balance-tests.example/spot/${wallet}/balances`]);

    amount = '750000000';
    walletBalanceClient.clearCache();
    const refreshed = await readMeteoraWalletBalances(walletBalanceClient, wallet, tokens);
    assert.equal(refreshed.x.display, '0.75');
    assert.equal(urls.length, 2);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousBaseUrl === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
    else process.env.EXPO_PUBLIC_API_BASE_URL = previousBaseUrl;
  }
});
