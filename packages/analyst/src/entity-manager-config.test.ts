/**
 * #480 entity manager config: parsed from env once at startup. Secrets (ENTITY_MANAGER_DATABASE_URL,
 * OLLAMA_API_KEY) are required and never appear in an error; the non-secret knobs have defaults
 * (glm-5.3-flash, 40 shelves, 20000ms) and are validated as positive integers.
 */
import { describe, expect, it } from 'vitest';

import { EntityManagerConfigError, parseEntityManagerConfig } from './entity-manager-config.js';

const CANARY_URL = 'postgres://entity_worker:canary-db-secret@127.0.0.1:6543/postgres';
const CANARY_OLLAMA = 'canary-ollama-secret';
const base = { ENTITY_MANAGER_DATABASE_URL: CANARY_URL, OLLAMA_API_KEY: CANARY_OLLAMA };

function errorOf(env: Record<string, string | undefined>): Error {
  try {
    parseEntityManagerConfig(env);
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected parseEntityManagerConfig to throw');
}

describe('#480 parseEntityManagerConfig', () => {
  it('applies the defaults: glm-5.3-flash, 40 shelves per run, 20000ms timeout', () => {
    expect(parseEntityManagerConfig(base)).toEqual({
      databaseUrl: CANARY_URL,
      ollamaApiKey: CANARY_OLLAMA,
      llmModel: 'glm-5.3-flash',
      maxShelves: 40,
      timeoutMs: 20_000,
    });
  });

  it('reads the non-secret overrides', () => {
    const c = parseEntityManagerConfig({
      ...base,
      ENTITY_MANAGER_LLM_MODEL: 'glm-x',
      ENTITY_MANAGER_MAX_SHELVES: '5',
      ENTITY_MANAGER_TIMEOUT_MS: '900',
    });
    expect(c).toMatchObject({ llmModel: 'glm-x', maxShelves: 5, timeoutMs: 900 });
  });

  for (const key of ['ENTITY_MANAGER_MAX_SHELVES', 'ENTITY_MANAGER_TIMEOUT_MS'] as const) {
    it(`${key} must be a positive integer`, () => {
      for (const v of ['0', '-1', '1.5', 'abc', '1e3']) {
        const e = errorOf({ ...base, [key]: v });
        expect(e).toBeInstanceOf(EntityManagerConfigError);
        expect(e.message).toContain(key);
      }
    });
  }

  for (const key of ['ENTITY_MANAGER_DATABASE_URL', 'OLLAMA_API_KEY'] as const) {
    it(`a missing or blank ${key} fails naming the key`, () => {
      for (const v of [undefined, '', '   ']) {
        const e = errorOf({ ...base, [key]: v });
        expect(e).toBeInstanceOf(EntityManagerConfigError);
        expect(e.message).toContain(key);
      }
    });
  }

  it('ENTITY_MANAGER_DATABASE_URL must be a postgres:// or postgresql:// URL', () => {
    expect(errorOf({ ...base, ENTITY_MANAGER_DATABASE_URL: 'https://example.com' }).message).toContain('ENTITY_MANAGER_DATABASE_URL');
    expect(errorOf({ ...base, ENTITY_MANAGER_DATABASE_URL: 'mysql://u@h/d' }).message).toContain('postgres://');
    expect(parseEntityManagerConfig({ ...base, ENTITY_MANAGER_DATABASE_URL: 'postgresql://u:k@h:5432/d' }).databaseUrl)
      .toBe('postgresql://u:k@h:5432/d');
  });

  it('no error message ever carries a secret value', () => {
    const errors = [
      errorOf({ ...base, OLLAMA_API_KEY: undefined }),
      errorOf({ ...base, ENTITY_MANAGER_MAX_SHELVES: 'x' }),
      errorOf({ ...base, ENTITY_MANAGER_DATABASE_URL: 'not a url canary-db-secret' }),
      errorOf({ ...base, ENTITY_MANAGER_DATABASE_URL: undefined }),
    ];
    for (const e of errors) {
      for (const s of ['canary-db-secret', CANARY_OLLAMA]) expect(e.message).not.toContain(s);
    }
  });
});