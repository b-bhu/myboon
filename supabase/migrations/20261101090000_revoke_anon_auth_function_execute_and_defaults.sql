-- #397 refresh (Nov 1 2026): finish removing anon / authenticated access in public + atlas.
-- Prod audit Nov 1 (read-only, pg_class/pg_proc ACLs after #538/#542/#546):
--   * tables, views, sequences in public and atlas: 0 anon/authenticated grants left
--     (20261025140056 already revoked the 9 public tables; atlas never granted them).
--   * functions: anon/authenticated (and PUBLIC on 2) can still EXECUTE 5 public functions below.
--   * default privileges (role postgres, schema public) would re-grant ALL on every new
--     table, sequence and function to anon/authenticated.
-- Not changed: schema USAGE on public (Supabase default, harmless with no object grants);
-- atlas.history_guard/touch_updated_at/uuidv7 keep PUBLIC execute (anon has no USAGE on atlas,
-- and worker roles rely on it for defaults/triggers); supabase_admin default privileges
-- (only supabase_admin can alter them). service_role keeps its explicit EXECUTE grants.
-- Trigger functions do not need EXECUTE at fire time.
-- Readers: packages/api, collectors, scout-news use SUPABASE_SERVICE_ROLE_KEY; analyst/entity
-- manager use their own Postgres logins; web and mobile go through the API only.
-- Rollback: supabase/rollbacks/20261101090000_revoke_anon_auth_function_execute_and_defaults.down.sql

SET lock_timeout = '5s';
SET statement_timeout = '30s';

REVOKE EXECUTE ON FUNCTION
  public.entity_manager_create_entity_v1(text, text, text, jsonb, text, text, boolean, jsonb, text[], text[], text[]),
  public.entity_manager_verify_migration_v1(),
  public.entity_memory_compat_identity_v1(),
  public.token_source_rank(text),
  public.touch_ai_explanations_updated_at()
FROM PUBLIC, anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
