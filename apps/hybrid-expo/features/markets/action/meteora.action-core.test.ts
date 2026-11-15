/**
 * Tests for the Meteora shared action panel body (PURE core).
 *
 * The real adapter (meteoraPhaseTwoAdapter / position validation) is NOT
 * stubbed away — validation runs `validateMeteoraPositionDraft` for real;
 * only the prepare/execute boundary is faked, as a MeteoraPhaseTwoAdapter,
 * because node cannot sign. Mirrors meteora.position-validation.test.ts's
 * fixture style (SOL/USDC, prices 99–101, balanced presets).
 *
 * RUN: pnpm tsx --test features/markets/action/meteora.action-core.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { ActionAmountState } from '@/features/markets/action/action.contract';
import type {
  MeteoraExecuteResult,
  MeteoraPhaseTwoAdapter,
  MeteoraPhaseTwoPreview,
  MeteoraPrepareContext,
} from '@/features/meteora/meteora.form';
import {
  EMPTY_METEORA_ACTION_BODY,
  buildMeteoraActionDraft,
  createMeteoraActionAdapter,
  type MeteoraActionBody,
  type MeteoraActionDeps,
} from './meteora.action-core';

const tokenX = { symbol: 'SOL', decimals: 9 };
const tokenY = { symbol: 'USDC', decimals: 6 };

/**
 * The screen builds the full MeteoraPrepareContext (wallet, connection,
 * freshness). Only pool.tokenX/tokenY reach the body; cast is scoped here.
 */
const ctx: MeteoraPrepareContext = {
  pool: { tokenX, tokenY },
} as unknown as MeteoraPrepareContext;

const amount = (text: string): ActionAmountState => ({
  amountText: text,
  amountValue: text.trim() === '' ? null : Number(text),
});

/** Full, fully-typed preview — matches meteora.form.ts's interface. */
const preview = (
  overrides: Partial<MeteoraPhaseTwoPreview> = {},
): MeteoraPhaseTwoPreview => ({
  id: 'preview-1',
  kind: 'position',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-01T00:01:00.000Z',
  currentPrice: '142.5',
  executableMinPrice: '10.15',
  executableMaxPrice: '174.85',
  transactionCount: 2,
  costs: [{ label: 'Estimate cost', value: '<0.01' }],
  warnings: [],
  canExecute: true,
  walletAddress: null,
  network: 'mainnet-beta',
  ...overrides,
});

interface FakeAdapterPlan {
  preview?: MeteoraPhaseTwoPreview;
  executeResult?: MeteoraExecuteResult;
  throwOnPrepare?: Error;
  throwOnExecute?: Error;
}

/**
 * Fake MeteoraPhaseTwoAdapter recording call counts. prepareLimitOrder must
 * never be invoked — the action surface is side-less and position-only.
 */
function fakeAdapter(plan: FakeAdapterPlan = {}): MeteoraPhaseTwoAdapter {
  return {
    preparePosition: async () => {
      counts.preparePosition += 1;
      if (plan.throwOnPrepare) throw plan.throwOnPrepare;
      return plan.preview ?? preview();
    },
    prepareLimitOrder: async () => {
      throw new Error('limit orders are out of scope for the action panel');
    },
    execute: async (_ctx, _preview, onProgress) => {
      counts.execute += 1;
      onProgress?.({ state: 'submitted', message: 'Sending' });
      if (plan.throwOnExecute) throw plan.throwOnExecute;
      return plan.executeResult ?? { state: 'confirmed', message: 'ok' };
    },
  };
}

const actionCtx = (text: string) => ({
  amount: amount(text),
  extra: undefined,
});

let counts = { preparePosition: 0, execute: 0 };

function resetCounts() {
  counts = { preparePosition: 0, execute: 0 };
}

function deps(
  overrides: Partial<MeteoraActionDeps> = {},
): MeteoraActionDeps & { refreshes: () => number } {
  let refreshes = 0;
  return {
    prepareContext: () => ctx,
    poolFresh: true,
    amountSymbol: 'SOL',
    refresh: () => {
      refreshes += 1;
    },
    positionDraftBase: () => ({ preset: 'balanced' as const }),
    adapter: fakeAdapter(),
    refreshes: () => refreshes,
    ...overrides,
  };
}

