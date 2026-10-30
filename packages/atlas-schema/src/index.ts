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
export const ROLLBACKS_DIR = join(here, '..', '..', '..', 'supabase', 'rollbacks');

/**
 * Skipped locally: the tool log needs the pg_cron extension, which a plain local
 * Postgres lacks, and no analyst stage reads it.
 */
export const LOCAL_SKIP = new Set(['20261025100200_atlas_tool_log.sql']);

const TOOL_LOG_MIGRATION = '20261025100200_atlas_tool_log.sql';

/**
 * Local stand-in for atlas.tool_log (same columns, identity sequence atlas.tool_log_id_seq,
 * RLS on), without pg_cron or partitions, so later migrations that grant on it apply unmodified.
 */
const TOOL_LOG_STAND_IN = `create table atlas.tool_log (
  id bigint generated always as identity, logged_at timestamptz not null default now(),
  run_id text, tool text not null, input jsonb, output jsonb, duration_ms bigint, error text,
  primary key (logged_at, id));
alter table atlas.tool_log enable row level security;`;

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

/** Mirror Supabase: service_role bypasses RLS, anon/authenticated do not. Idempotent. */
export async function ensureSupabaseRoles(client: pg.Client): Promise<void> {
  for (const [role, attrs] of [['anon', 'nologin'], ['authenticated', 'nologin'], ['service_role', 'nologin bypassrls']] as const) {
    await client.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role} ${attrs}; end if; exception when duplicate_object or unique_violation then null; end $$`);
  }
}

/**
 * Apply every atlas migration (in order) to an existing LOCAL database. The pg_cron
 * tool_log migration is replaced by TOOL_LOG_STAND_IN; other LOCAL_SKIP files are skipped.
 */
export async function applyAtlasSchema(url: string, opts: { before?: string } = {}): Promise<void> {
  assertLocalUrl(url);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.includes('_atlas') && f.endsWith('.sql')).sort();
    for (const f of files.filter((f) => opts.before === undefined || f < opts.before!)) {
      if (f === TOOL_LOG_MIGRATION) await c.query(TOOL_LOG_STAND_IN);
      else if (!LOCAL_SKIP.has(f)) await c.query(await readFile(join(MIGRATIONS_DIR, f), 'utf8'));
    }
  } finally {
    await c.end();
  }
}

/** Create a fresh database on a LOCAL server, add the Supabase roles, apply every atlas migration. */
export async function createThrowawayDatabase(
  adminUrl: string,
  opts: { before?: string } = {},
): Promise<ThrowawayDatabase> {
  assertLocalUrl(adminUrl);
  const name = `atlas_test_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await ensureSupabaseRoles(admin);
    await admin.query(`create database ${name}`);
  } finally {
    await admin.end();
  }
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  const url = u.toString();
  await applyAtlasSchema(url, opts);
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

/** Run one SQL file (a migration or a rollback) against a LOCAL database. */
export async function applySqlFile(url: string, path: string): Promise<void> {
  assertLocalUrl(url);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(await readFile(path, 'utf8'));
  } finally {
    await c.end();
  }
}
