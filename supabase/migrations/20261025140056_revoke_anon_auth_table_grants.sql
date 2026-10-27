SET lock_timeout = '5s';
SET statement_timeout = '30s';

REVOKE ALL PRIVILEGES ON TABLE
  public.ai_explanations, public.entities, public.entity_memories, public.entity_published_history, public.manual_command_log, public.pipeline_runs, public.polymarket_profile_cache, public.published_narratives, public.token_registry
FROM anon, authenticated;
