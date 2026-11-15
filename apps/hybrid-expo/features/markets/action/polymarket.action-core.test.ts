import test from 'node:test';
import assert from 'node:assert/strict';
import type { ActionAmountState, ActionPanelContext } from '@/features/markets/action/action.contract';
import { formatActionAmount } from '@/features/markets/action/action.contract';
import {
  createPolymarketActionAdapter,
  type PolymarketActionBody,
  type PolymarketActionDeps,
} from './polymarket.action-core';
import type {
  fetchClobBalance,
  fetchOrderbook,
  placeBet,
} from '@/features/polymarket/polymarket.api';
import type { getPolymarketOrderGuardrail } from '@/features/polymarket/polymarketActivityState';
import { getMinimumOrderGuardrail } from '@/features/polymarket/minimumOrderSize';

type OrderbookForTests = Awaited<ReturnType<typeof fetchOrderbook>>;

/**
 * Book fixture asks are walked cheapest-first by buildExecutableBuyQuote:
 * $50 of buys fill 50 shares at 0.60 (30 dollars) plus 20/0.61 shares at 0.61,
 * for average price 50 / 82.786885... and a limit price of 0.61.
 */
const BOOK: OrderbookForTests = {
  bids: [{ price: 0.58, size: 100 }],
  asks: [
    { price: 0.6, size: 50 },
    { price: 0.61, size: 100 },
  ],
  minOrderSize: 5,
  lastPrice: 0.6,
  spread: 0.02,
} as unknown as OrderbookForTests;

const EMPTY_BOOK: OrderbookForTests = {
  bids: [],
  asks: [],
  minOrderSize: 5,
  lastPrice: 0.6,
  spread: 0.02,
} as unknown as OrderbookForTests;

const amountState = (text: string): ActionAmountState => ({
  amountText: text,
  amountValue: text.trim() === '' ? null : Number(text),
});

const actionCtx = (text: string): ActionPanelContext<void> => ({
  amount: amountState(text),
  extra: undefined,
});

const MARKET_BODY: PolymarketActionBody = { mode: 'market', limitPriceCentsText: '' };
const LIMIT_BODY_62: PolymarketActionBody = { mode: 'limit', limitPriceCentsText: '62' };

function polyDeps(overrides: Partial<PolymarketActionDeps> = {}): PolymarketActionDeps {
  const bookCalls: string[] = [];
  const cashCalls: Array<number | null | ((prev: number | null) => number | null)> = [];
  const pendingCalls: Array<(prev: Array<never>) => Array<never>> = [];
  const guardrailCalls: Array<Record<string, unknown>> = [];
  const pickCalls: number[] = [];
  const bookRefreshCalls: number[] = [];
  const reconcileCalls: number[] = [];
  const enableCalls: number[] = [];
  const CLIENT = { marker: 'fake-secure-client' } as unknown as PolymarketActionDeps['poly']['client'];

  const fakeFetchOrderbook: typeof fetchOrderbook = async (tokenID: string) => {
    bookCalls.push(tokenID);
    return BOOK;
  };
  const fakeFetchClobBalance: typeof fetchClobBalance = async () => ({ balance: 42.5, allowance: 0 });
  const fakePlaceBet: typeof placeBet = async (client, params) => {
    void client;
    void params;
    return { success: true, orderID: 'op-1', operationId: 'op-1', executionPrice: 0.61, shares: 82.78688524590164 };
  };
  const fakeGuardrail: typeof getPolymarketOrderGuardrail = (input: Record<string, unknown>) => {
    guardrailCalls.push(input);
    return null;
  };

  const deps: PolymarketActionDeps = {
    poly: {
      canSignLocally: true,
      enable: async () => {
        enableCalls.push(1);
        return null;
      },
      client: CLIENT,
    },
    tokenID: '0xTOKEN',
    outcomeLabel: 'Yes',
    slug: 'btc-100k-up',
    selectedPrice: 0.6,
    latestPrice: 0.6,
    marketActive: true,
    endDate: null,
    cashBalance: 100,
    setCashBalance: (next) => {
      cashCalls.push(next);
    },
    setPendingOpenOrders: (updater) => {
      pendingCalls.push(updater as unknown as (prev: Array<never>) => Array<never>);
    },
    fetchOrderbook: fakeFetchOrderbook,
    fetchClobBalance: fakeFetchClobBalance,
    placeBet: fakePlaceBet,
    guardrail: fakeGuardrail,
    loadPicks: async () => {
      pickCalls.push(1);
      return null;
    },
    refreshOrderbook: async () => {
      bookRefreshCalls.push(1);
      return null;
    },
    scheduleFollowUpReconcile: () => {
      reconcileCalls.push(1);
    },
    ...overrides,
  };
  return {
    ...deps,
    __spies: {
      bookCalls,
      cashCalls,
      pendingCalls,
      guardrailCalls,
      pickCalls,
      bookRefreshCalls,
      reconcileCalls,
      enableCalls,
      CLIENT,
      fakeGuardrail,
    },
  } as unknown as PolymarketActionDeps;
}

