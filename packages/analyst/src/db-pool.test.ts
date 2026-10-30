/**
 * #391 the analyst's pg pool must trust the Supabase root CA with full
 * verification. node-pg lets a URL `sslmode` replace the `ssl` object, so an
 * `sslmode=require` URL must not drop the CA or turn verification off.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analystPoolConfig, loadAnalystDatabaseCa, SUPABASE_ROOT_CA_PATH } from './db-pool.js';

const REMOTE = 'postgresql://atlas_analyst:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres';
const BUNDLED = readFileSync(SUPABASE_ROOT_CA_PATH, 'utf8');

describe('#391 analyst pool TLS', () => {
  it('bundles the public Supabase Root 2021 CA', () => {
    expect(BUNDLED).toContain('-----BEGIN CERTIFICATE-----');
    expect(loadAnalystDatabaseCa({})).toBe(BUNDLED);
  });

  it('remote hosts get ssl.ca and rejectUnauthorized true', () => {
    const cfg = analystPoolConfig(REMOTE, BUNDLED);
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true, ca: BUNDLED });
  });

  it('sslmode in the URL is stripped so it cannot override the ssl object', () => {
    for (const q of ['sslmode=require', 'sslmode=verify-full&application_name=x', 'sslrootcert=/x&sslmode=no-verify']) {
      const cfg = analystPoolConfig(`${REMOTE}?${q}`, BUNDLED);
      expect(cfg.connectionString).not.toMatch(/ssl/i);
      expect(cfg.ssl).toEqual({ rejectUnauthorized: true, ca: BUNDLED });
    }
    expect(analystPoolConfig(`${REMOTE}?sslmode=require&application_name=x`, BUNDLED).connectionString).toContain('application_name=x');
  });

  it('local hosts connect without TLS', () => {
    expect(analystPoolConfig('postgresql://u:p@localhost:5432/db', BUNDLED).ssl).toBe(false);
    expect(analystPoolConfig('postgresql://u:p@127.0.0.1:5432/db?sslmode=disable', BUNDLED).ssl).toBe(false);
  });

  it('ANALYST_DATABASE_CA_FILE overrides the bundled CA; a missing file throws without the path contents', () => {
    expect(loadAnalystDatabaseCa({ ANALYST_DATABASE_CA_FILE: SUPABASE_ROOT_CA_PATH })).toBe(BUNDLED);
    expect(() => loadAnalystDatabaseCa({ ANALYST_DATABASE_CA_FILE: '/nonexistent/ca.crt' })).toThrow(/ANALYST_DATABASE_CA_FILE/);
  });

  it('a file without a PEM certificate is rejected', () => {
    expect(() => loadAnalystDatabaseCa({ ANALYST_DATABASE_CA_FILE: new URL(import.meta.url).pathname })).toThrow(/PEM/);
  });
});
