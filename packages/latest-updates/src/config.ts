/**
 * #631 run configuration, pure so it can be tested without a database or the network.
 *
 * Env names only; values never appear in code or logs. The gate (LATEST_UPDATES_ENABLED) is checked by
 * runGatedStage in run.ts BEFORE this is read, so a disabled job never needs any of these.
 *
 * There is no knob for the window basis: the runner always uses entity_items.occurred_at. Only the length
 * (LATEST_UPDATES_WINDOW_HOURS) is tunable. Visibility is set at insert from LATEST_UPDATES_VISIBILITY and
 * a bad value stops the run; it never falls back to 'live'.
 */
import type { ProcessEnvLike } from '@myboon/shared/v4-runtime';

export const ENABLED_FLAG = 'LATEST_UPDATES_ENABLED';
export const DEFAULT_WINDOW_HOURS = 24;
export const DEFAULT_MAX_PER_RUN = 25;
export const DEFAULT_RUN_BUDGET_MS = 20 * 60 * 1000;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_CONCURRENCY = 2;
export const MAX_CONCURRENCY = 4;
export const DEFAULT_MODEL = 'glm-5.3-flash';
/** Attempts per (entity, newest item): two `error` rows, then the third failure is a `hold` (retries_exhausted). */
export const MAX_ATTEMPTS = 3;

export type Visibility = 'dark' | 'live';

export type RunConfig = {
  windowHours: number;
  maxPerRun: number;
  runBudgetMs: number;
  timeoutMs: number;
  concurrency: number;
  visibility: Visibility;
  model: string;
};

function positiveInt(env: ProcessEnvLike, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]+$/.test(raw) || Number(raw) < 1 || !Number.isSafeInteger(Number(raw))) throw new Error(`${key} must be a positive whole number`);
  return Number(raw);
}

export function parseVisibility(raw: string | undefined): Visibility {
  const value = raw?.trim();
  if (value === undefined || value === '') return 'dark';
  if (value === 'dark' || value === 'live') return value;
  throw new Error("LATEST_UPDATES_VISIBILITY must be 'dark' or 'live'");
}

export function loadRunConfig(env: ProcessEnvLike = process.env): RunConfig {
  const concurrency = positiveInt(env, 'LATEST_UPDATES_CONCURRENCY', DEFAULT_CONCURRENCY);
  if (concurrency > MAX_CONCURRENCY) throw new Error(`LATEST_UPDATES_CONCURRENCY must be at most ${MAX_CONCURRENCY}`);
  return {
    windowHours: positiveInt(env, 'LATEST_UPDATES_WINDOW_HOURS', DEFAULT_WINDOW_HOURS),
    maxPerRun: positiveInt(env, 'LATEST_UPDATES_MAX_PER_RUN', DEFAULT_MAX_PER_RUN),
    runBudgetMs: positiveInt(env, 'LATEST_UPDATES_RUN_BUDGET_MS', DEFAULT_RUN_BUDGET_MS),
    timeoutMs: positiveInt(env, 'LATEST_UPDATES_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
    concurrency,
    visibility: parseVisibility(env.LATEST_UPDATES_VISIBILITY),
    model: env.LATEST_UPDATES_LLM_MODEL?.trim() || DEFAULT_MODEL,
  };
}

/** The two secrets: read from env at start, named in errors, never logged. */
export function requireEnv(env: ProcessEnvLike, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}
