import { describe, expect, test, vi } from 'vitest';

import { parseWebReaderConfig, type WebReaderConfig } from './config.js';
import type { FetchPageResult } from './fetch-article.js';
import { BODY_UNAVAILABLE, type HermesBodyInput } from './hermes-body.js';
import {
  processSignal,
  runWebReaderOnce,
  webReaderMain,
  type BodyStatus,
  type PendingSignal,
  type ReaderDb,
  type WebReaderMainOptions,
} from './reader.js';

/** Row status includes 'pending': a state the real column can hold. */
type RowStatus = BodyStatus | 'pending' | null;

/** In-memory stand-in for the selected SQL (mocks the SELECT/UPDATE — no real database). */
class FakeSignalStore implements ReaderDb {
  rows: Array<{ signalId: string; link: string; title: string | null; body: string | null; bodyStatus: RowStatus; fetchedAtMs: number }> = [];
  updateCalls: Array<{ signalId: string; body: string | null; bodyStatus: BodyStatus }> = [];
  selectCalls = 0;

  add(signalId: string, link: string, title: string | null, fetchedAtMs = 0, bodyStatus: RowStatus = null): void {
    this.rows.push({ signalId, link, title, body: null, bodyStatus, fetchedAtMs });
  }

  /** Mimics: type/source/link fixed by construction; body_status IS NULL or 'pending'; newest fetched_at first; LIMIT n. */
  async selectPendingSignals(limit: number): Promise<PendingSignal[]> {
    this.selectCalls += 1;
    return this.rows
      .filter((row) => row.bodyStatus === null || row.bodyStatus === 'pending')
      .sort((a, b) => b.fetchedAtMs - a.fetchedAtMs)
      .slice(0, limit)
      .map(({ signalId, link, title }) => ({ signalId, link, title }));
  }

  async recordResult(update: { signalId: string; body: string | null; bodyStatus: BodyStatus }): Promise<void> {
    this.updateCalls.push(update);
    const row = this.rows.find((row) => row.signalId === update.signalId);
    if (row) {
      row.body = update.body;
      row.bodyStatus = update.bodyStatus;
    }
  }
}

function stubConfig(overrides: Partial<WebReaderConfig> = {}): WebReaderConfig {
  return {
    ...parseWebReaderConfig({ WEB_READER_DATABASE_URL: 'postgres://web_reader_worker@localhost/db' }),
    ...overrides,
  };
}

function okHtml(html: string): FetchPageResult {
  return {
    ok: true,
    page: {
      url: 'https://example.test/article',
      status: 200,
      contentType: 'text/html; charset=utf-8',
      text: html,
    },
  };
}

/** Long enough to pass the 200-char bar, and overlapping a common title. */
const READABLE_HTML = `<html><body>
  <article><p>North Korea denies the multi-million Binance hack and calls the FBI finding a political provocation.
  The statement was carried by state media, and the denial was immediately repeated by officials in Seoul,
  where analysts noted the accusation arrived weeks after the exchange froze suspicious transfers.</p></article>
</body></html>`;

const TITLE = 'North Korea denies Binance hack';

