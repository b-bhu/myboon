import { describe, expect, test } from 'vitest';

import { webReaderEntry } from './reader.js';

describe('webReaderEntry gate (#582)', () => {
  test('gate off exits 0 and run is never called — no pool, no network', async () => {
    let exitCode: number | null = null;
    const lines: string[] = [];
    await webReaderEntry({
      env: {
        WEB_READER_ENABLED: undefined,
        WEB_READER_DATABASE_URL: 'postgres://web_reader_worker@localhost/webreader',
      },
      exit: (code) => { exitCode = code; },
      log: (line) => { lines.push(line); },
      run: async () => {
        throw new Error('run must never be called for a gated-off stage');
      },
    });
    expect(exitCode).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ level: 'info', stage: 'web-reader' });
  });

  test('any non-"true" value is off (WEB_READER_ENABLED=false)', async () => {
    let exitCode: number | null = null;
    await webReaderEntry({
      env: { WEB_READER_ENABLED: 'false' },
      exit: (code) => { exitCode = code; },
      run: async () => { throw new Error('must not run'); },
    });
    expect(exitCode).toBe(0);
  });

  test('gate on calls run once', async () => {
    let ran = 0;
    await webReaderEntry({
      env: { WEB_READER_ENABLED: 'true' },
      run: async () => { ran += 1; },
    });
    expect(ran).toBe(1);
  });
});