test('validate returns no token ID error when token is missing', () => {
  const adapter = createPolymarketActionAdapter(polyDeps({ tokenID: undefined }));
  assert.deepEqual(adapter.validate(MARKET_BODY, actionCtx('50')), {
    title: 'No token ID for this outcome',
    detail: null,
  });
});

test('validate returns invalid price when latest price is out of range', () => {
  const adapter = createPolymarketActionAdapter(polyDeps({ latestPrice: 0 }));
  assert.deepEqual(adapter.validate(MARKET_BODY, actionCtx('50')), {
    title: 'Invalid price',
    detail: null,
  });
});

test('validate returns enter an amount for missing amount', () => {
  const adapter = createPolymarketActionAdapter(polyDeps());
  assert.deepEqual(adapter.validate(MARKET_BODY, actionCtx('')), {
    title: 'Enter an amount',
    detail: null,
  });
});

test('validate returns enter a limit price for empty limit price text', () => {
  const adapter = createPolymarketActionAdapter(polyDeps());
  assert.deepEqual(adapter.validate({ mode: 'limit', limitPriceCentsText: '' }, actionCtx('50')), {
    title: 'Enter a limit price',
    detail: null,
  });
});

test('validate maps a blocking guardrail to title/detail', () => {
  const base = polyDeps();
  const adapter = createPolymarketActionAdapter({
    ...base,
    guardrail: () => ({ blocking: true, title: 'Not enough cash', message: 'Reduce the amount.' }),
  } as Partial<PolymarketActionDeps> as PolymarketActionDeps);
  assert.deepEqual(adapter.validate(MARKET_BODY, actionCtx('50')), {
    title: 'Not enough cash',
    detail: 'Reduce the amount.',
  });
});

test('validate passes the expected input into the guardrail', () => {
  const deps = polyDeps();
  const adapter = createPolymarketActionAdapter(deps);
  const verdict = adapter.validate(MARKET_BODY, actionCtx('50'));
  assert.equal(verdict, null);
  const spies = (deps as unknown as { __spies: { guardrailCalls: Array<Record<string, unknown>> } }).__spies;
  assert.deepEqual(spies.guardrailCalls[0], {
    amount: 50,
    availableCash: 100,
    selectedPrice: 0.6,
    latestPrice: 0.6,
    marketActive: true,
    submitting: false,
  });
});

test('market quote walks the book and reports avg price with shares', async () => {
  const adapter = createPolymarketActionAdapter(polyDeps());
  const quote = await adapter.quote(MARKET_BODY, actionCtx('50'));
  // buildExecutableBuyQuote floors each level's shares to 2dp and floors the
  // total again: $50 buys 50 shares at 0.60 plus the remainder at 0.61.
  const levelShares = Math.floor((30 / 0.6) * 100) / 100;
  const levelTwoCost = 50 - levelShares * 0.6;
  const expectedShares =
    Math.floor((levelShares + Math.floor((levelTwoCost / 0.61) * 100) / 100) * 100) / 100;
  assert.equal(quote.unavailableReason, null);
  assert.equal(quote.rows[0]?.key, 'AVG PRICE');
  assert.equal(quote.rows[0]?.value, `${Math.round((50 / expectedShares) * 100)}¢`);
  assert.equal(quote.rows[1]?.key, 'EST. SHARES');
  assert.equal(quote.rows[1]?.value, formatActionAmount(expectedShares, { maxDecimals: 2 }));
});

test('limit quote reports cents limit and implied shares', async () => {
  const adapter = createPolymarketActionAdapter(polyDeps());
  const quote = await adapter.quote(LIMIT_BODY_62, actionCtx('50'));
  assert.equal(quote.unavailableReason, null);
  assert.deepEqual(quote.rows, [
    { key: 'LIMIT PRICE', value: '62¢' },
    { key: 'EST. SHARES', value: formatActionAmount(50 / 0.62, { maxDecimals: 2 }) },
  ]);
});

test('quote reports enter an amount first when amount is missing', async () => {
  const adapter = createPolymarketActionAdapter(polyDeps());
  const quote = await adapter.quote(MARKET_BODY, actionCtx(''));
  assert.equal(quote.unavailableReason, 'Enter an amount first');
  assert.deepEqual(quote.rows, []);
});

