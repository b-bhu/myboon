/** Shared body of the entity-manager entrypoints (run.ts main run, run-retry.ts daily retry). Secrets are read from env, never logged. */
import os from 'node:os';

import type pg from 'pg';

import { createJev, createOllamaLlm, type Jev, type Llm } from './clients.js';
import type { MarketsRunConfig, RunConfig } from './config.js';
import { marketsConfig } from './config.js';
import { runMarketsPass } from './markets-worker.js';
import { createPool, lagWarning, oldestReadyEntityAgeMinutes, runOnce } from './worker.js';

const need = (k: string) => {
  const v = process.env[k]?.trim();
  if (!v) throw new Error(`${k} is required`);
  return v;
};

/** Test seams; every default is the production path. */
export type EntityManagerDeps = {
  pool?: pg.Pool;
  llm?: Llm;
  jev?: Jev;
  runOnceImpl?: typeof runOnce;
  runMarketsPassImpl?: typeof runMarketsPass;
  /** marketsConfig() normally reads the env; tests set it directly. */
  markets?: MarketsRunConfig;
};

export async function runEntityManager(cfg: RunConfig, event: string, workerSuffix = '', deps: EntityManagerDeps = {}): Promise<void> {
  const pool = deps.pool ?? createPool(need('ENTITY_MANAGER_DATABASE_URL'));
  const jevToken = process.env.JEV_API_TOKEN?.trim();
  try {
    // inside the try so a missing OLLAMA_API_KEY still lands in the finally's pool.end() (as before #690).
    const llm = deps.llm ?? createOllamaLlm({ apiKey: need('OLLAMA_API_KEY'), model: process.env.ENTITY_MANAGER_LLM_MODEL?.trim() || 'glm-5.3-flash' });
    const summary = await (deps.runOnceImpl ?? runOnce)({
      pool,
      llm,
      jev: jevToken ? createJev({ apiToken: jevToken }) : undefined,
      worker: `${process.env.ENTITY_MANAGER_WORKER?.trim() || `${os.hostname()}:${process.pid}`}${workerSuffix}`,
      limit: cfg.limit,
      scope: cfg.scope,
    });
    // #621 lag signal (main run only): age of the oldest ready row with an entity, and a WARN over the threshold (default 120 min).
    // A failing lag query is logged and never fails the run.
    let lag: number | null | undefined;
    if (workerSuffix === '') {
      try {
        lag = await oldestReadyEntityAgeMinutes(pool);
      } catch (e) {
        console.error(`entity-manager: lag check failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    console.log(JSON.stringify({ event, scope: cfg.scope ?? 'all', limit: cfg.limit, ...summary, ...(lag !== undefined ? { oldest_ready_entity_age_min: lag } : {}) }));
    const warn = lag === undefined ? null : lagWarning(lag, Number(process.env.ENTITY_MANAGER_LAG_WARN_MINUTES ?? 120));
    if (warn) console.warn(JSON.stringify(warn));
    // #690 entity markets pass, main run only and only when the flag is on: each main run checks up
    // to the configured batch of never-checked entities and writes their 0-3 Hyperliquid links. Its
    // own try/catch: a markets failure never fails the run, never calls em_fail and never changes
    // the exit code. The retry run (workerSuffix ':retry') never runs the markets pass.
    const markets = deps.markets ?? marketsConfig();
    if (workerSuffix === '' && markets.enabled) {
      try {
        await (deps.runMarketsPassImpl ?? runMarketsPass)({ pool, llm, limit: markets.limit });
      } catch (e) {
        console.error(`entity-manager: markets pass failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } finally {
    await pool.end();
  }
}
