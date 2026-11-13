/** Shared body of the entity-manager entrypoints (run.ts main run, run-retry.ts daily retry). Secrets are read from env, never logged. */
import os from 'node:os';

import { createJev, createOllamaLlm } from './clients.js';
import type { RunConfig } from './config.js';
import { createPool, lagWarning, oldestReadyEntityAgeMinutes, runOnce } from './worker.js';

const need = (k: string) => {
  const v = process.env[k]?.trim();
  if (!v) throw new Error(`${k} is required`);
  return v;
};

export async function runEntityManager(cfg: RunConfig, event: string, workerSuffix = ''): Promise<void> {
  const pool = createPool(need('ENTITY_MANAGER_DATABASE_URL'));
  const jevToken = process.env.JEV_API_TOKEN?.trim();
  try {
    const summary = await runOnce({
      pool,
      llm: createOllamaLlm({ apiKey: need('OLLAMA_API_KEY'), model: process.env.ENTITY_MANAGER_LLM_MODEL?.trim() || 'glm-5.3-flash' }),
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
  } finally {
    await pool.end();
  }
}
