import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const sql = readFileSync(resolve(
  __dirname,
  '../../../../supabase/migrations/20260920151558_entity_catalog_maintenance.sql',
), 'utf8')
const globalLeaseSql = readFileSync(resolve(
  __dirname,
  '../../../../supabase/migrations/20260920161429_entity_catalog_global_lease.sql',
), 'utf8')
const automaticCleanupSql = readFileSync(resolve(
  __dirname,
  '../../../../supabase/migrations/20260921141231_entity_catalog_automatic_cleanup.sql',
), 'utf8')
const automaticAliasDisableSql = readFileSync(resolve(
  __dirname,
  '../../../../supabase/migrations/20260921141414_disable_entity_catalog_automatic_alias_cleanup.sql',
), 'utf8')
const cleanupBoundarySql = readFileSync(resolve(
  __dirname,
  '../../../../supabase/migrations/20260921142116_strengthen_entity_catalog_cleanup_boundaries.sql',
), 'utf8')

test('maintenance migration is additive, service-role-only, and has no automatic rewrite', () => {
  assert.match(sql, /CREATE TABLE public\.entity_catalog_maintenance_runs/i)
  assert.match(sql, /CREATE TABLE public\.entity_catalog_maintenance_findings/i)
  assert.match(sql, /CREATE TABLE public\.entity_catalog_maintenance_operations/i)
  assert.match(sql, /CREATE TABLE public\.entity_redirects/i)
  assert.match(sql, /entity_catalog_maintenance_operations_source_entity_idx/)
  assert.match(sql, /entity_catalog_maintenance_findings_right_entity_idx/)
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/)
  assert.match(sql, /REVOKE ALL ON TABLE public\.entity_catalog_maintenance_runs FROM anon, authenticated/i)
  assert.match(sql, /SECURITY INVOKER/i)
  const migrationDdl = sql.slice(0, sql.indexOf('CREATE OR REPLACE FUNCTION public.internal_entity_catalog_profiles_v1'))
  assert.doesNotMatch(migrationDdl, /DELETE FROM public\.entities/i)
  assert.doesNotMatch(migrationDdl, /UPDATE public\.entities/i)
  assert.doesNotMatch(migrationDdl, /UPDATE public\.entity_memories/i)
})

test('compact profile function excludes memory content and arbitrary context', () => {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.internal_entity_catalog_profiles_v1')
  const end = sql.indexOf('CREATE OR REPLACE FUNCTION public.entity_catalog_quarantine_alias_v1')
  const functionSql = sql.slice(start, end)
  assert.match(functionSql, /memory\.title/)
  assert.match(functionSql, /recent_rank <= 5/)
  assert.match(functionSql, /p_after_id uuid DEFAULT NULL/)
  assert.match(functionSql, /LIMIT least\(greatest\(COALESCE\(p_limit, 500\), 1\), 1000\)/)
  assert.doesNotMatch(functionSql, /memory\.summary/)
  assert.doesNotMatch(functionSql, /memory\.body/)
  assert.doesNotMatch(functionSql, /memory\.context/)
  assert.doesNotMatch(functionSql, /memory\.evidence/)
})

test('mutation boundary supports approved reversible alias quarantine but no merge apply', () => {
  assert.match(sql, /polluted-alias quarantine requires explicit approval/)
  assert.match(sql, /Entity aliases changed after this operation; rollback requires review/)
  assert.match(sql, /entity_catalog_rollback_alias_quarantine_v1/)
  assert.match(sql, /entity_catalog_prepare_merge_v1/)
  assert.match(sql, /'draftInventoryComplete', false/)
  assert.match(sql, /'memoryIdentityKeysRewritten', false/)
  assert.match(sql, /'applyEligible', false/)
  assert.doesNotMatch(sql, /entity_catalog_apply_merge_v1/)
})

test('follow-up migration replaces the per-scope lease with one global lease', () => {
  assert.match(globalLeaseSql, /DROP INDEX IF EXISTS public\.entity_catalog_maintenance_one_running_scope_idx/i)
  assert.match(globalLeaseSql, /CREATE UNIQUE INDEX entity_catalog_maintenance_one_running_global_idx/i)
  assert.match(globalLeaseSql, /ON public\.entity_catalog_maintenance_runs \(\(1\)\)/i)
  assert.match(globalLeaseSql, /WHERE status = 'running'/i)
  assert.ok(
    globalLeaseSql.indexOf('CREATE UNIQUE INDEX entity_catalog_maintenance_one_running_global_idx')
      < globalLeaseSql.indexOf('DROP INDEX IF EXISTS public.entity_catalog_maintenance_one_running_scope_idx'),
    'the global lease must exist before the per-scope lease is removed',
  )
})

test('automatic cleanup is snapshot-guarded, reversible, and never deletes an Entity', () => {
  assert.match(automaticCleanupSql, /entity_catalog_apply_eligible_alias_v1/)
  assert.match(automaticCleanupSql, /finding\.auto_apply_eligible/)
  assert.match(automaticCleanupSql, /Entity identity changed after the finding; rerun maintenance/)
  assert.match(automaticCleanupSql, /entity_catalog_apply_merge_v1/)
  assert.match(automaticCleanupSql, /status = 'archived'/)
  assert.match(automaticCleanupSql, /INSERT INTO public\.entity_redirects/)
  assert.match(automaticCleanupSql, /entity_catalog_rollback_merge_v1/)
  assert.match(automaticCleanupSql, /canonical memory-scope conflict/)
  assert.match(automaticCleanupSql, /canonical_source_item_id/)
  assert.match(automaticCleanupSql, /source_entity\.aliases/)
  assert.match(automaticCleanupSql, /resolve_entity_redirect_v1/)
  assert.match(automaticCleanupSql, /source_alias/)
  assert.match(automaticCleanupSql, /entity_redirect_single_hop_guard/)
  assert.match(automaticCleanupSql, /entity_memories_active_entity_guard/)
  assert.match(automaticCleanupSql, /external narrative dependency/)
  assert.doesNotMatch(automaticCleanupSql, /DELETE FROM public\.entities/i)
  assert.match(automaticCleanupSql, /REVOKE ALL ON FUNCTION public\.entity_catalog_apply_merge_v1/)
  assert.match(automaticAliasDisableSql, /DROP FUNCTION IF EXISTS public\.entity_catalog_apply_eligible_alias_v1/)
  assert.match(cleanupBoundarySql, /referenced Entity is no longer active; resolve its redirect and retry/)
  assert.match(cleanupBoundarySql, /a new narrative depends on a moved memory/)
})
