import test from 'node:test';
import assert from 'node:assert/strict';
import type { ActionAmountState, ActionPanelContext } from '@/features/markets/action/action.contract';
import { formatActionAmount } from '@/features/markets/action/action.contract';
import { PACIFIC_BUILDER_CODE } from '@/features/perps/pacific.config';
import type { placeLimitOrder, placeOrder, setTPSL } from '@/features/perps/perps.signed-api';
import {
  createPacificaActionAdapter,
  type PacificaActionBody,
  type PacificaActionDeps,
} from './pacifica.action-core';

const amountState = (text: string): ActionAmountState => ({
  amountText: text,
  amountValue: text.trim() === '' ? null : Number(text),
});

const actionCtx = (text: string): ActionPanelContext<void> => ({
  amount: amountState(text),
  extra: undefined,
});

const MARKET_LONG: PacificaActionBody = {
  side: 'long',
  orderType: 'market',
  limitPriceText: '',
  tpPriceText: '',
  slPriceText: '',
};
const MARKET_LONG_TPSL: PacificaActionBody = { ...MARKET_LONG, tpPriceText: '160', slPriceText: '130' };
const LIMIT_LONG: PacificaActionBody = { ...MARKET_LONG, orderType: 'limit', limitPriceText: '150' };
const LIMIT_LONG_TPSL: PacificaActionBody = { ...LIMIT_LONG, tpPriceText: '160', slPriceText: '130' };

const EXPECTED_BUILDER_CODE = PACIFIC_BUILDER_CODE || undefined;

type Call = { params: Record<string, unknown>; account: string; signMessage: unknown };

function pacDeps(overrides: Record<string, unknown> = {}): {
  deps: Record<string, unknown>;
  limitCalls: Call[];
  marketCalls: Call[];
  tpslCalls: Call[];
  refreshCount: number;
} {
  const limitCalls: Call[] = [];
  const marketCalls: Call[] = [];
  const tpslCalls: Call[] = [];
  let refreshCount = 0;

  const signMessage = async () => new Uint8Array(64);
  const deps: Record<string, unknown> = {
    symbol: 'SOL-PERP',
    maxNotional: 2000,
    availableBalanceText: '$200.00',
    address: 'PACWALLET1111111111111111111111111111111111',
    signMessage,
    refresh: () => {
      refreshCount += 1;
    },
    placeLimitOrder: (async (params: unknown, account: string, sign: unknown) => {
      limitCalls.push({ params: params as Record<string, unknown>, account, signMessage: sign });
      return 111;
    }) as unknown as typeof placeLimitOrder,
    placeOrder: (async (params: unknown, account: string, sign: unknown) => {
      marketCalls.push({ params: params as Record<string, unknown>, account, signMessage: sign });
      return 222;
    }) as unknown as typeof placeOrder,
    setTPSL: (async (params: unknown, account: string) => {
      tpslCalls.push({ params: params as Record<string, unknown>, account, signMessage: undefined });
    }) as unknown as typeof setTPSL,
    ...overrides,
  };
  return { deps, limitCalls, marketCalls, tpslCalls, get refreshCount() { return refreshCount; } };
}

test('pacifica validate: unbound wallet is blocked first', () => {
  const fixture = pacDeps({ address: null });
  const adapter = createPacificaActionAdapter(fixture.deps as unknown as PacificaActionDeps);
  assert.deepEqual(adapter.validate(MARKET_LONG, actionCtx('50')), {
    title: 'Connect a wallet to trade Pacifica.',
    detail: null,
  });
});

test('pacifica validate: missing signMessage is treated the same as no wallet', () => {
  const fixture = pacDeps({ signMessage: null });
  const adapter = createPacificaActionAdapter(fixture.deps as unknown as PacificaActionDeps);
  assert.deepEqual(adapter.validate(MARKET_LONG, actionCtx('50')), {
    title: 'Connect a wallet to trade Pacifica.',
    detail: null,
  });
});

test('pacifica validate: empty and non-positive amounts are rejected', () => {
  const adapter = createPacificaActionAdapter(pacDeps().deps as unknown as PacificaActionDeps);
  assert.deepEqual(adapter.validate(MARKET_LONG, actionCtx('')), {
    title: 'Enter a valid amount.',
    detail: null,
  });
  assert.deepEqual(adapter.validate(MARKET_LONG, actionCtx('0')), {
    title: 'Enter a valid amount.',
    detail: null,
  });
});

