/**
 * #593 CLI entry: the ENTITY_MANAGER_ENABLED gate, then the entity manager
 * claims analyst handoffs and decides story / park / duplicate per entity in
 * one pass. ENTITY_MANAGER_DATABASE_URL (entity_worker), OLLAMA_API_KEY and
 * optional JEV_API_TOKEN are read from the environment and NEVER logged.
 */
import os from 'node:os';

import { runGatedStage } from '@myboon/shared/v4-runtime';

import { createJev, createOllamaLlm } from './clients.js';
import { createPool, runOnce } from './worker.js';

const need = (k: string) => {
  const v = process.env[k]?.trim();
  if (!v) throw new Error(`${k} is required`);
  return v;
};

// ENTITY_MANAGER_ENABLED gate (#593): off exits 0 before any pool, client, or
// network I/O — the gate never calls run.
runGatedStage({
  flag: 'ENTITY_MANAGER_ENABLED',
  stage: 'entity-manager',
  run: async () => {
    const pool = createPool(need('ENTITY_MANAGER_DATABASE_URL'));
    const jevToken = process.env.JEV_API_TOKEN?.trim();
    try {
      const summary = await runOnce({
        pool,
        llm: createOllamaLlm({ apiKey: need('OLLAMA_API_KEY'), model: process.env.ENTITY_MANAGER_LLM_MODEL?.trim() || 'glm-5.3-flash' }),
        jev: jevToken ? createJev({ apiToken: jevToken }) : undefined,
        worker: process.env.ENTITY_MANAGER_WORKER?.trim() || `${os.hostname()}:${process.pid}`,
        limit: Number(process.env.ENTITY_MANAGER_MAX_PER_RUN ?? 20),
      });
      console.log(JSON.stringify({ event: 'em_run', ...summary }));
    } finally {
      await pool.end();
    }
  },
}).catch((e: unknown) => {
  // The message only: config errors name the key, no values.
  console.error(`entity-manager: run failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
