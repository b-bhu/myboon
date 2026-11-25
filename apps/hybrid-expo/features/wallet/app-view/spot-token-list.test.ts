/**
 * Pure test for the Spot app view token rows (issue #844).
 *
 * Run: pnpm --filter hybrid-expo exec tsx --test features/wallet/app-view/spot-token-list.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { spotTokenList } from './spot-token-list';
import { NO_DATA } from '@/lib/format';
import type { WalletSummary } from '@myboon/shared/wallet-summary';

function summaryWithSpot(spot: unknown): WalletSummary {
  return { solana: 'sol', evm: null, fetchedAt: '2026-01-01T00:00:00Z', apps: { spot } } as unknown as WalletSummary;
}

describe('spotTokenList', () => {
  it('keeps tokens of $1 or more, largest first, and counts them', () => {
    const list = spotTokenList(
      summaryWithSpot({
        status: 'ok',
        valueUsd: 5323.25,
        summary: {
          tokenCount: 4,
          tokens: [
            { mint: 'DUST000000', symbol: 'DUST', iconUrl: null, valueUsd: 0.4 },
            { mint: 'MINTB', symbol: 'JUP', iconUrl: null, valueUsd: 12.5 },
            { mint: 'MINTA', symbol: 'SOL', iconUrl: 'https://x/sol.png', valueUsd: 5310.25 },
            { mint: 'UNKNOWN', symbol: 'ABC', iconUrl: null, valueUsd: null },
          ],
        },
      }),
    );
    assert.equal(list?.countLine, '2 tokens · dust hidden');
    assert.equal(list?.total, '$5,323.25');
    assert.deepEqual(list?.rows.map((row) => [row.symbol, row.value]), [['SOL', '$5,310.25'], ['JUP', '$12.50']]);
  });

  it('falls back to a mint prefix for a missing symbol and to NO_DATA for an unknown total', () => {
    const list = spotTokenList(
      summaryWithSpot({ status: 'ok', valueUsd: null, summary: { tokenCount: 1, tokens: [{ mint: 'ExampleMint11', symbol: null, iconUrl: null, valueUsd: 12.5 }] } }),
    );
    assert.equal(list?.rows[0].symbol, 'Exam');
    assert.equal(list?.countLine, '1 token · dust hidden');
    assert.equal(list?.total, NO_DATA);
  });

  it('returns null without a summary or a spot answer', () => {
    assert.equal(spotTokenList(null), null);
    assert.equal(spotTokenList(summaryWithSpot({ status: 'unavailable', valueUsd: null, summary: null })), null);
  });
});
