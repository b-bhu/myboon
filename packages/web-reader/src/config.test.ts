import { describe, expect, test } from 'vitest';

import { parseWebReaderConfig, WebReaderConfigError } from './config.js';

describe('parseWebReaderConfig (#582)', () => {
  const baseEnv = { WEB_READER_DATABASE_URL: 'postgres://web_reader_worker@localhost/db' };

  test('requires WEB_READER_DATABASE_URL and never echoes its value', () => {
    const before = 'postgres://secret-value-in-message';
    try {
      parseWebReaderConfig({});
      expect.unreachable('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(WebReaderConfigError);
      const message = (e as Error).message;
      expect(message).toContain('WEB_READER_DATABASE_URL');
      expect(message).not.toContain(before);
    }
    try {
      parseWebReaderConfig({ WEB_READER_DATABASE_URL: 'mysql://x/y' });
      expect.unreachable('should throw');
    } catch (e) {
      expect((e as Error).message).toContain('must start with postgres:// or postgresql://');
      expect((e as Error).message).not.toContain('mysql://x/y');
    }
  });

  test('defaults: model glm-5.3-flash, 50 per run, batches of 10, 5 parallel, 4000 cap, 15s fetch, 90s hermes', () => {
    const c = parseWebReaderConfig(baseEnv);
    expect(c).toEqual({
      databaseUrl: baseEnv.WEB_READER_DATABASE_URL,
      hermesModel: 'glm-5.3-flash',
      maxPerRun: 50,
      batchSize: 10,
      maxParallelBatches: 5,
      bodyCapChars: 4000,
      fetchTimeoutMs: 15_000,
      hermesTimeoutMs: 90_000,
    });
  });

  test('non-secret knobs are overridable', () => {
    const c = parseWebReaderConfig({
      ...baseEnv,
      WEB_READER_HERMES_MODEL: 'glm-test',
      WEB_READER_MAX_PER_RUN: '17',
      WEB_READER_BATCH_SIZE: '4',
      WEB_READER_MAX_PARALLEL_BATCHES: '2',
      WEB_READER_BODY_CAP_CHARS: '500',
      WEB_READER_FETCH_TIMEOUT_MS: '5000',
      WEB_READER_HERMES_TIMEOUT_MS: '60000',
    });
    expect(c.hermesModel).toBe('glm-test');
    expect(c.maxPerRun).toBe(17);
    expect(c.batchSize).toBe(4);
    expect(c.maxParallelBatches).toBe(2);
    expect(c.bodyCapChars).toBe(500);
    expect(c.fetchTimeoutMs).toBe(5000);
    expect(c.hermesTimeoutMs).toBe(60_000);
  });

  test('bad integers name the key, accept digits only', () => {
    for (const raw of ['0', '1.5', '1e3', '-1', 'abc', '01']) {
      try {
        parseWebReaderConfig({ ...baseEnv, WEB_READER_MAX_PER_RUN: raw });
        expect.unreachable(`should throw for ${raw}`);
      } catch (e) {
        expect((e as Error).message).toContain('WEB_READER_MAX_PER_RUN');
      }
    }
  });
});
