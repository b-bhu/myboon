/**
 * #631 CLI entry: the LATEST_UPDATES_ENABLED gate, then one run (PM2 cron `25,55 * * * *`, one run per tick, then
 * exit). Off exits 0 BEFORE any config, pool or network: the gate never calls run. Needs, when on:
 * LATEST_UPDATES_DATABASE_URL (latest_update_worker), OLLAMA_API_KEY; optional knobs are in config.ts. Env names
 * only; values are never logged.
 */
import { runGatedStage } from '@myboon/shared/v4-runtime';

import { ENABLED_FLAG } from './config.js';
import { runLatestUpdates } from './entry.js';

runGatedStage({
  flag: ENABLED_FLAG,
  stage: 'latest-updates',
  run: async () => {
    process.exitCode = await runLatestUpdates();
  },
}).catch((e: unknown) => {
  // The message only: config errors name the key, no values.
  console.error(`latest-updates: run failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
