/**
 * #512 analyst worker configuration, parsed once at startup from the environment.
 * The secrets (ANALYST_DATABASE_URL, OLLAMA_API_KEY, JEV_API_TOKEN) are required
 * and never appear in an error message; the non-secret knobs have defaults and
 * must be positive integers (digits only, so no 1e3, no floats, no signs).
 */
import os from 'node:os';

export class AnalystConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalystConfigError';
  }
}

export type AnalystConfig = {
  /** Postgres (or postgresql) connection string for the atlas database. */
  databaseUrl: string;
  ollamaApiKey: string;
  jevApiToken: string;
  llmModel: string;
  maxSignalsPerRun: number;
  leaseMs: number;
  timeoutMs: number;
  backoffMs: number;
  maxAttempts: number;
  worker: string;
  shadow: boolean;
};

/** Positive integers only: digits with no leading zero, so '0', '-1', '1.5', '1e3' all fail. */
const POSITIVE_INT = /^[1-9]\d*$/;

type Env = Record<string, string | undefined>;

function requireString(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new AnalystConfigError(`${key} is required (non-blank)`);
  return value;
}

function optionalString(env: Env, key: string, fallback: string): string {
  const value = env[key]?.trim();
  return value ? value : fallback;
}

function optionalPositiveInt(env: Env, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!POSITIVE_INT.test(raw)) throw new AnalystConfigError(`${key} must be a positive integer (digits only)`);
  return Number(raw);
}

/**
 * Every failure names the offending key and carries no environment value, so a
 * thrown error can be logged without leaking a secret.
 */
export function parseAnalystConfig(env: Env): AnalystConfig {
  const databaseUrl = requireString(env, 'ANALYST_DATABASE_URL');
  if (!databaseUrl.startsWith('postgres://') && !databaseUrl.startsWith('postgresql://')) {
    throw new AnalystConfigError('ANALYST_DATABASE_URL must start with postgres:// or postgresql://');
  }
  return {
    databaseUrl,
    ollamaApiKey: requireString(env, 'OLLAMA_API_KEY'),
    jevApiToken: requireString(env, 'JEV_API_TOKEN'),
    llmModel: optionalString(env, 'ANALYST_LLM_MODEL', 'glm-5.3-flash'),
    maxSignalsPerRun: optionalPositiveInt(env, 'ANALYST_MAX_SIGNALS_PER_RUN', 20),
    leaseMs: optionalPositiveInt(env, 'ANALYST_LEASE_MS', 300_000),
    timeoutMs: optionalPositiveInt(env, 'ANALYST_TIMEOUT_MS', 20_000),
    backoffMs: optionalPositiveInt(env, 'ANALYST_BACKOFF_MS', 60_000),
    maxAttempts: optionalPositiveInt(env, 'ANALYST_MAX_ATTEMPTS', 3),
    worker: optionalString(env, 'ANALYST_WORKER', `${os.hostname()}:${process.pid}`),
    shadow: env['ANALYST_SHADOW'] === 'true',
  };
}