test('contract spec exposes the side-less Meteora venue', () => {
  const adapter = createMeteoraActionAdapter(deps());
  assert.equal(adapter.venueId, 'meteora');
  assert.equal(adapter.kind, 'lp');
  assert.equal(adapter.label, 'Meteora');
  assert.equal(adapter.amountLabel(EMPTY_METEORA_ACTION_BODY), 'AMOUNT (SOL)');
  assert.equal(adapter.amountPrefix(EMPTY_METEORA_ACTION_BODY), null);
  assert.equal(adapter.amountSuffix(EMPTY_METEORA_ACTION_BODY), 'SOL');
  assert.deepEqual(adapter.confirm(EMPTY_METEORA_ACTION_BODY, amount('5')), {
    label: 'Swipe to add liquidity',
    accent: 'accent',
  });
  assert.deepEqual(EMPTY_METEORA_ACTION_BODY, { amountYText: '' });
});

test('validate runs the shell gates before venue validation', () => {
  const adapter = createMeteoraActionAdapter(deps());
  assert.deepEqual(adapter.validate(EMPTY_METEORA_ACTION_BODY, actionCtx('')), {
    title: 'Enter an amount',
    detail: 'Enter the amount to deposit.',
  });
  const staleAdapter = createMeteoraActionAdapter(deps({ poolFresh: false }));
  assert.deepEqual(
    staleAdapter.validate(EMPTY_METEORA_ACTION_BODY, actionCtx('5')),
    {
      title: 'Refresh pool data',
      detail: 'Pool pricing is stale. Pull to refresh, then try again.',
    },
  );
  const noWallet = createMeteoraActionAdapter(
    deps({ prepareContext: () => null }),
  );
  assert.deepEqual(noWallet.validate(EMPTY_METEORA_ACTION_BODY, actionCtx('5')), {
    title: 'Connect your wallet',
    detail: 'Connect a wallet to add liquidity.',
  });
});

test('validate delegates real blockers to validateMeteoraPositionDraft', () => {
  const adapter = createMeteoraActionAdapter(deps());
  // Valid: auto-fill default (Y empty → autoFill) with a positive X amount.
  assert.equal(adapter.validate(EMPTY_METEORA_ACTION_BODY, actionCtx('5')), null);
  // A deliberate USDC typo reaches the venue validator, so the message is
  // the screen's real wording — proof the body did not reimplement it.
  const body: MeteoraActionBody = { amountYText: '-2' };
  assert.deepEqual(adapter.validate(body, actionCtx('5')), {
    title: 'Fix USDC amount',
    detail: 'Use a positive decimal amount',
  });
  // The screen's range state is the source for prices; a manual base with
  // empty edges surfaces the screen's own blocker.
  const manualBaseDeps = deps({ positionDraftBase: () => ({ preset: 'manual' }) });
  const manualAdapter = createMeteoraActionAdapter(manualBaseDeps);
  assert.deepEqual(
    manualAdapter.validate(EMPTY_METEORA_ACTION_BODY, actionCtx('5')),
    { title: 'Enter minimum price', detail: 'Enter minimum price' },
  );
});

test('quote renders preview rows with shell guards and failures', async () => {
  resetCounts();
  const adapter = createMeteoraActionAdapter(deps({ adapter: fakeAdapter() }));
  const rows = await adapter.quote(EMPTY_METEORA_ACTION_BODY, actionCtx('5'));
  assert.equal(rows.unavailableReason, null);
  assert.equal(rows.loading, false);
  assert.deepEqual(rows.rows, [
    { key: 'ENTRY PRICE', value: '142.5', tone: 'dim' },
    { key: 'EXECUTABLE RANGE', value: '10.15 – 174.85' },
    { key: 'ESTIMATE COST', value: '<0.01', tone: 'dim' },
  ]);

  assert.deepEqual(
    await adapter.quote(EMPTY_METEORA_ACTION_BODY, actionCtx('')),
    { rows: [], loading: false, unavailableReason: null },
  );
  const stale = createMeteoraActionAdapter(deps({ poolFresh: false }));
  assert.deepEqual(await stale.quote(EMPTY_METEORA_ACTION_BODY, actionCtx('5')), {
    rows: [],
    loading: false,
    unavailableReason: 'Pool data is stale — pull to refresh.',
  });
  const throwing = createMeteoraActionAdapter(
    deps({ adapter: fakeAdapter({ throwOnPrepare: new Error('rpc') }) }),
  );
  assert.deepEqual(await throwing.quote(EMPTY_METEORA_ACTION_BODY, actionCtx('5')), {
    rows: [],
    loading: false,
    unavailableReason: 'Preview unavailable — adjust and retry.',
  });
});

