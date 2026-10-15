import assert from 'node:assert/strict';
import test from 'node:test';
import { createTradeHistoryStore, makeTradeRecordId, type TradeRecord } from './tradeHistoryStore';

const record = (id: string): TradeRecord => ({
  id,
  symbol: 'BTC-PERP',
  side: 'long',
  size: 1,
  entryPrice: 100,
  exitPrice: 110,
  pnl: 10,
  closedAt: 1,
  type: 'market_close',
});

const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

test('concurrent trade history saves preserve both records', async () => {
  let stored: string | null = null;
  const store = createTradeHistoryStore({
    async getItem() {
      await delay();
      return stored;
    },
    async setItem(_key, value) {
      await delay();
      stored = value;
    },
  });

  await Promise.all([store.saveTradeRecord(record('first')), store.saveTradeRecord(record('second'))]);

  assert.deepEqual((await store.loadTradeHistory()).map(({ id }) => id), ['second', 'first']);
});

test('corrupt or non-array stored history is reset so the new record still saves', async () => {
  for (const initialValue of ['{broken json', '{"old":true}']) {
    let stored: string | null = initialValue;
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    const store = createTradeHistoryStore({
      async getItem() { return stored; },
      async setItem(_key, value) { stored = value; },
    });

    try {
      await store.saveTradeRecord(record('saved'));
    } finally {
      console.warn = originalWarn;
    }

    assert.deepEqual(JSON.parse(stored ?? 'null'), [record('saved')]);
    assert.equal(warnings.length, 1);
  }
});

test('trade record ids differ when created in the same millisecond', () => {
  const originalNow = Date.now;
  const originalRandom = Math.random;
  let random = 0.1;
  Date.now = () => 1234;
  Math.random = () => {
    const value = random;
    random += 0.1;
    return value;
  };

  try {
    assert.notEqual(makeTradeRecordId('BTC-PERP'), makeTradeRecordId('BTC-PERP'));
  } finally {
    Date.now = originalNow;
    Math.random = originalRandom;
  }
});

test('a failed trade history save is reported and does not block the next save', async () => {
  let stored: string | null = null;
  let shouldFail = true;
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };

  const store = createTradeHistoryStore({
    async getItem() { return stored; },
    async setItem(_key, value) {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('storage unavailable');
      }
      stored = value;
    },
  });

  try {
    await assert.rejects(store.saveTradeRecord(record('failed')), /storage unavailable/);
    await store.saveTradeRecord(record('saved'));
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /Failed to save trade history/);
  assert.deepEqual((await store.loadTradeHistory()).map(({ id }) => id), ['saved']);
});
