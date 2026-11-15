import test from 'node:test';
import assert from 'node:assert/strict';
import type { ActionAmountState, ActionPanelContext } from '@/features/markets/action/action.contract';
import { formatActionAmount } from '@/features/markets/action/action.contract';
import type { placePhoenixOrder } from '@/features/perps/phoenix.execution';
import {
  createPhoenixActionAdapter,
  type PhoenixActionBody,
  type PhoenixActionDeps,
} from './phoenix.action-core';

const amountState = (text: string): ActionAmountState => ({
  amountText: text,
  amountValue: text.trim() === '' ? null : Number(text),
});

const actionCtx = (text: string): ActionPanelContext<void> => ({
  amount: amountState(text),
  extra: undefined,
});

const MARKET_BASE: PhoenixActionBody = {
  side: 'long',
  orderType: 'market',
  amountMode: 'base',
  limitPriceText: '',
};
const MARKET_USD: PhoenixActionBody = { ...MARKET_BASE, amountMode: 'usd' };
const LIMIT_LONG: PhoenixActionBody = { ...MARKET_BASE, orderType: 'limit', limitPriceText: '150' };

const FAKE_TX = 'SIG12345678';
const FAKE_CONNECTION = { __marker: 'fake-connection' };

/**
 * Deps fixture mirrors the real seam shape (connected/address/source/isPreparing/
 * signAndSendTransaction/connection/displayedPrice/venueSymbol/screen hooks) but
 * stays weakly typed so the readiness inputs ride through one cast at the adapter.
 */
function phxDeps(overrides: Record<string, unknown> = {}): {
  deps: Record<string, unknown>;
  orderCalls: Array<{ input: Record<string, unknown>; context: Record<string, unknown> }>;
  pendingCalls: Array<Record<string, unknown>>;
  refreshCount: number;
} {
  const orderCalls: Array<{ input: Record<string, unknown>; context: Record<string, unknown> }> = [];
  const pendingCalls: Array<Record<string, unknown>> = [];
  let refreshCount = 0;

  const deps: Record<string, unknown> = {
    connected: true,
    address: 'PHXWALLET1111111111111111111111111111111111',
    source: 'wallet',
    isPreparing: false,
    signAndSendTransaction: async () => FAKE_TX,
    connection: FAKE_CONNECTION,
    displayedPrice: 142.5,
    venueSymbol: 'SOL-PERP',
    onPendingPlacement: (placement: Record<string, unknown>) => {
      pendingCalls.push(placement);
    },
    refresh: () => {
      refreshCount += 1;
    },
    placeOrder: (async (input: unknown, context: unknown) => {
      orderCalls.push({
        input: JSON.parse(JSON.stringify(input)) as Record<string, unknown>,
        context: context as Record<string, unknown>,
      });
      return { status: 'submitted', txSignature: FAKE_TX };
    }) as unknown as typeof placePhoenixOrder,
    ...overrides,
  };
  return { deps, orderCalls, pendingCalls, get refreshCount() { return refreshCount; } };
}

const roundTrip = (value: Record<string, unknown>): Record<string, unknown> =>
  JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

test('phoenix validate: disconnected wallet is blocked first', () => {
  const fixture = phxDeps({ connected: false });
  const adapter = createPhoenixActionAdapter(fixture.deps as unknown as PhoenixActionDeps);
  assert.deepEqual(adapter.validate(MARKET_BASE, actionCtx('1')), {
    title: 'Connect a wallet to trade Phoenix.',
    detail: null,
  });
});

test('phoenix validate: bound signer is required before amounts are checked', async () => {
  const fixture = phxDeps({ signAndSendTransaction: null });
  const adapter = createPhoenixActionAdapter(fixture.deps as unknown as PhoenixActionDeps);
  const verdict = await adapter.validate(MARKET_BASE, actionCtx(''));
  assert.deepEqual(verdict, {
    title: 'Wallet not ready — connect a Solana wallet that can sign.',
    detail: null,
  });
});

test('phoenix validate: empty amount asks for an amount', () => {
  const fixture = phxDeps();
  const adapter = createPhoenixActionAdapter(fixture.deps as unknown as PhoenixActionDeps);
  assert.deepEqual(adapter.validate(MARKET_BASE, actionCtx('')), {
    title: 'Enter an amount first.',
    detail: null,
  });
});

