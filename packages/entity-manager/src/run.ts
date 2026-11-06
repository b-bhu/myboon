/** One worker pass. Env: ENTITY_MANAGER_DATABASE_URL (entity_worker), OLLAMA_API_KEY, optional JEV_API_TOKEN. */
import os from 'node:os';

import { createJev, createOllamaLlm } from './clients.js';
import { createPool, runOnce } from './worker.js';

const need = (k: string) => {
  const v = process.env[k]?.trim();
  if (!v) throw new Error(`${k} is required`);
  return v;
};

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
