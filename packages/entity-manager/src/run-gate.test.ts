/**
 * #593 entity-manager entrypoint, no database: the gate on run.ts (spawned
 * with a clean env) names the flag/stage when off and the missing key when on.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const TSX = join(here, '..', '..', '..', 'node_modules', '.bin', 'tsx');
const RUN = join(here, 'run.ts');

function runEntry(env: Record<string, string>) {
  return spawnSync(TSX, [RUN], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', timeout: 60_000 });
}

describe('#593 run.ts gate', () => {
  it('ENTITY_MANAGER_ENABLED unset: exits 0 with one info line and never touches config or the DB', () => {
    const r = runEntry({});
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'info', stage: 'entity-manager' });
    expect(lines[0]).toContain('ENTITY_MANAGER_ENABLED');
    expect(r.stderr).not.toMatch(/ENTITY_MANAGER_DATABASE_URL|JEV_API_TOKEN/);
  });

  it('ENTITY_MANAGER_ENABLED=false: exits 0 the same way', () => {
    expect(runEntry({ ENTITY_MANAGER_ENABLED: 'false' }).status).toBe(0);
  });

  it('ENTITY_MANAGER_ENABLED=true with a missing secret: exits 1, names the key, prints no secret', () => {
    const r = runEntry({ ENTITY_MANAGER_ENABLED: 'true', OLLAMA_API_KEY: 'canary-ollama-secret', JEV_API_TOKEN: 'canary-jev-secret' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ENTITY_MANAGER_DATABASE_URL');
    expect(r.stdout + r.stderr).not.toMatch(/canary-(ollama|jev)-secret/);
  });
});

describe('#621 run-retry.ts gate', () => {
  const RETRY = join(here, 'run-retry.ts');
  const runRetry = (env: Record<string, string>) =>
    spawnSync(TSX, [RETRY], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', timeout: 60_000 });

  it('ENTITY_MANAGER_RETRY_ENABLED unset: exits 0 with one info line and never touches config or the DB', () => {
    const r = runRetry({ ENTITY_MANAGER_ENABLED: 'true' });
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'info', stage: 'entity-manager-retry' });
    expect(lines[0]).toContain('ENTITY_MANAGER_RETRY_ENABLED');
    expect(r.stderr).not.toMatch(/ENTITY_MANAGER_DATABASE_URL/);
  });

  it('ENTITY_MANAGER_RETRY_ENABLED=true with a missing secret: exits 1, names the key, prints no secret', () => {
    const r = runRetry({ ENTITY_MANAGER_RETRY_ENABLED: 'true', OLLAMA_API_KEY: 'canary-ollama-secret' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ENTITY_MANAGER_DATABASE_URL');
    expect(r.stdout + r.stderr).not.toContain('canary-ollama-secret');
  });
});
