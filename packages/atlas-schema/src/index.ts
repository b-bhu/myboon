/**
 * @myboon/atlas-schema: the V4 Atlas schema package (#478).
 *
 * The migration SQL itself stays in supabase/migrations (the Supabase CLI and the
 * squawk CI step read it there); this package owns the local-only applier used by
 * isolated tests. It refuses any non-local host, so it can never touch prod.
 */
import { readdir, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, '..', '..', '..', 'supabase', 'migrations');

/**
 * Skipped locally: the tool log needs the pg_cron extension, which a plain local
 * Postgres lacks, and no analyst stage reads it.
 */
export const LOCAL_SKIP = new Set(['20261025100200_atlas_tool_log.sql']);

/** Atlas migrations in apply order (file names start with a timestamp). */
export async function atlasMigrationFiles(dir = MIGRATIONS_DIR): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.includes('_atlas') && f.endsWith('.sql') && !LOCAL_SKIP.has(f)).sort();
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function assertLocalUrl(url: string): void {
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host)) throw new Error(`refusing non-local database host: ${host}`);
}

export interface ThrowawayDatabase {
  url: string;
  name: string;
  drop(): Promise<void>;
}

/** Create a fresh database on a LOCAL server, add the Supabase roles, apply every atlas migration. */
export async function createThrowawayDatabase(adminUrl: string): Promise<ThrowawayDatabase> {
  assertLocalUrl(adminUrl);
  const name = `atlas_test_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role} nologin; end if; end $$`);
    }
    await admin.query(`create database ${name}`);
  } finally {
    await admin.end();
  }
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  const url = u.toString();
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    for (const f of await atlasMigrationFiles()) {
      await c.query(await readFile(join(MIGRATIONS_DIR, f), 'utf8'));
    }
  } finally {
    await c.end();
  }
  return {
    url,
    name,
    async drop() {
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      try {
        await a.query(`drop database if exists ${name} with (force)`);
      } finally {
        await a.end();
      }
    },
  };
}
