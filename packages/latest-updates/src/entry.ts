/** Shared body of the CLI entry: secrets come from env, are named in errors and never logged. */
import { loadRunConfig, requireEnv } from './config.js';
import { createOllamaLlm } from './clients.js';
import { runOnce } from './runner.js';
import { createPgStore, createPool } from './store.js';

export async function runLatestUpdates(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const config = loadRunConfig(env);
  const pool = createPool(requireEnv(env, 'LATEST_UPDATES_DATABASE_URL'), config.concurrency + 1);
  try {
    const summary = await runOnce({
      store: createPgStore(pool),
      llm: createOllamaLlm({ apiKey: requireEnv(env, 'OLLAMA_API_KEY'), model: config.model, timeoutMs: config.timeoutMs }),
      config,
    });
    console.log(JSON.stringify({ event: 'latest_updates_run', visibility: config.visibility, window_hours: config.windowHours, max_per_run: config.maxPerRun, ...summary }));
    return summary.failed > 0 ? 1 : 0;
  } finally {
    await pool.end();
  }
}
