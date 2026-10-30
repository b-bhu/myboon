/**
 * #512 CLI entry: the ANALYST_ENABLED gate, then the analyst worker runs one
 * pass over the atlas database and exits. ANALYST_DATABASE_URL, OLLAMA_API_KEY
 * and JEV_API_TOKEN are read from the environment and NEVER logged.
 */
import { runGatedStage } from '@myboon/shared/v4-runtime';

import { analystMain } from './runner.js';

// ANALYST_ENABLED gate (#512): off exits 0 before any config is parsed or client is created.
runGatedStage({
  flag: 'ANALYST_ENABLED',
  stage: 'analyst',
  run: async () => {
    await analystMain({ env: process.env });
  },
}).catch((e: unknown) => {
  // The message only: config errors name the key, decider errors are redacted, no values.
  console.error(`analyst: run failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});