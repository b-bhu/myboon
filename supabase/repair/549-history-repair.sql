-- #549 migration hygiene: planned prod history repair. DOCS ONLY.
-- NOT a migration (lives outside supabase/migrations) and never run by CI or db push.
-- Run only after the #549 PR merges AND CTO gives the go on #549, one block at a time,
-- by DB Guy, and only if the block's pre-check returns ok = true.
--
-- A. Repo renames (no prod write needed). The new version = the existing prod history row,
--    and file content md5 = md5(array_to_string(statements,'')) of that row (checked Nov 1, 2026).
--    20260603_polymarket_markets_remove_snapshots -> 20260603053807
--    20260603_polymarket_market_researcher        -> 20260603122419
--    20260604_polymarket_market_editor            -> 20260604152337
--    20260606_retire_v2_feed_tables               -> 20260606140326
--    20260607_polymarket_researcher_optimization  -> 20260622110309
--    20260625_entity_memories_primary_model       -> 20260625114141
--    20260701_editor_drafts_v1                    -> 20260701160531
--    20260703_publisher_v1_editor_drafts          -> 20260703163836
--    20261018090000_published_entity_managed_ids  -> 20261018004252
--    20261020200000_article_context_v2            -> 20261024162849
--   Pre-check (re-run any time; every row must be ok):
SELECT version, name, md5(array_to_string(statements,'')) AS md5,
       md5(array_to_string(statements,'')) = expected AS ok
FROM supabase_migrations.schema_migrations
JOIN (VALUES ('20260603053807','ba4d2d7ee7588f7c794f85a903a7b111'),('20260603122419','2126bca5f516b5deda86759b16cf2b67'),
             ('20260604152337','8d543f33bf369559778f491d1c3eb9f7'),('20260606140326','16f4604fe4d00193475c3942fe25b247'),
             ('20260622110309','1281aabc8b6c156705f60c8a8d056cd9'),('20260625114141','557e3b066b35a5ebc66b49c61ed4accb'),
             ('20260701160531','0131f87c0b828528f30cceb07bf122cd'),('20260703163836','8070e8e06a6574535a767309379ef568'),
             ('20261018004252','19da20f219f38c6e4dea73525b60f5c9'),('20261024162849','43d09471647430a06f82a03f8b6a18ee'))
  AS e(v, expected) ON e.v = version
ORDER BY version;
--
--   NOT renamed (content differs from the prod row; needs its own review):
--    20260602_polymarket_markets_data_engineer vs 20260602151211
--    20260605_polymarket_market_publisher      vs 20260606044250
--    20260624_entity_manager_v1                vs 20260624133832
--    20260729_manual_command_log               vs 20260910143705
--
-- B. 20260706 duplicate version: files renamed to unique versions; history rows to insert.
-- B1. 20260706000100_pipeline_runs: table is live on prod.
--   Pre-check:
SELECT to_regclass('public.pipeline_runs') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260706000100') AS ok;
--   Insert (only if ok):
-- BEGIN; SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '30s';
-- INSERT INTO supabase_migrations.schema_migrations(version, name) VALUES ('20260706000100', 'pipeline_runs');
-- COMMIT;
--   Rollback: DELETE FROM supabase_migrations.schema_migrations WHERE version = '20260706000100';
--
-- B2. 20260706000000_news_source_state: its tables (news_source_runs, news_candidate_observations,
--   news_research_results) are absent on prod. Mark it applied so db push never re-creates retired
--   tables. Pre-check:
SELECT to_regclass('public.news_source_runs') IS NULL
   AND to_regclass('public.news_candidate_observations') IS NULL
   AND to_regclass('public.news_research_results') IS NULL
   AND NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260706000000') AS ok;
--   Insert (only if ok):
-- BEGIN; SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '30s';
-- INSERT INTO supabase_migrations.schema_migrations(version, name) VALUES ('20260706000000', 'news_source_state');
-- COMMIT;
--   Rollback: DELETE FROM supabase_migrations.schema_migrations WHERE version = '20260706000000';
--
-- C. Deleted from the repo, no prod change: 20261019190000 (#390, never applied) and
--    20261019220000 (#342; function superseded by 20261019231000, grants/policies not applied).
--    20261019200000 (#378) is untouched and stays unapplied (goes with #484).