test('phoenix validate: no displayed price means base amount cannot resolve', () => {
  const fixture = phxDeps({ displayedPrice: null });
  const adapter = createPhoenixActionAdapter(fixture.deps as unknown as PhoenixActionDeps);
  assert.deepEqual(adapter.validate(MARKET_BASE, actionCtx('1')), {
    title: 'Enter a valid amount.',
    detail: null,
  });
});

test('phoenix validate: limit orders need a positive limit price', () => {
  const fixture = phxDeps();
  const adapter = createPhoenixActionAdapter(fixture.deps as unknown as PhoenixActionDeps);
  const body: PhoenixActionBody = { ...MARKET_BASE, orderType: 'limit', limitPriceText: 'not-a-price' };
  assert.deepEqual(adapter.validate(body, actionCtx('1')), {
    title: 'Enter a valid limit price.',
    detail: null,
  });
});

test('phoenix validate: market base-mode order passes', async () => {
  const fixture = phxDeps();
  const adapter = createPhoenixActionAdapter(fixture.deps as unknown as PhoenixActionDeps);
  assert.equal(await adapter.validate(MARKET_BASE, actionCtx('1')), null);
});

test('phoenix quote: base mode rows show price, size and 50 bps slippage', async () => {
  const fixture = phxDeps();
  const adapter = createPhoenixActionAdapter(fixture.deps as unknown as PhoenixActionDeps);
  const quote = await adapter.quote(MARKET_BASE, actionCtx('1'));
  assert.equal(quote.loading, false);
  assert.equal(quote.unavailableReason, null);
  assert.deepEqual(quote.rows, [
    { key: 'EST. PRICE', value: '$142.5000', tone: 'dim' },
    { key: 'EST. SIZE', value: `${formatActionAmount(1, { maxDecimals: 8 })} SOL`, tone: 'neutral' },
    { key: 'SLIPPAGE', value: '50 bps', tone: 'dim' },
  ]);
});

test('phoenix quote: usd notional converts to base size at the displayed price', async () => {
  const fixture = phxDeps();
  const adapter = createPhoenixActionAdapter(fixture.deps as unknown as PhoenixActionDeps);
  const quote = await adapter.quote(MARKET_USD, actionCtx('285'));
  assert.equal(quote.rows[1]?.key, 'EST. SIZE');
  assert.equal(quote.rows[1]?.value, `${formatActionAmount(2, { maxDecimals: 8 })} SOL`);
});

test('phoenix quote: missing price marks the quote unavailable with dashes', async () => {
  const fixture = phxDeps({ displayedPrice: null });
  const adapter = createPhoenixActionAdapter(fixture.deps as unknown as PhoenixActionDeps);
  const quote = await adapter.quote(MARKET_BASE, actionCtx('1'));
  assert.equal(quote.unavailableReason, 'Price unavailable');
  assert.deepEqual(quote.rows, [
    { key: 'EST. PRICE', value: '—', tone: 'dim' },
    { key: 'EST. SIZE', value: '—', tone: 'neutral' },
    { key: 'SLIPPAGE', value: '50 bps', tone: 'dim' },
  ]);
});

test('phoenix confirm keeps long green and short red', () => {
  const fixture = phxDeps();
  const adapter = createPhoenixActionAdapter(fixture.deps as unknown as PhoenixActionDeps);
  assert.deepEqual(adapter.confirm(MARKET_BASE, amountState('1')), { label: 'Long', accent: 'pos' });
  const shortBody: PhoenixActionBody = { ...MARKET_BASE, side: 'short' };
  assert.deepEqual(adapter.confirm(shortBody, amountState('1')), { label: 'Short', accent: 'neg' });
  assert.equal(adapter.amountLabel(MARKET_BASE), 'Amount');
  assert.equal(adapter.amountPrefix(MARKET_USD), '$');
  assert.equal(adapter.amountPrefix(MARKET_BASE), null);
  assert.equal(adapter.amountSuffix(MARKET_BASE), 'SOL');
  assert.equal(adapter.amountSuffix(MARKET_USD), null);
});

