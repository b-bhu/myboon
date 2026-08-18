-- Temporary pipeline state is now owned by the VPS SQLite stores:
--   packages/collectors/.data/pipeline.sqlite
--   packages/collectors/.data/news.sqlite
--
-- Durable product tables (entities, entity_memories, published_narratives,
-- entity_published_history), the pipeline run ledger, catalog tables, and
-- unrelated collectors remain in Supabase.
--
-- Deliberately omit CASCADE. If an unexpected kept object still depends on a
-- retired table, the migration must fail and roll back instead of deleting
-- that dependency silently.

begin;

set local lock_timeout = '5s';

drop table if exists public.news_research_results;
drop table if exists public.news_candidate_observations;
drop table if exists public.news_source_runs;

drop table if exists public.polymarket_market_editor_decisions;
drop table if exists public.polymarket_market_candidate_research;
drop table if exists public.polymarket_market_candidates;
drop table if exists public.polymarket_market_watchlist;

drop table if exists public.editor_drafts;

commit;