describe('processSignal (#582)', () => {
  function recorder() {
    const updates: Array<{ signalId: string; body: string | null; bodyStatus: BodyStatus }> = [];
    return {
      updates,
      record: (bodyStatus: BodyStatus, body: string | null) => {
        updates.push({ signalId: 's1', body, bodyStatus });
        return Promise.resolve();
      },
    };
  }

  test('paywall host: unavailable, no fetch, no hermes', async () => {
    const { updates, record } = recorder();
    const fetchPageImpl = vi.fn<FetchPageRunnerStub>();
    const hermes = vi.fn();
    const status = await processSignal(
      { signalId: 's1', link: 'https://www.wsj.com/markets/story', title: 'Markets move' },
      { config: stubConfig(), fetchPageImpl, hermes, record, log: () => {} },
    );
    expect(status).toBe('unavailable');
    expect(updates).toEqual([{ signalId: 's1', body: null, bodyStatus: 'unavailable' }]);
    expect(fetchPageImpl).not.toHaveBeenCalled();
    expect(hermes).not.toHaveBeenCalled();
  });

  test('plain fetch + overlap: ok, body capped to the configured length', async () => {
    const { updates, record } = recorder();
    const hermes = vi.fn();
    const status = await processSignal(
      { signalId: 's1', link: 'https://example.test/article', title: TITLE },
      {
        config: stubConfig({ bodyCapChars: 200 }),
        fetchPageImpl: async () => okHtml(READABLE_HTML),
        hermes,
        record,
        log: () => {},
      },
    );
    expect(status).toBe('ok');
    expect(updates[0]?.bodyStatus).toBe('ok');
    expect([...(updates[0]?.body ?? '')].length).toBe(200);
    expect(hermes).not.toHaveBeenCalled();
  });

  test('plain fail: hermes resolves the body', async () => {
    const { updates, record } = recorder();
    const status = await processSignal(
      { signalId: 's1', link: 'https://example.test/article', title: TITLE },
      {
        config: stubConfig(),
        fetchPageImpl: async () => ({ ok: false, reason: 'http 404' }),
        hermes: async () => ({ kind: 'body', body: 'North Korea denies the Binance hack again in a longer statement today.' }),
        record,
        log: () => {},
      },
    );
    expect(status).toBe('ok');
    expect(updates[0]).toEqual({ signalId: 's1', body: 'North Korea denies the Binance hack again in a longer statement today.', bodyStatus: 'ok' });
  });

  test('plain fail: hermes BODY_UNAVAILABLE → unavailable', async () => {
    const { updates, record } = recorder();
    const status = await processSignal(
      { signalId: 's1', link: 'https://u.today/dead-link', title: 'Binance reopens withdrawals' },
      {
        config: stubConfig(),
        fetchPageImpl: async () => ({ ok: false, reason: 'http 404' }),
        hermes: async () => ({ kind: 'unavailable' }),
        record,
        log: () => {},
      },
    );
    expect(status).toBe('unavailable');
    expect(updates[0]).toEqual({ signalId: 's1', body: null, bodyStatus: 'unavailable' });
  });

  test('hermes body without overlap vs title and vs the plain extract is dropped', async () => {
    const { updates, record } = recorder();
    const unrelatedHtml = `<html><body><article><p>${'A completely different topic sentence about sushi restaurants. '.repeat(4)}</p></article></body></html>`;
    // shares nothing with the title nor with the fetched sushi text
    const hermes = vi.fn(async (): Promise<HermesBodyOutput_> => ({
      kind: 'body',
      body: 'Meteorological forecasts predict thunderstorms approaching the coastline this weekend evening.',
    }));
    const status = await processSignal(
      { signalId: 's1', link: 'https://example.test/a', title: TITLE },
      {
        config: stubConfig(),
        fetchPageImpl: async () => okHtml(unrelatedHtml),
        hermes,
        record,
        log: () => {},
      },
    );
    expect(hermes).toHaveBeenCalledTimes(1);
    expect(status).toBe('unavailable');
    expect(updates[0]).toEqual({ signalId: 's1', body: null, bodyStatus: 'unavailable' });
  });

  test('plain extract without overlap falls through to hermes, carrying the fetched text', async () => {
    const { updates, record } = recorder();
    const unrelatedHtml = `<html><body><article><p>${'A completely different topic sentence about sushi restaurants. '.repeat(4)}</p></article></body></html>`;
    const hermes = vi.fn(async (input: HermesBodyInput): Promise<HermesBodyOutput_> => {
      expect(input.pageText).toContain('sushi');
      return { kind: 'body', body: 'North Korea denied the Binance hack in today\'s statement.' };
    });
    const status = await processSignal(
      { signalId: 's1', link: 'https://example.test/a', title: TITLE },
      {
        config: stubConfig(),
        fetchPageImpl: async () => okHtml(unrelatedHtml),
        hermes,
        record,
        log: () => {},
      },
    );
    expect(hermes).toHaveBeenCalledTimes(1);
    expect(status).toBe('ok');
    expect(updates[0]?.bodyStatus).toBe('ok');
  });

  test('hermes hard error (timeout/crash) → failed, never aborts', async () => {
    const { updates, record } = recorder();
    const logs: string[] = [];
    const status = await processSignal(
      { signalId: 's1', link: 'https://example.test/a', title: 'Binance reopens withdrawals' },
      {
        config: stubConfig(),
        fetchPageImpl: async () => ({ ok: false, reason: 'timed out' }),
        hermes: async () => { throw new Error('hermes timed out after 90000ms'); },
        record,
        log: (line) => { logs.push(line); },
      },
    );
    expect(status).toBe('failed');
    expect(updates[0]).toEqual({ signalId: 's1', body: null, bodyStatus: 'failed' });
    expect(logs.some((line) => line.includes('"event":"web_reader_hermes_error"'))).toBe(true);
  });

  test('fetch timeout (hard error) → hermes fallback still runs', async () => {
    const { updates, record } = recorder();
    const logs: string[] = [];
    const hermes = vi.fn(async (): Promise<HermesBodyOutput_> => ({ kind: 'body', body: 'North Korea denies the Binance hack in fresh remarks.' }));
    await processSignal(
      { signalId: 's1', link: 'https://example.test/a', title: TITLE },
      {
        config: stubConfig(),
        fetchPageImpl: async () => { throw new Error('timed out after 15000ms'); },
        hermes,
        record,
        log: (line) => { logs.push(line); },
      },
    );
    expect(hermes).toHaveBeenCalledTimes(1);
    expect(updates[0]?.bodyStatus).toBe('ok');
    expect(logs.some((line) => line.includes('"event":"web_reader_fetch_error"'))).toBe(true);
  });
});

