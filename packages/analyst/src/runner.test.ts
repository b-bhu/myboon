/**
 * #512 analyst entrypoint, no database: the gate on run.ts (spawned with a clean env) and the pool
 * lifecycle in analystMain when the run throws.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { analystMain } from './runner.js';

const here = dirname(fileURLToPath(import.meta.url));
const TSX = join(here, '..', '..', '..', 'node_modules', '.bin', 'tsx');
const RUN = join(here, 'run.ts');

function runEntry(env: Record<string, string>) {
  return spawnSync(TSX, [RUN], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', timeout: 60_000 });
}

describe('#512 run.ts gate', () => {
  it('ANALYST_ENABLED unset: exits 0 with one info line and never touches config or the DB', () => {
    const r = runEntry({});
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'info', stage: 'analyst' });
    expect(lines[0]).toContain('ANALYST_ENABLED');
    expect(r.stderr).not.toMatch(/ANALYST_DATABASE_URL|JEV_API_TOKEN/);
  });

  it('ANALYST_ENABLED=false: exits 0 the same way', () => {
    expect(runEntry({ ANALYST_ENABLED: 'false' }).status).toBe(0);
  });

  it('ANALYST_ENABLED=true with a missing secret: exits 1, names the key, prints no secret', () => {
    const r = runEntry({ ANALYST_ENABLED: 'true', OLLAMA_API_KEY: 'canary-ollama-secret', JEV_API_TOKEN: 'canary-jev-secret' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ANALYST_DATABASE_URL');
    expect(r.stdout + r.stderr).not.toMatch(/canary-(ollama|jev)-secret/);
  });
});

describe('#512 analystMain pool lifecycle', () => {
  const env = { ANALYST_DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x', OLLAMA_API_KEY: 'k', JEV_API_TOKEN: 't' };

  it('a run that throws still ends the pool, and the error propagates', async () => {
    let ended = 0;
    const pool = {
      query: async () => { throw new Error('connection refused'); },
      connect: async () => { throw new Error('connection refused'); },
      end: async () => { ended += 1; },
    } as unknown as Pool;
    await expect(analystMain({ env, createPool: () => pool, log: () => {} })).rejects.toThrow(/connection refused/);
    expect(ended).toBe(1);
  });

  it('the pool is created from ANALYST_DATABASE_URL', async () => {
    const urls: string[] = [];
    const pool = { query: async () => ({ rows: [] }), connect: async () => { throw new Error('unused'); }, end: async () => {} } as unknown as Pool;
    const summary = await analystMain({ env, createPool: (url) => { urls.push(url); return pool; }, log: () => {} });
    expect(urls).toEqual([env.ANALYST_DATABASE_URL]);
    expect(summary).toMatchObject({ processed: 0, analysed: 0, parked: 0, failed: 0, lost_claim: 0 });
  });
});