test('quote reports orderbook unavailable when the book fetch throws', async () => {
  const deps = polyDeps();
  const adapter = createPolymarketActionAdapter({
    ...deps,
    fetchOrderbook: (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetchOrderbook,
  });
  const quote = await adapter.quote(MARKET_BODY, actionCtx('50'));
  assert.equal(quote.unavailableReason, 'Orderbook unavailable');
});

test('market submit places FOK bet, adds pending order and updates balance', async () => {
  const deps = polyDeps();
  const adapter = createPolymarketActionAdapter(deps);
  const result = await adapter.submit(MARKET_BODY, actionCtx('50'));
  const spies = (deps as unknown as {
    __spies: {
      cashCalls: Array<number | null | ((prev: number | null) => number | null)>;
      pendingCalls: Array<(prev: Array<unknown>) => Array<unknown>>;
      pickCalls: number[];
      bookRefreshCalls: number[];
      reconcileCalls: number[];
      enableCalls: number[];
      CLIENT: unknown;
    };
  }).__spies;

  assert.equal(result.status, 'submitted');
  assert.equal(result.message, `Placed: $${formatActionAmount(50)} on Yes.`);
  assert.equal(result.closeAfter, true);
  assert.equal(spies.enableCalls.length, 0);

  const applied = spies.pendingCalls[0](([] as unknown) as Array<unknown>);
  assert.equal(applied.length, 1);
  const pending = applied[0] as { id: string; asset_id: string; price: string; outcome: string };
  assert.equal(pending.id, 'op-1');
  assert.equal(pending.asset_id, '0xTOKEN');
  assert.equal(pending.price, String(0.61));
  assert.equal(pending.outcome, 'Yes');

  const localCash = spies.cashCalls[0] as (prev: number | null) => number | null;
  assert.equal(localCash(100), 50);
  assert.equal(spies.cashCalls[1], 42.5);
  assert.equal(spies.pickCalls.length, 1);
  assert.equal(spies.bookRefreshCalls.length, 1);
  assert.equal(spies.reconcileCalls.length, 1);
});

test('market submit passes executable quote into the FOK bet params', async () => {
  const placeCalls: Array<{ params: Record<string, unknown>; client: unknown }> = [];
  const deps = polyDeps({
    placeBet: (async (client: unknown, params: Record<string, unknown>) => {
      placeCalls.push({ client, params });
      return { success: true, orderID: 'op-2', operationId: 'op-2' };
    }) as unknown as PolymarketActionDeps['placeBet'],
  });
  const adapter = createPolymarketActionAdapter(deps);
  const spies = (deps as unknown as { __spies: { CLIENT: unknown } }).__spies;
  await adapter.submit(MARKET_BODY, actionCtx('50'));
  assert.equal(placeCalls.length, 1);
  // Same 2dp per-level floor as the quote walk mirrors above.
  const levelShares = Math.floor((30 / 0.6) * 100) / 100;
  const levelTwoCost = 50 - levelShares * 0.6;
  const expectedShares =
    Math.floor((levelShares + Math.floor((levelTwoCost / 0.61) * 100) / 100) * 100) / 100;
  assert.deepEqual(placeCalls[0]?.params, {
    tokenID: '0xTOKEN',
    price: 0.61,
    size: expectedShares,
    amount: 50,
    side: 'BUY',
    orderType: 'FOK',
  });
  assert.equal(placeCalls[0]?.client, spies.CLIENT);
});

test('market submit rejects with liquidity message on an empty book', async () => {
  const deps = polyDeps();
  const adapter = createPolymarketActionAdapter({
    ...deps,
    fetchOrderbook: (async () => EMPTY_BOOK) as unknown as typeof fetchOrderbook,
  });
  const result = await adapter.submit(MARKET_BODY, actionCtx('50'));
  assert.equal(result.status, 'rejected');
  assert.equal(
    result.message,
    'Not filled: not enough liquidity at the current price. Try a smaller amount or refresh the market.',
  );
});

test('market submit rejects with the minimum order guardrail message', async () => {
  const deps = polyDeps();
  const adapter = createPolymarketActionAdapter(deps);
  const spies = (deps as unknown as {
    __spies: { pendingCalls: Array<unknown>; guardrailCalls: Array<unknown> };
  }).__spies;
  // $1 against a book priced 0.60 fills 1.66 shares (per-level 2dp floor)
  // whose cost rounds to $1.00, so the walk average is 0.6024. Below the
  // fixture's minOrderSize of 5, the guardrail blocks and its required-spend
  // format is ceiled ($3.02), never understating what the composer needs.
  const levelShares = Math.floor((1 / 0.6) * 100) / 100;
  const roundedShares = Math.floor(levelShares * 100) / 100;
  const roundedCost = Math.round((levelShares * 0.6) * 100) / 100;
  const guardrail = getMinimumOrderGuardrail({
    orderSize: roundedShares,
    minimumOrderSize: 5,
    executionPrice: roundedCost / roundedShares,
  });
  assert.ok(guardrail, 'fixture should trigger the minimum order guardrail');
  const result = await adapter.submit(MARKET_BODY, actionCtx('1'));
  assert.equal(result.status, 'rejected');
  assert.equal(result.message, `${guardrail.title} — ${guardrail.message}`);
  assert.equal(spies.pendingCalls.length, 0);
});

test('market submit surfaces placeBet failure as rejection message', async () => {
  const deps = polyDeps({
    placeBet: (async () => ({
      success: false,
      error: 'Price moved too far',
    })) as unknown as PolymarketActionDeps['placeBet'],
  });
  const adapter = createPolymarketActionAdapter(deps);
  const result = await adapter.submit(MARKET_BODY, actionCtx('50'));
  assert.equal(result.status, 'rejected');
  assert.equal(result.message, 'Price moved too far');
});

test('limit submit places a GTD bet with expiration and pending order', async () => {
  const placeCalls: Array<Record<string, unknown>> = [];
  const endDate = '2027-01-01T00:00:00.000Z';
  const deps = polyDeps({
    endDate,
    placeBet: (async (_client: unknown, params: Record<string, unknown>) => {
      placeCalls.push(params);
      return { success: true, orderID: 'op-7', operationId: 'op-9' };
    }) as unknown as PolymarketActionDeps['placeBet'],
  });
  const adapter = createPolymarketActionAdapter(deps);
  const result = await adapter.submit(LIMIT_BODY_62, actionCtx('50'));
  assert.equal(result.status, 'submitted');
  assert.equal(result.message, `Placed: $${formatActionAmount(50)} on Yes.`);
  assert.equal(placeCalls.length, 1);
  assert.deepEqual(placeCalls[0], {
    tokenID: '0xTOKEN',
    price: 0.62,
    size: 50 / 0.62,
    side: 'BUY',
    orderType: 'GTD',
    expiration: Math.floor(Date.parse(endDate) / 1000),
  });
  const spies = (deps as unknown as {
    __spies: { pendingCalls: Array<(prev: Array<unknown>) => Array<unknown>> };
  }).__spies;
  const applied = spies.pendingCalls[0](([] as unknown) as Array<unknown>);
  const pending = applied[0] as { id: string; price: string };
  assert.equal(pending.id, 'op-7');
  assert.equal(pending.price, String(0.62));
});

test('limit submit rejects when the market lacks a future deadline', async () => {
  const placeCalls: Array<unknown> = [];
  const deps = polyDeps({
    endDate: new Date(Date.now() + 10_000).toISOString(),
    placeBet: (async (_client: unknown, params: Record<string, unknown>) => {
      placeCalls.push(params);
      return { success: true, orderID: 'op-8', operationId: 'op-8' };
    }) as unknown as PolymarketActionDeps['placeBet'],
  });
  const adapter = createPolymarketActionAdapter(deps);
  const result = await adapter.submit(LIMIT_BODY_62, actionCtx('50'));
  assert.equal(result.status, 'rejected');
  assert.equal(
    result.message,
    'This market has no future deadline for a limit order. Use a market order instead.',
  );
  assert.equal(placeCalls.length, 0);
});

test('submit rejects before touching the wallet when amount is missing', async () => {
  const deps = polyDeps();
  const adapter = createPolymarketActionAdapter(deps);
  const result = await adapter.submit(MARKET_BODY, actionCtx(''));
  assert.deepEqual(result, { status: 'rejected', message: 'Enter an amount first.' });
  const spies = (deps as unknown as { __spies: { enableCalls: number[] } }).__spies;
  assert.equal(spies.enableCalls.length, 0);
});

test('submit enables the session before betting when local signing is off', async () => {
  const base = polyDeps();
  const poly = base.poly;
  assert.ok(poly);
  const adapter = createPolymarketActionAdapter({
    ...base,
    poly: { ...poly, canSignLocally: false },
  } as Partial<PolymarketActionDeps> as PolymarketActionDeps);
  const result = await adapter.submit(MARKET_BODY, actionCtx('50'));
  assert.equal(result.status, 'submitted');
  const spies = (base as unknown as { __spies: { enableCalls: number[] } }).__spies;
  assert.equal(spies.enableCalls.length, 1);
});
