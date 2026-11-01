/**
 * #512 analyst worker config: parsed from env once at startup. Secrets (ANALYST_DATABASE_URL,
 * OLLAMA_API_KEY, JEV_API_TOKEN) are required and never appear in an error; non-secret knobs have
 * defaults and are validated as positive integers.
 */
import { describe, expect, it } from 'vitest';

import { AnalystConfigError, parseAnalystConfig } from './config.js';

const CANARY_URL = 'postgres://analyst_worker:canary-db-secret@127.0.0.1:6543/postgres';
const CANARY_OLLAMA = 'canary-ollama-secret';
const CANARY_JEV = 'canary-jev-secret';
const base = { ANALYST_DATABASE_URL: CANARY_URL, OLLAMA_API_KEY: CANARY_OLLAMA, JEV_API_TOKEN: CANARY_JEV };

function errorOf(env: Record<string, string | undefined>): Error {
  try {
    parseAnalystConfig(env);
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected parseAnalystConfig to throw');
}

describe('#512 parseAnalystConfig', () => {
  it('applies the defaults: 40 signals per run, glm-5.3-flash, shadow off', () => {
    const c = parseAnalystConfig(base);
    expect(c).toMatchObject({
      databaseUrl: CANARY_URL, ollamaApiKey: CANARY_OLLAMA, jevApiToken: CANARY_JEV,
      llmModel: 'glm-5.3-flash', maxSignalsPerRun: 40, shadow: false,
    });
    for (const k of ['leaseMs', 'timeoutMs', 'backoffMs', 'maxAttempts'] as const) {
      expect(Number.isSafeInteger(c[k]) && c[k] > 0).toBe(true);
    }
    expect(c.worker.length).toBeGreaterThan(0);
  });

  it('reads the non-secret overrides', () => {
    const c = parseAnalystConfig({
      ...base, ANALYST_LLM_MODEL: 'glm-x', ANALYST_MAX_SIGNALS_PER_RUN: '5', ANALYST_LEASE_MS: '1000',
      ANALYST_TIMEOUT_MS: '2000', ANALYST_BACKOFF_MS: '3000', ANALYST_MAX_ATTEMPTS: '4', ANALYST_WORKER: 'vps-1',
      ANALYST_SHADOW: 'true',
    });
    expect(c).toMatchObject({ llmModel: 'glm-x', maxSignalsPerRun: 5, leaseMs: 1000, timeoutMs: 2000,
      backoffMs: 3000, maxAttempts: 4, worker: 'vps-1', shadow: true });
  });

  it('shadow is on only for the exact string "true"', () => {
    expect(parseAnalystConfig({ ...base, ANALYST_SHADOW: 'TRUE' }).shadow).toBe(false);
    expect(parseAnalystConfig({ ...base, ANALYST_SHADOW: '1' }).shadow).toBe(false);
  });

  for (const key of ['ANALYST_DATABASE_URL', 'OLLAMA_API_KEY', 'JEV_API_TOKEN'] as const) {
    it(`a missing or blank ${key} fails naming the key`, () => {
      for (const v of [undefined, '', '   ']) {
        const e = errorOf({ ...base, [key]: v });
        expect(e).toBeInstanceOf(AnalystConfigError);
        expect(e.message).toContain(key);
      }
    });
  }

  for (const key of ['ANALYST_MAX_SIGNALS_PER_RUN', 'ANALYST_LEASE_MS', 'ANALYST_TIMEOUT_MS', 'ANALYST_BACKOFF_MS', 'ANALYST_MAX_ATTEMPTS'] as const) {
    it(`${key} must be a positive integer`, () => {
      for (const v of ['0', '-1', '1.5', 'abc', '1e3']) {
        const e = errorOf({ ...base, [key]: v });
        expect(e).toBeInstanceOf(AnalystConfigError);
        expect(e.message).toContain(key);
      }
    });
  }

  it('no error message ever carries a secret value', () => {
    const errors = [
      errorOf({ ...base, JEV_API_TOKEN: undefined }),
      errorOf({ ...base, ANALYST_MAX_ATTEMPTS: 'x' }),
      errorOf({ ...base, ANALYST_DATABASE_URL: 'not a url canary-db-secret' }),
    ];
    for (const e of errors) {
      for (const s of ['canary-db-secret', CANARY_OLLAMA, CANARY_JEV]) expect(e.message).not.toContain(s);
    }
  });

  it('ANALYST_DATABASE_URL must be a postgres:// or postgresql:// URL', () => {
    expect(errorOf({ ...base, ANALYST_DATABASE_URL: 'https://example.com' }).message).toContain('ANALYST_DATABASE_URL');
    expect(parseAnalystConfig({ ...base, ANALYST_DATABASE_URL: 'postgresql://u:p@h:5432/d' }).databaseUrl).toBe('postgresql://u:p@h:5432/d');
  });
});
