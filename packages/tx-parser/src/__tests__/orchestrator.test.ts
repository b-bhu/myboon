import { describe, expect, it } from 'vitest';

import {
  parseTransactionBySignature,
  parseTransactions,
  parseWalletHistory
} from '../orchestrator.js';
import { fetchWalletTransactions } from '../rpc.js';
import { integrationTestsEnabled, TEST_SIGNATURES } from './fixtures.js';

describe.skipIf(!integrationTestsEnabled)('parseTransactions (integration)', () => {
  it('maps raw wallet transactions into parsed transactions', async () => {
    const wallet = process.env.EXAMPLE_WALLET!;
    const raw = await fetchWalletTransactions(wallet, { count: 2 });

    const parsed = parseTransactions(raw);

    expect(parsed.length).toBe(raw.length);
    for (const item of parsed) {
      expect(item.signature).toBeTypeOf('string');
      expect(item.type).toBeTypeOf('string');
    }
  });
});

describe.skipIf(!integrationTestsEnabled)('parseWalletHistory (integration)', () => {
  it('fetches and parses wallet history end-to-end', async () => {
    const wallet = process.env.EXAMPLE_WALLET!;
    const parsed = await parseWalletHistory(wallet, { count: 2 });

    expect(parsed.length).toBeLessThanOrEqual(2);
    for (const tx of parsed) {
      expect(tx.signature).toBeTypeOf('string');
      expect(tx.details.kind).toBeTypeOf('string');
    }
  });
});

describe.skipIf(!integrationTestsEnabled)('parseTransactionBySignature (integration)', () => {
  it('parses known transfer signature', async () => {
    const result = await parseTransactionBySignature(TEST_SIGNATURES.TRANSFER);

    expect(result).not.toBeNull();
    expect(result?.type).toBe('transfer');
    expect(result?.protocol).toBe('spl-token');
  });

  it('parses known meteora signature', async () => {
    const result = await parseTransactionBySignature(TEST_SIGNATURES.LP_METEORA);

    expect(result).not.toBeNull();
    expect(result?.type).toBe('lp');
    expect(result?.protocol).toBe('meteora-dlmm');
  });
});
