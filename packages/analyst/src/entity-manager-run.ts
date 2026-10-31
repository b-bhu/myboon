/**
 * #480 CLI entry: the ENTITY_MANAGER_ENABLED gate, then the timed entity
 * manager reviews every proposed entity once and exits. ENTITY_MANAGER_DATABASE_URL
 * and OLLAMA_API_KEY are read from the environment and NEVER logged.
 */
import { runGatedStage } from '@myboon/shared/v4-runtime';
import { Pool } from 'pg';

import { reviewProposedEntities } from './entity-manager.js';
import { parseEntityManagerConfig } from './entity-manager-config.js';
import { analystPoolConfig, loadAnalystDatabaseCa } from './db-pool.js';
import { createOllamaLlm } from './session.js';
import { createQuotaGuard, readOllamaQuota } from './ollama-quota.js';

// ENTITY_MANAGER_ENABLED gate (#480): off exits 0 before any config is parsed or client is created.
runGatedStage({
  flag: 'ENTITY_MANAGER_ENABLED',
  stage: 'entity-manager',
  run: async () => {
    const c = parseEntityManagerConfig(process.env);
    const pool = new Pool({ ...analystPoolConfig(c.databaseUrl, loadAnalystDatabaseCa(process.env)), max: 2 });
    try {
      await reviewProposedEntities(pool, {
        llm: createOllamaLlm({ apiKey: c.ollamaApiKey, model: c.llmModel, timeoutMs: c.timeoutMs }),
        modelName: c.llmModel,
        maxEntities: c.maxEntities,
        quota: createQuotaGuard({ read: () => readOllamaQuota(c.ollamaApiKey) }),
        timeoutMs: c.timeoutMs,
        // entity_manager_run / entity_review_failed land on stdout as JSON lines, like the analyst.
      });
    } finally {
      await pool.end();
    }
  },
}).catch((e: unknown) => {
  // The message only: config errors name the key, never a secret value.
  console.error(`entity-manager: run failed: ${describeError(e)}`);
  process.exitCode = 1;
});

/**
 * The error's message; for Node's AggregateError (what pg raises on a refused
 * connection — its own message is often empty) the cause errors' messages are
 * joined in, so a dead database never logs a bare "run failed:".
 */
function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  if (e.message) return e.message;
  const causes = e instanceof AggregateError ? e.errors.map((c) => String(c instanceof Error ? c.message : c).trim()).filter(Boolean).join('; ') : '';
  return [e.name, causes].filter(Boolean).join(': ');
}