test('pacifica validate: notional above max includes the formatted max in the title', () => {
  const adapter = createPacificaActionAdapter(pacDeps().deps as unknown as PacificaActionDeps);
  assert.deepEqual(adapter.validate(MARKET_LONG, actionCtx('2000.01')), {
    title: `Notional exceeds your max: $${formatActionAmount(2000)}.`,
    detail: null,
  });
});

test('pacifica validate: amount exactly at max still passes', () => {
  const adapter = createPacificaActionAdapter(pacDeps().deps as unknown as PacificaActionDeps);
  assert.equal(adapter.validate(MARKET_LONG, actionCtx('2000')), null);
});

test('pacifica validate: limit orders need a positive limit price', () => {
  const adapter = createPacificaActionAdapter(pacDeps().deps as unknown as PacificaActionDeps);
  const body: PacificaActionBody = { ...MARKET_LONG, orderType: 'limit', limitPriceText: '' };
  assert.deepEqual(adapter.validate(body, actionCtx('50')), {
    title: 'Enter a valid limit price.',
    detail: null,
  });
  const badBody: PacificaActionBody = { ...MARKET_LONG, orderType: 'limit', limitPriceText: 'abc' };
  assert.deepEqual(adapter.validate(badBody, actionCtx('50')), {
    title: 'Enter a valid limit price.',
    detail: null,
  });
});

test('pacifica validate: bad take-profit and stop-loss prices are rejected', () => {
  const adapter = createPacificaActionAdapter(pacDeps().deps as unknown as PacificaActionDeps);
  const tpBody: PacificaActionBody = { ...MARKET_LONG, tpPriceText: 'abc' };
  assert.deepEqual(adapter.validate(tpBody, actionCtx('50')), {
    title: 'Enter a valid take-profit price.',
    detail: null,
  });
  const slBody: PacificaActionBody = { ...MARKET_LONG, slPriceText: 'abc' };
  assert.deepEqual(adapter.validate(slBody, actionCtx('50')), {
    title: 'Enter a valid stop-loss price.',
    detail: null,
  });
});

test('pacifica validate: market order with valid amount passes', () => {
  const adapter = createPacificaActionAdapter(pacDeps().deps as unknown as PacificaActionDeps);
  assert.equal(adapter.validate(MARKET_LONG, actionCtx('50')), null);
});

test('pacifica quote: shows max notional, available balance and 1% slippage', async () => {
  const adapter = createPacificaActionAdapter(pacDeps().deps as unknown as PacificaActionDeps);
  const quote = await adapter.quote(MARKET_LONG, actionCtx('50'));
  assert.equal(quote.loading, false);
  assert.equal(quote.unavailableReason, null);
  assert.deepEqual(quote.rows, [
    { key: 'MAX NOTIONAL', value: `$${formatActionAmount(2000)}`, tone: 'neutral' },
    { key: 'AVAILABLE', value: '$200.00', tone: 'dim' },
    { key: 'SLIPPAGE', value: '1%', tone: 'dim' },
  ]);
});

test('pacifica quote: null max notional and balance render as dashes', async () => {
  const fixture = pacDeps({ maxNotional: null, availableBalanceText: null });
  const adapter = createPacificaActionAdapter(fixture.deps as unknown as PacificaActionDeps);
  const quote = await adapter.quote(MARKET_LONG, actionCtx('50'));
  assert.deepEqual(quote.rows, [
    { key: 'MAX NOTIONAL', value: '—', tone: 'neutral' },
    { key: 'AVAILABLE', value: '—', tone: 'dim' },
    { key: 'SLIPPAGE', value: '1%', tone: 'dim' },
  ]);
});

test('pacifica submit: market long routes through placeOrder at 1% slippage', async () => {
  const fixture = pacDeps();
  const adapter = createPacificaActionAdapter(fixture.deps as unknown as PacificaActionDeps);
  const result = await adapter.submit(MARKET_LONG, actionCtx('50'));

  assert.deepEqual(result, { status: 'submitted', message: 'Executed — see positions', closeAfter: true });
  assert.equal(fixture.marketCalls.length, 1);
  assert.equal(fixture.limitCalls.length, 0);
  assert.equal(fixture.tpslCalls.length, 0);
  const { params, account, signMessage } = fixture.marketCalls[0];
  assert.deepEqual(params, {
    symbol: 'SOL-PERP',
    side: 'bid',
    amountUsdc: 50,
    slippage: '1',
    builderCode: EXPECTED_BUILDER_CODE,
  });
  assert.equal(account, 'PACWALLET1111111111111111111111111111111111');
  assert.ok(signMessage);
  assert.equal(fixture.refreshCount, 1);
});

