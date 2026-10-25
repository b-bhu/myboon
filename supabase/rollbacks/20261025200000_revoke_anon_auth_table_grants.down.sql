-- Rollback for 20261025200000_revoke_anon_auth_table_grants.sql: restores the
-- exact anon / authenticated grants prod held on Oct 25, 2026 (#397 audit).
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

grant select, insert, update, delete, truncate, references, trigger on table
  public.ai_explanations, public.entities, public.entity_published_history,
  public.manual_command_log, public.pipeline_runs, public.polymarket_profile_cache,
  public.published_narratives, public.token_registry
to anon, authenticated;

grant select, references, trigger on table public.entity_memories to anon, authenticated;

commit;