test('submit re-prepares, executes and refreshes only on settled states', async () => {
  resetCounts();
  const d = deps({
    adapter: fakeAdapter({
      executeResult: { state: 'confirmed', message: 'Position live' },
    }),
  });
  const adapter = createMeteoraActionAdapter(d);
  const result = await adapter.submit(EMPTY_METEORA_ACTION_BODY, actionCtx('5'));
  assert.deepEqual(result, {
    status: 'submitted',
    message: 'Position live',
    closeAfter: false,
  });
  assert.equal(counts.preparePosition, 1);
  assert.equal(counts.execute, 1);
  assert.equal(d.refreshes(), 1);

  // A blocking warning rejects before execute — no signing call.
  resetCounts();
  const blocked = createMeteoraActionAdapter(
    deps({
      adapter: fakeAdapter({
        preview: preview({
          warnings: [{ code: 'stale', message: 'Pool moved, refresh', blocking: true }],
          canExecute: true,
        }),
      }),
    }),
  );
  const blockedResult = await blocked.submit(
    EMPTY_METEORA_ACTION_BODY,
    actionCtx('5'),
  );
  assert.deepEqual(blockedResult, {
    status: 'rejected',
    message: 'Pool moved, refresh',
  });
  assert.equal(counts.execute, 0);
});

test('submit treats cancelled as rejected and partial as keep-open', async () => {
  resetCounts();
  const cancelled = createMeteoraActionAdapter(
    deps({
      adapter: fakeAdapter({
        executeResult: { state: 'cancelled', message: 'Cancelled' },
      }),
    }),
  );
  assert.deepEqual(await cancelled.submit(EMPTY_METEORA_ACTION_BODY, actionCtx('5')), {
    status: 'rejected',
    message: 'Cancelled',
  });

  resetCounts();
  const partialDeps = deps({
    adapter: fakeAdapter({
      executeResult: { state: 'partial', message: 'Half landed, retry' },
    }),
  });
  const partial = createMeteoraActionAdapter(partialDeps);
  const partialResult = await partial.submit(
    EMPTY_METEORA_ACTION_BODY,
    actionCtx('5'),
  );
  assert.deepEqual(partialResult, {
    status: 'partial',
    message: 'Half landed, retry',
    closeAfter: false,
  });
  assert.equal(partialDeps.refreshes(), 1);
});

test('submit converts executor failures into rejections', async () => {
  resetCounts();
  const failing = createMeteoraActionAdapter(
    deps({ adapter: fakeAdapter({ throwOnExecute: new Error('RPC down') }) }),
  );
  assert.deepEqual(await failing.submit(EMPTY_METEORA_ACTION_BODY, actionCtx('5')), {
    status: 'rejected',
    message: 'RPC down',
  });
  const opaque = createMeteoraActionAdapter(
    deps({
      adapter: fakeAdapter({
        throwOnExecute: 'non-Error' as unknown as Error,
      }),
    }),
  );
  assert.deepEqual(await opaque.submit(EMPTY_METEORA_ACTION_BODY, actionCtx('5')), {
    status: 'rejected',
    message: 'Could not execute — try again.',
  });
});

test('buildMeteoraActionDraft normalizes the Y override and range base', () => {
  // Y override: trims, switches off autoFill, keeps the screen's range base.
  assert.deepEqual(
    buildMeteoraActionDraft(
      { amountYText: ' 2 ' },
      amount('5'),
      () => ({ preset: 'balanced' as const }),
    ),
    {
      fundingMode: 'both',
      singleTokenSide: 'x',
      amountX: '5',
      amountY: '2',
      autoFill: false,
      strategy: 'spot',
      preset: 'balanced',
      requestedMinPrice: '',
      requestedMaxPrice: '',
    },
  );
  // Default: Y empty → autoFill on, amountY empty.
  assert.deepEqual(
    buildMeteoraActionDraft(EMPTY_METEORA_ACTION_BODY, amount('5'), () => ({})),
    {
      fundingMode: 'both',
      singleTokenSide: 'x',
      amountX: '5',
      amountY: '',
      autoFill: true,
      strategy: 'spot',
      preset: 'manual',
      requestedMinPrice: '',
      requestedMaxPrice: '',
    },
  );
});
