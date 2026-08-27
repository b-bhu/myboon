import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const migrationPath = resolve(
  __dirname,
  '../../../../supabase/migrations/20260826175053_add_entity_memory_identity_key.sql',
)
const sql = readFileSync(migrationPath, 'utf8')

test('identity migration adds, backfills, validates, and uniquely indexes every memory identity', () => {
  assert.match(sql, /ADD COLUMN memory_identity_key text/i)
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.entity_memory_compat_identity_v1\(\)/i)
  assert.match(sql, /IF NEW\.memory_identity_key IS NULL THEN[\s\S]*myboon\.memory_identity\.v1:legacy:/i)
  assert.match(sql, /BEFORE INSERT OR UPDATE ON public\.entity_memories/i)
  assert.match(sql, /SECURITY INVOKER[\s\S]*SET search_path = ''/i)
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.entity_memory_compat_identity_v1\(\) FROM PUBLIC/i)
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.entity_memory_compat_identity_v1\(\) TO service_role/i)
  assert.match(sql, /UPDATE public\.entity_memories[\s\S]*SET memory_identity_key/i)
  assert.match(sql, /extensions\.digest\([\s\S]*'sha256'/i)
  assert.match(sql, /myboon\.memory_identity\.v1:legacy:/i)
  assert.match(sql, /concat_ws\([\s\S]*chr\(31\)[\s\S]*source[\s\S]*source_area[\s\S]*source_research_id[\s\S]*entity_id[\s\S]*memory_type[\s\S]*title/i)
  assert.match(sql, /ALTER COLUMN memory_identity_key SET NOT NULL/i)
  assert.match(sql, /CHECK \([\s\S]*memory_identity_key ~/i)
  assert.match(sql, /CREATE UNIQUE INDEX entity_memories_identity_key_unique_idx/i)
  assert.match(sql, /Keep entity_memories_source_unique_idx during the rolling deploy/i)
  assert.doesNotMatch(sql, /DROP INDEX(?: IF EXISTS)? public\.entity_memories_source_unique_idx/i)
  assert.match(sql, /entity_memories_observed_cursor_idx[\s\S]*observed_at DESC, id DESC/i)
  assert.match(sql, /entity_memories_updated_cursor_idx[\s\S]*updated_at ASC, id ASC/i)
  assert.match(sql, /entity_memories_priority_observed_cursor_idx[\s\S]*priority_class/i)
})

test('identity migration is non-destructive and leaves table security configuration untouched', () => {
  assert.doesNotMatch(sql, /^\s*(?:DELETE|MERGE|TRUNCATE|DROP TABLE)\b/im)
  assert.doesNotMatch(sql, /\bENABLE ROW LEVEL SECURITY\b|\bDISABLE ROW LEVEL SECURITY\b/i)
  assert.doesNotMatch(sql, /\bCREATE POLICY\b|\bDROP POLICY\b/i)
  assert.doesNotMatch(sql, /^(?:GRANT|REVOKE).*ON (?:TABLE )?public\.(?:entities|entity_memories)\b/im)
  assert.match(sql, /former unique tuple/i)
})

test('canonical identity RPCs use invoker rights, bounded lookup, and a transaction-scoped creation lock', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.entity_manager_lookup_entities_v1/i)
  assert.match(sql, /LIMIT LEAST\(GREATEST\(COALESCE\(p_limit, 100\), 1\), 100\) \+ 1/i)
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.entity_manager_create_entity_v1/i)
  assert.match(sql, /pg_advisory_xact_lock/i)
  assert.match(sql, /SECURITY INVOKER/gi)
  assert.match(sql, /REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC/i)
  assert.match(sql, /GRANT EXECUTE ON FUNCTION[\s\S]*TO service_role/i)
  assert.doesNotMatch(sql, /GRANT EXECUTE[\s\S]*TO (?:anon|authenticated)/i)
})

test('migration exposes a service-role-only read-only verification report', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.entity_manager_verify_migration_v1\(\)/i)
  assert.match(sql, /LANGUAGE sql[\s\S]*STABLE[\s\S]*SECURITY INVOKER/i)
  for (const field of [
    'total_rows', 'null_identity_keys', 'duplicate_identity_key_groups',
    'identity_column_exists', 'identity_not_null', 'required_indexes',
    'required_functions', 'service_role_grants', 'rolling_trigger_present',
  ]) assert.match(sql, new RegExp(`'${field}'`, 'i'))
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.entity_manager_verify_migration_v1\(\) FROM PUBLIC/i)
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.entity_manager_verify_migration_v1\(\) TO service_role/i)
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION public\.entity_manager_verify_migration_v1\(\) TO (?:anon|authenticated)/i)
})