test('phoenix submit: market base order submits with 50 bps and records the placement', async () => {
  const fixture = phxDeps();
  const adapter = createPhoenixActionAdapter(fixture.deps as unknown as PhoenixActionDeps);
  const result = await adapter.submit(MARKET_BASE, actionCtx('1'));

  assert.deepEqual(result, {
    status: 'submitted',
    message: 'Submitted: SIG12345…',
    closeAfter: true,
  });
  assert.equal(fixture.orderCalls.length, 1);
  const { input, context } = fixture.orderCalls[0];
  assert.deepEqual(roundTrip(input), {
    venueId: 'phoenix',
    authority: 'PHXWALLET1111111111111111111111111111111111',
    symbol: 'SOL-PERP',
    side: 'long',
    orderType: 'market',
    amountMode: 'base',
    amount: '1',
    slippageBps: 50,
  });
  assert.ok(context.wallet);
  assert.deepEqual(context.connection, FAKE_CONNECTION);
  assert.equal(fixture.pendingCalls.length, 1);
  assert.deepEqual(roundTrip(fixture.pendingCalls[0]), {
    side: 'long',
    orderType: 'market',
    amountBase: 1,
    amountUsdc: 142.5,
    txSignature: FAKE_TX,
  });
  assert.equal(fixture.refreshCount, 1);
});

test('phoenix submit: usd notional converts to base amount before submission', async () => {
  const fixture = phxDeps();
  const adapter = createPhoenixActionAdapter(fixture.deps as unknown as PhoenixActionDeps);
  await adapter.submit(MARKET_USD, actionCtx('285'));
  assert.equal((fixture.orderCalls[0]?.input as Record<string, unknown>).amount, '2');
});

test('phoenix submit: limit order forwards the trimmed price text', async () => {
  const fixture = phxDeps();
  const adapter = createPhoenixActionAdapter(fixture.deps as unknown as PhoenixActionDeps);
  const result = await adapter.submit(LIMIT_LONG, actionCtx('1'));
  assert.equal(result.status, 'submitted');
  const input = fixture.orderCalls[0]?.input as Record<string, unknown>;
  assert.equal(input.orderType, 'limit');
  assert.equal(input.limitPrice, '150');
  assert.equal(input.amountMode, 'base');
});

test('phoenix submit: missing venue identity rejects before any order', async () => {
  const fixture = phxDeps({ venueSymbol: null });
  const adapter = createPhoenixActionAdapter(fixture.deps as unknown as PhoenixActionDeps);
  const result = await adapter.submit(MARKET_BASE, actionCtx('1'));
  assert.deepEqual(result, {
    status: 'rejected',
    message: 'Connect a wallet before placing a Phoenix order.',
  });
  assert.equal(fixture.orderCalls.length, 0);
});

test('phoenix submit: failed venue result rejects with its error message', async () => {
  const fixture = phxDeps({
    placeOrder: (async () => ({ status: 'failed', error: { message: 'insufficient balance' } })) as unknown as typeof placePhoenixOrder,
  });
  const adapter = createPhoenixActionAdapter(fixture.deps as unknown as PhoenixActionDeps);
  const result = await adapter.submit(MARKET_BASE, actionCtx('1'));
  assert.deepEqual(result, { status: 'rejected', message: 'insufficient balance' });
  assert.equal(fixture.pendingCalls.length, 0);
  assert.equal(fixture.refreshCount, 0);
});

test('phoenix submit: submitted without a signature still closes with the generic message', async () => {
  const fixture = phxDeps({
    placeOrder: (async () => ({ status: 'submitted' })) as unknown as typeof placePhoenixOrder,
  });
  const adapter = createPhoenixActionAdapter(fixture.deps as unknown as PhoenixActionDeps);
  const result = await adapter.submit(MARKET_BASE, actionCtx('1'));
  assert.deepEqual(result, {
    status: 'submitted',
    message: 'Phoenix order submitted.',
    closeAfter: true,
  });
  assert.equal(fixture.pendingCalls.length, 0);
  assert.equal(fixture.refreshCount, 0);
});
