/**
 * Pure tests for the Meteora Manage context helpers (issue #917).
 *
 * meteora-manage.ts imports types only, so these run under plain tsx next to
 * the other app-view tests — no React, no meteora client, no native modules.
 * No hook test: useMeteoraPool is device-checked by the Manage sheet (issue
 * #903).
 *
 * Run: pnpm --filter hybrid-expo test:wallet
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { MeteoraPoolDetail } from '@myboon/shared/meteora';
import type { WalletMeteoraPosition } from '@myboon/shared/wallet-summary';
import type { useWallet } from '@/hooks/useWallet';
import { buildMeteoraPrepareContext, toMeteoraPositionSummary } from './meteora-manage';

type WalletHook = ReturnType<typeof useWallet>;

const SOL = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

function positionAt(address: string, outOfRange: boolean | null): WalletMeteoraPosition {
  return {
    address,
    poolAddress: `pool-${address}`,
    poolName: 'SOL/USDC',
    minPrice: 100,
    maxPrice: 200,
    lowerBinId: 8388608,
    upperBinId: 8388650,
    outOfRange,
    pnlUsd: 1.5,
    pnlPct: 0.4,
    feeTvl24hPct: 0.2,
    poolUnclaimedFeesUsd: 3.25,
  };
}

const FRESHNESS = {
  state: 'fresh',
  source: 'meteora_data_api',
  servedAt: '2026-11-25T00:00:00.000Z',
  ageMs: 0,
} as const;

// Minimal shape on purpose: the contract is passthrough ("the pool it was
// given, not a constructed one"), so identity of the passed object is what
// the test pins.
const POOL = {
  address: 'pool-1',
  binStep: 10,
} as MeteoraPoolDetail;

interface WalletFixture {
  connected: boolean;
  address: string | null;
  source: string;
  isPreparing: boolean;
  signAndSendTransaction: ((transaction: unknown) => Promise<unknown>) | null;
  connection: unknown;
}

/**
 * The helpers read a structural subset of the hook's union branches, so the
 * cast stays honest — no branch field is invented here.
 */
function walletAt(fixture: WalletFixture): WalletHook {
  return fixture as unknown as WalletHook;
}

describe('toMeteoraPositionSummary', () => {
  it('maps an in-range position', () => {
    const summary = toMeteoraPositionSummary(positionAt('pos-1', false));
    assert.deepEqual(summary, {
      positionAddress: 'pos-1',
      poolAddress: 'pool-pos-1',
      lowerBinId: 8388608,
      upperBinId: 8388650,
      activeBinId: null,
      isOutOfRange: false,
    });
  });

  it('maps an out-of-range position', () => {
    const summary = toMeteoraPositionSummary(positionAt('pos-2', true));
    assert.equal(summary.positionAddress, 'pos-2');
    assert.equal(summary.poolAddress, 'pool-pos-2');
    assert.equal(summary.lowerBinId, 8388608);
    assert.equal(summary.upperBinId, 8388650);
    assert.equal(summary.isOutOfRange, true);
    assert.equal(summary.activeBinId, null);
  });

  it('passes an unknown range through as null, not false', () => {
    assert.equal(toMeteoraPositionSummary(positionAt('pos-3', null)).isOutOfRange, null);
  });
});

describe('buildMeteoraPrepareContext', () => {
  it('returns the pool it was given, with the real freshness and wallet address', () => {
    const context = buildMeteoraPrepareContext(POOL, FRESHNESS, walletAt({
      connected: true,
      address: SOL,
      source: 'mwa',
      isPreparing: false,
      signAndSendTransaction: null,
      connection: { rpc: 'fake' },
    }));
    assert.strictEqual(context.pool, POOL);
    assert.strictEqual(context.poolFreshness, FRESHNESS);
    assert.equal(context.walletAddress, SOL);
    assert.deepEqual(context.connection, { rpc: 'fake' });
  });

  it('maps a signing wallet the way the market sheet does: the wrapper calls through', async () => {
    const sent: unknown[] = [];
    const context = buildMeteoraPrepareContext(POOL, FRESHNESS, walletAt({
      connected: true,
      address: SOL,
      source: 'mwa',
      isPreparing: false,
      signAndSendTransaction: async (transaction: unknown) => {
        sent.push(transaction);
        return 'sig-1';
      },
      connection: null,
    }));
    assert.equal(typeof context.wallet.signAndSendTransaction, 'function');
    await context.wallet.signAndSendTransaction?.('tx-1');
    assert.deepEqual(sent, ['tx-1']);
  });

  it('maps a wallet that cannot sign-and-send to null, keeping its state', () => {
    const context = buildMeteoraPrepareContext(POOL, FRESHNESS, walletAt({
      connected: false,
      address: null,
      source: 'privy',
      isPreparing: true,
      signAndSendTransaction: null,
      connection: null,
    }));
    assert.strictEqual(context.wallet.signAndSendTransaction, null);
    assert.equal(context.wallet.connected, false);
    assert.equal(context.wallet.address, null);
    assert.equal(context.wallet.source, 'privy');
    assert.equal(context.wallet.isPreparing, true);
    assert.equal(context.walletAddress, null);
  });
});
