-- #397: remove every anon / authenticated table grant on the 9 server-only
-- public tables. Prod audit (Oct 25, read-only, information_schema.role_table_grants):
-- anon and authenticated each hold SELECT, INSERT, UPDATE, DELETE, TRUNCATE,
-- REFERENCES, TRIGGER on 8 of them and REFERENCES, SELECT, TRIGGER on
-- entity_memories. RLS does not cover TRUNCATE, and published_narratives has
-- RLS off, so anon could read and truncate it through the public key.
-- No documented reader uses anon or authenticated: packages/api and the
-- collectors use service_role only (BYPASSRLS, table grants unchanged here).
-- service_role and myboon_knowledge_owner grants are untouched.
-- Also covers the unrun revokes of 20260710041040 (entities, entity_memories,
-- entity_published_history).
-- Applied on prod Oct 25 2026 (CTO-approved), recorded as 20261025140056.
-- Rollback: supabase/rollbacks/20261025140056_revoke_anon_auth_table_grants.down.sql

SET lock_timeout = '5s';
SET statement_timeout = '30s';

REVOKE ALL PRIVILEGES ON TABLE
  public.ai_explanations, public.entities, public.entity_memories, public.entity_published_history, public.manual_command_log, public.pipeline_runs, public.polymarket_profile_cache, public.published_narratives, public.token_registry
FROM anon, authenticated;
