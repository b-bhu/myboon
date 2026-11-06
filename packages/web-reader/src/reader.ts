/**
 * #582 web reader worker: one run fills the planned atlas.signals body columns
 * (body / body_status / body_fetched_at — DB Guy's migration PR provides the
 * columns, the web_reader_worker role and WEB_READER_DATABASE_URL). One run is
 * best effort: a paywalled link is marked unavailable without any fetch, a
 * plain HTTP fetch is extracted with the copied readableArticle, and a
 * headless Hermes oneshot (no browser toolsets) is the only inference
 * fallback. Overlap-guarded bodies only; anything else is marked
 * unavailable/failed and never retried in a tight loop.
 */
import { Pool } from 'pg';

import type { ProcessEnvLike } from '@myboon/shared/v4-runtime';
import { runGatedStage } from '@myboon/shared/v4-runtime';

import { chunkBatch, runBatches } from './batching.js';
import { parseWebReaderConfig, type WebReaderConfig } from './config.js';
import { extractArticleText } from './extract.js';
import { fetchPage, type FetchPageResult } from './fetch-article.js';
import type { HermesBodyRunner } from './hermes-body.js';
import { createHermesBodyClient } from './hermes-body.js';
import { hasEnoughOverlap } from './overlap.js';
import { isPaywallHost } from './paywall.js';

export type BodyStatus = 'ok' | 'unavailable' | 'failed';

/** A selectable signal: linked tokens_xyz news with no body yet. */
export interface PendingSignal {
  signalId: string;
  link: string;
  /** atlas.signals.text — the headline for news signals. */
  title: string | null;
}

/**
 * The selected columns only. The SELECT itself lives with the DB seam so the
 * orchestration below stays testable without a database.
 */
export interface ReaderDb {
  /**
   * Newest-by-fetched_at pending news signals, locked with FOR UPDATE SKIP
   * LOCKED, released when the selection transaction commits. No claim RPC and
   * no extra claim UPDATE (CTO decision 3): the write statuses below are
   * idempotent and PM2 cron_restart prevents overlapping runs.
   */
  selectPendingSignals(limit: number): Promise<PendingSignal[]>;
  recordResult(update: { signalId: string; body: string | null; bodyStatus: BodyStatus }): Promise<void>;
}

/** Plain-fetch "enough text" bar: shorter extracts pass to Hermes as context only. */
const MIN_PLAIN_BODY_CHARS = 200;

export type FetchPageRunner = (url: string, options: { timeoutMs: number }) => Promise<FetchPageResult>;

export interface ProcessSignalDeps {
  config: WebReaderConfig;
  fetchPageImpl: FetchPageRunner;
  hermes: HermesBodyRunner;
  /** Persists the outcome: status first, the capped body second (null unless ok). */
  record: (bodyStatus: BodyStatus, body: string | null) => Promise<void>;
  log: (line: string) => void;
}

export interface RunWebReaderOptions {
  db: ReaderDb;
  config: WebReaderConfig;
  fetchPageImpl: FetchPageRunner;
  hermes: HermesBodyRunner;
  log?: (line: string) => void;
}

export interface WebReaderRunSummary {
  selected: number;
  batches: number;
  maxInFlight: number;
  ok: number;
  unavailable: number;
  failed: number;
}

function defaultLog(): (line: string) => void {
  return (line) => console.log(line);
}

function clipToCap(body: string, cap: number): string {
  return body.slice(0, cap);
}

/**
 * One signal, best effort: the paywall blocklist first (no fetch, no model),
 * then plain fetch + extraction, then the headless Hermes oneshot. Any
 * hard error records failed; nothing here rejects upward.
 */