test('pacifica submit: market short maps to the ask side', async () => {
  const fixture = pacDeps();
  const adapter = createPacificaActionAdapter(fixture.deps as unknown as PacificaActionDeps);
  await adapter.submit({ ...MARKET_LONG, side: 'short' }, actionCtx('50'));
  assert.equal(fixture.marketCalls[0]?.params.side, 'ask');
});

test('pacifica submit: market order with TP/SL calls setTPSL after entry', async () => {
  const fixture = pacDeps();
  const adapter = createPacificaActionAdapter(fixture.deps as unknown as PacificaActionDeps);
  const result = await adapter.submit(MARKET_LONG_TPSL, actionCtx('50'));

  assert.equal(result.status, 'submitted');
  assert.equal(fixture.tpslCalls.length, 1);
  assert.deepEqual(fixture.tpslCalls[0]?.params, {
    symbol: 'SOL-PERP',
    side: 'bid',
    takeProfit: { stopPrice: '160', limitPrice: '160' },
    stopLoss: { stopPrice: '130', limitPrice: '130' },
    builderCode: EXPECTED_BUILDER_CODE,
  });
  assert.equal(fixture.refreshCount, 1);
});

test('pacifica submit: TP/SL failure on a filled order reports partial', async () => {
  const fixture = pacDeps({
    setTPSL: (async () => {
      throw new Error('tpsl rejected');
    }) as unknown as typeof setTPSL,
  });
  const adapter = createPacificaActionAdapter(fixture.deps as unknown as PacificaActionDeps);
  const result = await adapter.submit(MARKET_LONG_TPSL, actionCtx('50'));
  assert.deepEqual(result, {
    status: 'partial',
    message: 'Order placed — TP/SL failed, set it manually.',
    closeAfter: false,
  });
  assert.equal(fixture.refreshCount, 0);
});

test('pacifica submit: limit order sends numeric price with usdc amount', async () => {
  const fixture = pacDeps();
  const adapter = createPacificaActionAdapter(fixture.deps as unknown as PacificaActionDeps);
  const result = await adapter.submit(LIMIT_LONG, actionCtx('50'));

  assert.deepEqual(result, { status: 'submitted', message: 'Executed — see positions', closeAfter: true });
  assert.equal(fixture.limitCalls.length, 1);
  assert.equal(fixture.marketCalls.length, 0);
  assert.deepEqual(fixture.limitCalls[0]?.params, {
    symbol: 'SOL-PERP',
    side: 'bid',
    price: 150,
    amountUsdc: 50,
    builderCode: EXPECTED_BUILDER_CODE,
  });
  assert.equal(fixture.refreshCount, 1);
});

test('pacifica submit: TP/SL is market-only and never fires on limits', async () => {
  const fixture = pacDeps();
  const adapter = createPacificaActionAdapter(fixture.deps as unknown as PacificaActionDeps);
  await adapter.submit(LIMIT_LONG_TPSL, actionCtx('50'));
  assert.equal(fixture.tpslCalls.length, 0);
});

test('pacifica submit: unbound wallet rejects before any signed call', async () => {
  const fixture = pacDeps({ signMessage: null });
  const adapter = createPacificaActionAdapter(fixture.deps as unknown as PacificaActionDeps);
  const result = await adapter.submit(MARKET_LONG, actionCtx('50'));
  assert.deepEqual(result, {
    status: 'rejected',
    message: 'Connect a wallet before placing a Pacifica order.',
  });
  assert.equal(fixture.marketCalls.length, 0);
  assert.equal(fixture.limitCalls.length, 0);
  assert.equal(fixture.refreshCount, 0);
});

test('pacifica submit: bad amount rejects before any signed call', async () => {
  const fixture = pacDeps();
  const adapter = createPacificaActionAdapter(fixture.deps as unknown as PacificaActionDeps);
  const result = await adapter.submit(MARKET_LONG, actionCtx(''));
  assert.deepEqual(result, { status: 'rejected', message: 'Enter a valid amount.' });
  assert.equal(fixture.marketCalls.length, 0);
  assert.equal(fixture.refreshCount, 0);
});
