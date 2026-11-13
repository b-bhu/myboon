/**
 * #621 run configuration, pure so it can be tested without a database.
 *
 * Main run, flag off (default): `ENTITY_MANAGER_CLAIM_ENTITY_ONLY` unset or not exactly 'true' keeps the
 * #593 behaviour byte for byte: no scope (the worker calls atlas.em_claim) and ENTITY_MANAGER_MAX_PER_RUN
 * (default 20).
 * Main run, flag on: claim only handoffs that have an entity (atlas.em_claim_scoped 'entity'), batch
 * ENTITY_MANAGER_ENTITY_ONLY_MAX_PER_RUN (default 60).
 * Retry run (own entrypoint, own flag ENTITY_MANAGER_RETRY_ENABLED): claims only the no-entity handoffs,
 * once a day, batch ENTITY_MANAGER_RETRY_MAX_PER_RUN (default 2000).
 */
import { isStageEnabled, type ProcessEnvLike } from '@myboon/shared/v4-runtime';

export type ClaimScope = 'entity' | 'no_entity';
export type RunConfig = { scope: ClaimScope | undefined; limit: number };

export const ENTITY_ONLY_FLAG = 'ENTITY_MANAGER_CLAIM_ENTITY_ONLY';
export const ENTITY_ONLY_DEFAULT_BATCH = 60;
export const RETRY_DEFAULT_BATCH = 2000;

export function mainRunConfig(env: ProcessEnvLike = process.env): RunConfig {
  if (!isStageEnabled(ENTITY_ONLY_FLAG, env)) return { scope: undefined, limit: Number(env.ENTITY_MANAGER_MAX_PER_RUN ?? 20) };
  return { scope: 'entity', limit: Number(env.ENTITY_MANAGER_ENTITY_ONLY_MAX_PER_RUN ?? ENTITY_ONLY_DEFAULT_BATCH) };
}

export function retryRunConfig(env: ProcessEnvLike = process.env): RunConfig {
  return { scope: 'no_entity', limit: Number(env.ENTITY_MANAGER_RETRY_MAX_PER_RUN ?? RETRY_DEFAULT_BATCH) };
}