export async function processSignal(
  signal: PendingSignal,
  deps: ProcessSignalDeps,
): Promise<BodyStatus> {
  const record = deps.record;

  // Paywall host blocklist (config): mark unavailable, fetch nothing.
  if (isPaywallHost(signal.link)) {
    await record('unavailable', null);
    return 'unavailable';
  }

  // Plain HTTP GET + readableArticle extraction.
  let pageText: string | null = null;
  let plainBody: string | null = null;
  try {
    const response = await deps.fetchPageImpl(signal.link, { timeoutMs: deps.config.fetchTimeoutMs });
    if (response.ok) {
      const extracted = extractArticleText(response.page);
      if (extracted && extracted.length >= MIN_PLAIN_BODY_CHARS) {
        if (hasEnoughOverlap(extracted, signal.title)) {
          plainBody = extracted;
        } else {
          // Not enough overlap to keep directly, but real fetched text is
          // still the strongest context for the Hermes fallback.
          pageText = extracted;
        }
      } else if (extracted) {
        pageText = extracted;
      }
    }
  } catch (error) {
    // A plain-fetch failure never aborts the run; Hermes is the fallback.
    deps.log(JSON.stringify({
      event: 'web_reader_fetch_error',
      signalId: signal.signalId,
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  if (plainBody !== null) {
    await record('ok', clipToCap(plainBody, deps.config.bodyCapChars));
    return 'ok';
  }

  // Headless Hermes oneshot fallback with the strict body-only prompt.
  try {
    const output = await deps.hermes({ title: signal.title, link: signal.link, pageText });
    if (output.kind === 'body') {
      // Anti-hallucination: a body with no overlap vs the title and vs the
      // plain extract (The Defiant teaser case) is dropped, not stored.
      if (hasEnoughOverlap(output.body, signal.title, pageText)) {
        await record('ok', clipToCap(output.body, deps.config.bodyCapChars));
        return 'ok';
      }
      await record('unavailable', null);
      return 'unavailable';
    }
    await record('unavailable', null);
    return 'unavailable';
  } catch (error) {
    // Hard errors (timeout, hermes crash) record failed and never abort the run.
    deps.log(JSON.stringify({
      event: 'web_reader_hermes_error',
      signalId: signal.signalId,
      error: error instanceof Error ? error.message : String(error),
    }));
    await record('failed', null);
    return 'failed';
  }
}

/** One batch: sequential per signal so one batch's cost is bounded by its items. */
async function processBatch(
  batch: readonly PendingSignal[],
  deps: Pick<RunWebReaderOptions, 'db' | 'fetchPageImpl' | 'hermes'>,
  config: WebReaderConfig,
  log: (line: string) => void,
  onOutcome: (bodyStatus: BodyStatus) => void,
): Promise<void> {
  for (const signal of batch) {
    try {
      const bodyStatus = await processSignal(signal, {
        config,
        fetchPageImpl: deps.fetchPageImpl,
        hermes: deps.hermes,
        log,
        record: (bodyStatus, body) => deps.db.recordResult({ signalId: signal.signalId, body, bodyStatus }),
      });
      onOutcome(bodyStatus);
      log(JSON.stringify({ event: 'web_reader_signal', signalId: signal.signalId, outcome: bodyStatus }));
    } catch (error) {
      // recordResult itself failing must not abort the batch.
      onOutcome('failed');
      log(JSON.stringify({
        event: 'web_reader_signal_error',
        signalId: signal.signalId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
}

/**
 * One run: select up to maxPerRun pending signals (newest fetched_at first),
 * split into batches of batchSize (the last takes the remainder), process at
 * most maxParallelBatches concurrently, and log exactly one summary line.
 */
export async function runWebReaderOnce(o: RunWebReaderOptions): Promise<WebReaderRunSummary> {
  const log = o.log ?? defaultLog();
  const rows = await o.db.selectPendingSignals(o.config.maxPerRun);
  const batches = chunkBatch(rows, o.config.batchSize);
  const counts: Record<BodyStatus, number> = { ok: 0, unavailable: 0, failed: 0 };
  const { maxInFlight } = await runBatches(batches, o.config.maxParallelBatches, (batch) =>
    processBatch(batch, o, o.config, log, (bodyStatus) => { counts[bodyStatus] += 1; }),
  );
  const summary: WebReaderRunSummary = {
    selected: rows.length,
    batches: batches.length,
    maxInFlight,
    ok: counts.ok,
    unavailable: counts.unavailable,
    failed: counts.failed,
  };
  log(JSON.stringify({ event: 'web_reader_run', ...summary }));
  return summary;
}

// ---------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------

export function createPgReaderDb(pool: Pick<Pool, 'connect' | 'query' | 'end'>): ReaderDb {
  return {
    async selectPendingSignals(limit: number): Promise<PendingSignal[]> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query<{
          signal_id: string;
          link: string;
          text: string | null;
        }>(
          `select signal_id, link, text
             from atlas.signals
            where type = 'news'
              and source = 'tokens_xyz'
              and link is not null
              and (body_status is null or body_status = 'pending')
            order by fetched_at desc
            limit $1
            for update skip locked`,
          [limit],
        );
        await client.query('COMMIT');
        return result.rows.map((row) => ({
          signalId: String(row.signal_id),
          link: String(row.link),
          title: row.text === null ? null : String(row.text),
        }));
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* the original error is the one to report */ }
        throw error;
      } finally {
        client.release();
      }
    },
    async recordResult(update): Promise<void> {
      await pool.query(
        'update atlas.signals set body = $2, body_status = $3, body_fetched_at = now() where signal_id = $1',
        [update.signalId, update.body, update.bodyStatus],
      );
    },
  };
}

export interface WebReaderMainOptions {
  env: ProcessEnvLike;
  /** Test seams; production creates one pg Pool, the default fetch and the Hermes oneshot client. */
  createPool?: (databaseUrl: string) => Pick<Pool, 'connect' | 'query' | 'end'>;
  fetchPageImpl?: FetchPageRunner;
  createHermes?: (options: { model: string; timeoutMs: number }) => HermesBodyRunner;
  log?: (line: string) => void;
}

/**
 * Parse the config first (before any pool exists — a missing secret fails
 * without touching the database), then run one pass and always end the pool.
 * Errors propagate to the entrypoint, which sets the exit code.
 */
export async function webReaderMain(o: WebReaderMainOptions): Promise<WebReaderRunSummary> {
  const config = parseWebReaderConfig(o.env);
  const log = o.log ?? defaultLog();
  const pool = o.createPool
    ? o.createPool(config.databaseUrl)
    : new Pool({ connectionString: config.databaseUrl, max: 2 });
  try {
    const db = createPgReaderDb(pool);
    const fetchPageImpl: FetchPageRunner = o.fetchPageImpl
      ?? ((url, options) => fetchPage(url, { timeoutMs: options.timeoutMs }));
    const hermes: HermesBodyRunner = o.createHermes
      ? o.createHermes({ model: config.hermesModel, timeoutMs: config.hermesTimeoutMs })
      : createHermesBodyClient({ model: config.hermesModel, timeoutMs: config.hermesTimeoutMs }).runBody;
    return await runWebReaderOnce({ db, config, fetchPageImpl, hermes, log });
  } finally {
    await pool.end();
  }
}

export interface WebReaderEntryOptions {
  env?: ProcessEnvLike;
  exit?: (code: number) => never | void;
  log?: (line: string) => void;
  /** Test injection: replaces webReaderMain (default never runs when the gate is off). */
  run?: () => Promise<void>;
}

/**
 * The WEB_READER_ENABLED gate (flag off by default): when off, one info line,
 * exit 0, and `run` is never called — no Pool, no socket, no network.
 */
export function webReaderEntry(o: WebReaderEntryOptions = {}): Promise<void> {
  const env = o.env ?? process.env;
  return runGatedStage({
    flag: 'WEB_READER_ENABLED',
    stage: 'web-reader',
    env,
    exit: o.exit,
    log: o.log,
    run: async () => {
      await (o.run ?? (() => webReaderMain({ env, log: o.log })))();
    },
  });
}
