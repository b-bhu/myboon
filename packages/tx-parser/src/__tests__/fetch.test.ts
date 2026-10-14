import { describe, expect, it } from 'vitest';

import { fetchTransactionBySignature, fetchWalletTransactions } from '../rpc.js';
import { integrationTestsEnabled, TEST_SIGNATURES } from './fixtures.js';

describe.skipIf(!integrationTestsEnabled)('fetchWalletTransactions (integration)', () => {
  it('returns parsed transactions for a valid wallet', async () => {
    const walletAddress = process.env.EXAMPLE_WALLET;
    expect(walletAddress).toBeDefined();

    const transactions = await fetchWalletTransactions(walletAddress!, { count: 3 });

    expect(Array.isArray(transactions)).toBe(true);
    expect(transactions.length).toBeLessThanOrEqual(3);
  });

  it('throws on invalid wallet address', async () => {
    await expect(fetchWalletTransactions('invalid-address')).rejects.toThrow('Invalid wallet address');
  });

  it('throws when count is invalid', async () => {
    const walletAddress = process.env.EXAMPLE_WALLET!;
    await expect(fetchWalletTransactions(walletAddress, { count: 0 })).rejects.toThrow(
      'Count must be a positive integer'
    );
  });
});

describe.skipIf(!integrationTestsEnabled)('fetchTransactionBySignature (integration)', () => {
  it('fetches one known transaction by signature', async () => {
    const transaction = await fetchTransactionBySignature(TEST_SIGNATURES.TRANSFER);

    expect(transaction).not.toBeNull();
    expect(transaction?.slot).toBeTypeOf('number');
  });

  it('throws when signature is empty', async () => {
    await expect(fetchTransactionBySignature('   ')).rejects.toThrow('Invalid signature');
  });
});
