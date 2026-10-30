/**
 * #480 the timed entity manager's configuration, parsed once at startup from the
 * environment. The secrets (ENTITY_MANAGER_DATABASE_URL, OLLAMA_API_KEY) are
 * required and never appear in an error message; the non-secret knobs have
 * defaults and must be positive integers (digits only, like the analyst config).
 * PHASE 1 (tests first): parseEntityManagerConfig is a stub.
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
  maxShelves: number;
  timeoutMs: number;
};

export function parseEntityManagerConfig(env: Record<string, string | undefined>): EntityManagerConfig {
  void env;
  throw new Error('not implemented');
}