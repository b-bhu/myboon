/**
 * #593 CLI entry: the ENTITY_MANAGER_ENABLED gate, then the entity manager
 * claims analyst handoffs and decides story / park / duplicate per entity in
 * one pass. ENTITY_MANAGER_DATABASE_URL (entity_worker), OLLAMA_API_KEY and
 * optional JEV_API_TOKEN are read from the environment and NEVER logged.
 *
 * #621: with ENTITY_MANAGER_CLAIM_ENTITY_ONLY=true (default off) the run claims only handoffs that
 * have an entity, in batches of 60; no-entity handoffs are left to run-retry.ts. Flag off = #593 behaviour.
 */
import { runGatedStage } from '@myboon/shared/v4-runtime';

import { mainRunConfig } from './config.js';
import { runEntityManager } from './entry.js';

// ENTITY_MANAGER_ENABLED gate (#593): off exits 0 before any pool, client, or
// network I/O — the gate never calls run.
runGatedStage({
  flag: 'ENTITY_MANAGER_ENABLED',
  stage: 'entity-manager',
  run: () => runEntityManager(mainRunConfig(), 'em_run'),
}).catch((e: unknown) => {
  // The message only: config errors name the key, no values.
  console.error(`entity-manager: run failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