type FetchPageRunnerStub = (url: string, options: { timeoutMs: number }) => Promise<FetchPageResult>;
type HermesBodyOutput_ = { kind: 'body'; body: string } | { kind: 'unavailable' };

describe('runWebReaderOnce (#582)', () => {
  test('45 pending signals → 10/10/10/10/5, max 5 batches in flight, summary counts correct', async () => {
    const store = new FakeSignalStore();
    for (let n = 0; n < 45; n += 1) {
      store.add(`sig-${n}`, 'https://example.test/a', TITLE, n);
    }
    let inFlight = 0;
    let maxObserved = 0;
    const lines: string[] = [];
    const summary = await runWebReaderOnce({
      db: store,
      config: stubConfig(),
      fetchPageImpl: async () => {
        inFlight += 1;
        maxObserved = Math.max(maxObserved, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        return okHtml(READABLE_HTML);
      },
      hermes: async () => ({ kind: 'unavailable' }),
      log: (line) => { lines.push(line); },
    });
    expect(summary).toEqual({ selected: 45, batches: 5, maxInFlight: 5, ok: 45, unavailable: 0, failed: 0 });
    expect(maxObserved).toBeLessThanOrEqual(5);
    expect(store.updateCalls).toHaveLength(45);
    const runLine = JSON.parse(lines.find((line) => line.includes('"event":"web_reader_run"')) ?? '{}');
    expect(runLine).toMatchObject({ event: 'web_reader_run', selected: 45, batches: 5, ok: 45, maxInFlight: 5 });
  });

  test('best effort: one signal\'s write failing does not abort the batch', async () => {
    const store = new FakeSignalStore();
    store.add('sig-1', 'https://www.reuters.com/a', 'Binance reopens withdrawals');
    store.add('sig-2', 'https://example.test/b', TITLE);
    const inner = store.recordResult.bind(store);
    const writtenFor: string[] = [];
    store.recordResult = async (update) => {
      if (update.signalId === 'sig-1') throw new Error('db write failed');
      writtenFor.push(update.signalId);
      await inner(update);
    };
    const summary = await runWebReaderOnce({
      db: store,
      config: stubConfig(),
      fetchPageImpl: async () => okHtml(READABLE_HTML),
      hermes: async () => ({ kind: 'unavailable' }),
      log: () => {},
    });
    // sig-1 (paywall) fails at the write, sig-2 still completes
    expect(writtenFor).toEqual(['sig-2']);
    expect(summary.ok).toBe(1);
    expect(summary.failed).toBe(1);
  });

  test('second pass skips already-finished signals (ok / unavailable / failed)', async () => {
    const store = new FakeSignalStore();
    store.add('sig-ok', 'https://example.test/a', TITLE, 1);
    store.add('sig-paywalled', 'https://www.reuters.com/a', 'Binance reopens withdrawals', 2);
    store.add('sig-hermes-dead', 'https://u.today/a', 'Binance reopens withdrawals', 3);
    const runOnce = () =>
      runWebReaderOnce({
        db: store,
        config: stubConfig(),
        fetchPageImpl: async () => okHtml(READABLE_HTML),
        hermes: async () => ({ kind: 'unavailable' }),
        log: () => {},
      });
    const first = await runOnce();
    expect(first).toMatchObject({ selected: 3, ok: 1, unavailable: 2, failed: 0 });
    // every row now carries a terminal status, so the SQL predicate excludes them all
    const second = await runOnce();
    expect(second).toMatchObject({ selected: 0, batches: 0, ok: 0, unavailable: 0, failed: 0 });
    expect(store.selectCalls).toBe(2);
    expect(store.updateCalls).toHaveLength(3);
  });
});

describe('webReaderMain + createPgReaderDb wiring (#582)', () => {
  test('config is parsed before any pool exists: a missing DB url opens nothing', async () => {
    const createPool = vi.fn();
    await expect(webReaderMain({ env: {}, createPool, log: () => {} }))
      .rejects.toThrow('WEB_READER_DATABASE_URL');
    expect(createPool).not.toHaveBeenCalled();
  });

  test('runs one pass over the mock pg client: BEGIN → SKIP LOCKED select → COMMIT, update, pool.end', async () => {
    const clientQuery = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes('select signal_id')) {
        return { rows: [{ signal_id: 'sig-1', link: 'https://example.test/a', text: TITLE }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const clientRelease = vi.fn();
    const poolQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const poolEnd = vi.fn(async () => undefined);
    const pool = {
      connect: vi.fn(async () => ({ query: clientQuery, release: clientRelease })),
      query: poolQuery,
      end: poolEnd,
    };

    const logs: string[] = [];
    const summary = await webReaderMain({
      env: { WEB_READER_DATABASE_URL: 'postgres://web_reader_worker@localhost/db' },
      createPool: (() => poolAsPoolSeam(pool)) as unknown as NonNullable<WebReaderMainOptions['createPool']>,
      createHermes: () => (async (): Promise<HermesBodyOutput_> => ({ kind: 'unavailable' })),
      fetchPageImpl: async () => ({ ok: false, reason: 'unused' }),
      log: (line) => { logs.push(line); },
    });
    expect(summary).toMatchObject({ selected: 1, ok: 0, unavailable: 1, failed: 0 });

    const selectSql = clientQuery.mock.calls
      .map((call) => String(call[0]))
      .find((sql) => sql.includes('from atlas.signals'));
    expect(selectSql).toBeDefined();
    expect(selectSql).toContain("type = 'news'");
    expect(selectSql).toContain("source = 'tokens_xyz'");
    expect(selectSql).toContain('link is not null');
    expect(selectSql).toContain("(body_status is null or body_status = 'pending')");
    expect(selectSql).toContain('order by fetched_at desc');
    expect(selectSql).toContain('for update skip locked');
    const transactionOrder = clientQuery.mock.calls.map((call) => String(call[0]));
    expect(transactionOrder[0]).toBe('BEGIN');
    expect(transactionOrder[1]).toBe(selectSql);
    expect(transactionOrder[2]).toBe('COMMIT');
    expect(clientRelease).toHaveBeenCalledTimes(1);
    expect(poolQuery).toHaveBeenCalledWith(
      'update atlas.signals set body = $2, body_status = $3, body_fetched_at = now() where signal_id = $1',
      ['sig-1', null, 'unavailable'],
    );
    expect(poolEnd).toHaveBeenCalledTimes(1);
    expect(logs.some((line) => line.includes('"event":"web_reader_run"'))).toBe(true);
  });
});

/** The fake pool is structurally a Pick<Pool, 'connect' | 'query' | 'end'>; only the types differ. */
function poolAsPoolSeam(pool: PoolLike): PoolLike {
  return pool;
}

type PoolLike = {
  connect: () => Promise<{ query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>; release: () => void }>;
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
  end: () => Promise<void>;
};

