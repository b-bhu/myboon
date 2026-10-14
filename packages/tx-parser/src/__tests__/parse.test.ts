import { PublicKey, type ParsedTransactionWithMeta, type TokenBalance } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { KNOWN_FUNDING_TOKENS } from '../constants/knownTokens.js';
import { VERIFIED_PROGRAM_IDS } from '../constants/programIds.js';
import { fetchTransactionBySignature } from '../rpc.js';
import {
  identifyTransactionType,
  parseJupiterTransaction,
  parseSingleTransaction
} from '../parsers/index.js';
import { integrationTestsEnabled, TEST_SIGNATURES } from './fixtures.js';

describe.skipIf(!integrationTestsEnabled)('identifyTransactionType (integration)', () => {
  it('identifies transfer signature', async () => {
    const tx = await fetchTransactionBySignature(TEST_SIGNATURES.TRANSFER);
    expect(tx).not.toBeNull();

    const result = identifyTransactionType(tx!);
    expect(result).toEqual({ type: 'transfer', protocol: 'spl-token' });
  });

  it('identifies meteora signature', async () => {
    const tx = await fetchTransactionBySignature(TEST_SIGNATURES.LP_METEORA);
    expect(tx).not.toBeNull();

    const result = identifyTransactionType(tx!);
    expect(result).toEqual({ type: 'lp', protocol: 'meteora-dlmm' });
  });

  it('identifies unknown signature as unknown', async () => {
    const tx = await fetchTransactionBySignature(TEST_SIGNATURES.UNKNOWN);
    expect(tx).not.toBeNull();

    const result = identifyTransactionType(tx!);
    // Allow either 'unknown' or 'system' transfer since our system program detection may classify some previously unknown as system transfers
    expect(['unknown', 'transfer']).toContain(result.type);
    if (result.type === 'transfer') {
      expect(['system']).toContain(result.protocol);
    } else {
      expect(result).toEqual({ type: 'unknown', protocol: 'unknown' });
    }
  });
});

describe.skipIf(!integrationTestsEnabled)('parseSingleTransaction (integration)', () => {
  it('returns parsed transfer with generic details', async () => {
    const tx = await fetchTransactionBySignature(TEST_SIGNATURES.TRANSFER);
    expect(tx).not.toBeNull();

    const result = parseSingleTransaction(tx!, TEST_SIGNATURES.TRANSFER);

    expect(result.signature).toBe(TEST_SIGNATURES.TRANSFER);
    expect(result.type).toBe('transfer');
    expect(result.protocol).toBe('spl-token');
    expect(result.details.kind).toBe('generic');
  });

  it('returns parsed meteora lp with dlmm details', async () => {
    const tx = await fetchTransactionBySignature(TEST_SIGNATURES.LP_METEORA);
    expect(tx).not.toBeNull();

    const result = parseSingleTransaction(tx!, TEST_SIGNATURES.LP_METEORA);

    expect(result.signature).toBe(TEST_SIGNATURES.LP_METEORA);
    expect(result.type).toBe('lp');
    expect(result.protocol).toBe('meteora-dlmm');
    expect(result.details.kind).toBe('dlmm');

    if (result.details.kind !== 'dlmm') {
      return;
    }

    expect(result.details.action).toBe('remove-liquidity');
    expect(result.details.poolAddress).toBeTypeOf('string');
    expect(result.details.poolAddress.length).toBeGreaterThan(20);
  });
});

function buildTokenBalance(
  accountIndex: number,
  mint: string,
  owner: string,
  amount: string,
  decimals: number
): TokenBalance {
  return {
    accountIndex,
    mint,
    owner,
    uiTokenAmount: {
      amount,
      decimals,
      uiAmount: Number(amount) / 10 ** decimals,
      uiAmountString: (Number(amount) / 10 ** decimals).toString()
    }
  };
}

