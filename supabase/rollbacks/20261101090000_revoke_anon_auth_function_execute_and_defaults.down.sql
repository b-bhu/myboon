-- Rollback for 20261101090000_revoke_anon_auth_function_execute_and_defaults.sql: restores the exact
-- function ACLs and postgres/public default privileges prod held on Nov 1, 2026.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

grant execute on function
  public.entity_manager_create_entity_v1(text, text, text, jsonb, text, text, boolean, jsonb, text[], text[], text[]),
  public.entity_manager_verify_migration_v1(),
  public.entity_memory_compat_identity_v1(),
  public.token_source_rank(text),
  public.touch_ai_explanations_updated_at()
to anon, authenticated;
grant execute on function public.token_source_rank(text), public.touch_ai_explanations_updated_at() to public;

alter default privileges for role postgres in schema public grant all on tables to anon, authenticated;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated;

commit;
