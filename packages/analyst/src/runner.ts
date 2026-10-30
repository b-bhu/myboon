/**
 * #512 analyst worker run orchestration: `runAnalystOnce` drains due signals
 * through the D36 worker up to a per-run cap and logs one summary line;
 * `analystMain` wires the parsed config into the pool, the LLM and the decider
 * slot, runs one pass, and always ends the pool. Config is parsed before any
 * pool is created so a bad or missing secret fails without touching the
 * database, and parse errors never carry a secret value.
 */
import { Pool } from 'pg';

import type { AnalystConfig } from './config.js';
import { parseAnalystConfig } from './config.js';
import type { Decider } from './deciders.js';
import { CLEF_ENDPOINT, CLEF_MODEL, JEV_ENDPOINT, JEV_MODEL, SystemOneDecider } from './deciders.js';
import { PgDecisionSink, processNextD36, shelfSearchFromDb, type D36Options } from './d36-worker.js';
import { analystPoolConfig, loadAnalystDatabaseCa } from './db-pool.js';
import { createOllamaLlm, type JevLogEntry, type Llm } from './session.js';
import type { Db } from './states.js';

export type RunSummary = { processed: number; analysed: number; parked: number; failed: number; lost_claim: number };

/**
 * One run: process due signals one claim at a time until the worker is idle or
 * the per-run cap is reached, count the outcomes, then log exactly one summary
 * line (event analyst_run) through `log` (one stdout line by default).
 */
export async function runAnalystOnce(db: Db, opts: D36Options, o: { maxSignals: number; log?: (line: string) => void }): Promise<RunSummary> {
  const summary: RunSummary = { processed: 0, analysed: 0, parked: 0, failed: 0, lost_claim: 0 };
  while (summary.processed < o.maxSignals) {
    const result = await processNextD36(db, opts);
    if (!result) break;
    summary.processed += 1;
    summary[result.result] += 1;
  }
  const log = o.log ?? ((line: string) => { console.log(line); });
  log(JSON.stringify({ event: 'analyst_run', worker: opts.worker, ...summary }));
  return summary;
}

export type AnalystMainOptions = {
  /** The environment to parse; secrets are read from here only. */
  env: Record<string, string | undefined>;
  /** Pool factory for tests; the default is one pg Pool, max 2, on ANALYST_DATABASE_URL. */
  createPool?: (url: string) => Pool;
  /** LLM factory for tests; the default is the Ollama chat client on the configured key/model. */
  createLlm?: (c: AnalystConfig) => Llm;
  /** Decider factory for tests; the default is Jev primary, Clef fallback, a Clef shadow when on. */
  createDeciders?: (c: AnalystConfig) => { primary: Decider; fallback: Decider; shadow: Decider | null };
  /** Line sink for every log line (jev calls, drops, the run summary); default is one stdout line. */
  log?: (line: string) => void;
};

function lineSink(o: { log?: (line: string) => void }): (line: string) => void {
  return o.log ?? ((line: string) => { console.log(line); });
}

function defaultDeciders(c: AnalystConfig): { primary: Decider; fallback: Decider; shadow: Decider | null } {
  return {
    primary: new SystemOneDecider({ name: 'jev', model: JEV_MODEL, endpoint: JEV_ENDPOINT, apiToken: c.jevApiToken }),
    fallback: new SystemOneDecider({ name: 'clef', model: CLEF_MODEL, endpoint: CLEF_ENDPOINT, apiToken: c.ollamaApiKey }),
    shadow: c.shadow
      ? new SystemOneDecider({ name: 'clef', model: CLEF_MODEL, endpoint: CLEF_ENDPOINT, apiToken: c.ollamaApiKey })
      : null,
  };
}

/**
 * Parse the config first (before any pool exists), then wire the stack, run one
 * pass and always end the pool. Errors propagate to the entrypoint, which sets
 * the exit code; the summary is returned on success only.
 */
export async function analystMain(o: AnalystMainOptions): Promise<RunSummary> {
  const c = parseAnalystConfig(o.env);
  const log = lineSink(o);

  const pool = o.createPool
    ? o.createPool(c.databaseUrl)
    : new Pool({ ...analystPoolConfig(c.databaseUrl, loadAnalystDatabaseCa(o.env)), max: 2 });

  try {
    const llm = o.createLlm ? o.createLlm(c) : createOllamaLlm({ apiKey: c.ollamaApiKey, model: c.llmModel, timeoutMs: c.timeoutMs });
    const { primary, fallback, shadow } = o.createDeciders ? o.createDeciders(c) : defaultDeciders(c);

    const opts: D36Options = {
      llm,
      primary,
      fallback,
      shadow,
      search: shelfSearchFromDb(pool),
      sink: new PgDecisionSink(pool, (e) => { log(JSON.stringify(e)); }),
      log: (e: JevLogEntry) => { log(JSON.stringify({ event: 'jev_call', ...e })); },
      leaseMs: c.leaseMs,
      timeoutMs: c.timeoutMs,
      backoffMs: c.backoffMs,
      maxAttempts: c.maxAttempts,
      worker: c.worker,
    };

    return await runAnalystOnce(pool, opts, { maxSignals: c.maxSignalsPerRun, log });
  } finally {
    await pool.end();
  }
}