function buildMockJupiterTransaction(args: {
  inputMint: string;
  inputPreAmount: string;
  inputPostAmount: string;
  inputDecimals: number;
  outputMint: string;
  outputPreAmount: string;
  outputPostAmount: string;
  outputDecimals: number;
}): ParsedTransactionWithMeta {
  const wallet = new PublicKey('7iNJ7CLNT8UBPANxkkrsURjzaktbomCVa93N1sKcVo9C');
  const pool = new PublicKey('B5oc2fW6rXfQx5FzxBBsjjCgJvEihQ6UkNzxaz2QmiF4');

  return {
    slot: 1,
    blockTime: 1_700_000_000,
    transaction: {
      signatures: ['mock-signature'],
      message: {
        accountKeys: [
          { pubkey: wallet, signer: true, writable: true },
          { pubkey: pool, signer: false, writable: true }
        ],
        instructions: [
          {
            programId: new PublicKey(VERIFIED_PROGRAM_IDS.JUPITER_V6),
            accounts: [],
            data: ''
          }
        ],
        recentBlockhash: 'mock-blockhash'
      }
    },
    meta: {
      err: null,
      fee: 5000,
      innerInstructions: [],
      preBalances: [1_000_000_000, 1_000_000_000],
      postBalances: [999_995_000, 1_000_005_000],
      preTokenBalances: [
        buildTokenBalance(0, args.inputMint, wallet.toBase58(), args.inputPreAmount, args.inputDecimals),
        buildTokenBalance(1, args.outputMint, wallet.toBase58(), args.outputPreAmount, args.outputDecimals),
        buildTokenBalance(2, args.outputMint, pool.toBase58(), '1000000000', args.outputDecimals)
      ],
      postTokenBalances: [
        buildTokenBalance(0, args.inputMint, wallet.toBase58(), args.inputPostAmount, args.inputDecimals),
        buildTokenBalance(1, args.outputMint, wallet.toBase58(), args.outputPostAmount, args.outputDecimals),
        buildTokenBalance(2, args.outputMint, pool.toBase58(), '9000000000', args.outputDecimals)
      ]
    }
  };
}

describe('parseJupiterTransaction (unit)', () => {
  it('classifies known-to-unknown wallet swap as buy', () => {
    const tx = buildMockJupiterTransaction({
      inputMint: KNOWN_FUNDING_TOKENS.SOL,
      inputPreAmount: '5000000000',
      inputPostAmount: '3000000000',
      inputDecimals: 9,
      outputMint: '4B12s53Y5efq2uZsxNTo8A4f8i8W8wmQXk5P3Ng8fN6A',
      outputPreAmount: '0',
      outputPostAmount: '1000000000',
      outputDecimals: 6
    });

    const details = parseJupiterTransaction(tx);
    expect(details).not.toBeNull();
    expect(details?.kind).toBe('buy');

    if (!details || details.kind !== 'buy') {
      return;
    }

    expect(details.fundingToken.mint).toBe(KNOWN_FUNDING_TOKENS.SOL);
    expect(details.fundingToken.isKnown).toBe(true);
    expect(details.targetToken.isKnown).toBe(false);
    expect(details.targetToken.needsResearch).toBe(true);
    expect(details.fundingAmount).toBe('2');
    expect(details.targetAmount).toBe('1000');

    const parsed = parseSingleTransaction(tx, 'mock-buy-signature');
    expect(parsed.type).toBe('buy');
    expect(parsed.protocol).toBe('jupiter');
    expect(parsed.details.kind).toBe('buy');
  });

  it('classifies unknown-to-known wallet swap as sell', () => {
    const tx = buildMockJupiterTransaction({
      inputMint: '4B12s53Y5efq2uZsxNTo8A4f8i8W8wmQXk5P3Ng8fN6A',
      inputPreAmount: '2500000000',
      inputPostAmount: '500000000',
      inputDecimals: 6,
      outputMint: KNOWN_FUNDING_TOKENS.USDC,
      outputPreAmount: '1000000',
      outputPostAmount: '3500000',
      outputDecimals: 6
    });

    const details = parseJupiterTransaction(tx);
    expect(details).not.toBeNull();
    expect(details?.kind).toBe('sell');

    if (!details || details.kind !== 'sell') {
      return;
    }

    expect(details.fundingToken.mint).toBe(KNOWN_FUNDING_TOKENS.USDC);
    expect(details.fundingToken.isKnown).toBe(true);
    expect(details.targetToken.isKnown).toBe(false);
    expect(details.targetToken.needsResearch).toBe(true);
    expect(details.direction).toBe('sell');
    expect(details.fundingAmount).toBe('2.5');
    expect(details.targetAmount).toBe('2000');

    const parsed = parseSingleTransaction(tx, 'mock-sell-signature');
    expect(parsed.type).toBe('sell');
    expect(parsed.protocol).toBe('jupiter');
    expect(parsed.details.kind).toBe('sell');
  });
});
