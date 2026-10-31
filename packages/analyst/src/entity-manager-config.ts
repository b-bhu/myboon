/**
 * #480 the timed entity manager's configuration, parsed once at startup from the
 * environment. The secrets (ENTITY_MANAGER_DATABASE_URL, OLLAMA_API_KEY) are
 * required and never appear in an error message; the non-secret knobs have
 * defaults and must be positive integers (digits only, like the analyst config).
 */
export class EntityManagerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntityManagerConfigError';
  }
}

export type EntityManagerConfig = {
  /** Postgres (or postgresql) connection string for the atlas database. */
  databaseUrl: string;
  ollamaApiKey: string;
  /** Non-secret: the chat model the reviewer asks. */
  llmModel: string;
  /** Non-secret: hard cap on reviewed entities per run. */
  maxEntities: number;
  /** Non-secret: per-LLM-call timeout in ms. */
  timeoutMs: number;
};

/** Positive integers only: digits with no leading zero, so '0', '-1', '1.5', '1e3' all fail. */
const POSITIVE_INT = /^[1-9]\d*$/;

type Env = Record<string, string | undefined>;

/**
 * Every failure names the offending key and carries no environment value, so a
 * thrown error can be logged without leaking a secret.
 */
export function parseEntityManagerConfig(env: Env): EntityManagerConfig {
  const databaseUrl = env['ENTITY_MANAGER_DATABASE_URL']?.trim();
  if (!databaseUrl) throw new EntityManagerConfigError('ENTITY_MANAGER_DATABASE_URL is required (non-blank)');
  if (!databaseUrl.startsWith('postgres://') && !databaseUrl.startsWith('postgresql://')) {
    throw new EntityManagerConfigError('ENTITY_MANAGER_DATABASE_URL must start with postgres:// or postgresql://');
  }
  const ollamaApiKey = env['OLLAMA_API_KEY']?.trim();
  if (!ollamaApiKey) throw new EntityManagerConfigError('OLLAMA_API_KEY is required (non-blank)');
  return {
    databaseUrl,
    ollamaApiKey,
    llmModel: env['ENTITY_MANAGER_LLM_MODEL']?.trim() || 'glm-5.3-flash',
    maxEntities: optionalPositiveInt(env, 'ENTITY_MANAGER_MAX_ENTITIES', 40),
    timeoutMs: optionalPositiveInt(env, 'ENTITY_MANAGER_TIMEOUT_MS', 20_000),
  };
}

function optionalPositiveInt(env: Env, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!POSITIVE_INT.test(raw)) throw new EntityManagerConfigError(`${key} must be a positive integer (digits only)`);
  return Number(raw);
}