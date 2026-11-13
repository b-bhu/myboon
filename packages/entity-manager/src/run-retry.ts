/**
 * #621 daily retry entry: the ENTITY_MANAGER_RETRY_ENABLED gate (default off), then one pass over the
 * handoffs with no entity (atlas.em_claim_scoped 'no_entity'). Each due row is put back as pending for another
 * day, as before #621, but in its own run so these rows never take slots from the main run's batch.
 * Needs migration 20261113190000_atlas_em_claim_scoped.sql.
 */
import { runGatedStage } from '@myboon/shared/v4-runtime';

import { retryRunConfig } from './config.js';
import { runEntityManager } from './entry.js';

runGatedStage({
  flag: 'ENTITY_MANAGER_RETRY_ENABLED',
  stage: 'entity-manager-retry',
  run: () => runEntityManager(retryRunConfig(), 'em_retry_run', ':retry'),
}).catch((e: unknown) => {
  console.error(`entity-manager-retry: run failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
