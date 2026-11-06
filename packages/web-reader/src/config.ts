/**
 * #582 web reader configuration, parsed once at startup from the environment.
 * WEB_READER_DATABASE_URL is required and never appears in an error message;
 * the non-secret knobs have defaults and must be positive integers (digits
 * only, so no 1e3, no floats, no signs). Mirrors packages/analyst/src/config.ts.
 */
export class WebReaderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebReaderConfigError';
  }
}

export type WebReaderConfig = {
  /** Postgres (or postgresql) connection string for the atlas database. */
  databaseUrl: string;
  /** Hermes model route (-m), default glm-5.3-flash. */
  hermesModel: string;
  /** Signals fetched per run (newest by fetched_at first). */
  maxPerRun: number;
  /** Batch size within one run. */
  batchSize: number;
  /** Batches processed concurrently. */
  maxParallelBatches: number;
  /** Stored body character cap. */
  bodyCapChars: number;
  /** Plain HTTP fetch timeout per hop. */
  fetchTimeoutMs: number;
  /** Hermes oneshot (headless, no browser toolsets) timeout. */
  hermesTimeoutMs: number;
};

/** Positive integers only: digits with no leading zero, so '0', '-1', '1.5', '1e3' all fail. */
const POSITIVE_INT = /^[1-9]\d*$/;

type Env = Record<string, string | undefined>;

function requireString(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new WebReaderConfigError(`${key} is required (non-blank)`);
  return value;
}

function optionalString(env: Env, key: string, fallback: string): string {
  const value = env[key]?.trim();
  return value ? value : fallback;
}

function optionalPositiveInt(env: Env, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!POSITIVE_INT.test(raw)) throw new WebReaderConfigError(`${key} must be a positive integer (digits only)`);
  return Number(raw);
}

/**
 * Every failure names the offending key and carries no environment value, so a
 * thrown error can be logged without leaking a secret.
 */
export function parseWebReaderConfig(env: Env): WebReaderConfig {
  const databaseUrl = requireString(env, 'WEB_READER_DATABASE_URL');
  if (!databaseUrl.startsWith('postgres://') && !databaseUrl.startsWith('postgresql://')) {
    throw new WebReaderConfigError('WEB_READER_DATABASE_URL must start with postgres:// or postgresql://');
  }
  return {
    databaseUrl,
    hermesModel: optionalString(env, 'WEB_READER_HERMES_MODEL', 'glm-5.3-flash'),
    maxPerRun: optionalPositiveInt(env, 'WEB_READER_MAX_PER_RUN', 50),
    batchSize: optionalPositiveInt(env, 'WEB_READER_BATCH_SIZE', 10),
    maxParallelBatches: optionalPositiveInt(env, 'WEB_READER_MAX_PARALLEL_BATCHES', 5),
    bodyCapChars: optionalPositiveInt(env, 'WEB_READER_BODY_CAP_CHARS', 4000),
    fetchTimeoutMs: optionalPositiveInt(env, 'WEB_READER_FETCH_TIMEOUT_MS', 15_000),
    hermesTimeoutMs: optionalPositiveInt(env, 'WEB_READER_HERMES_TIMEOUT_MS', 90_000),
  };
}
