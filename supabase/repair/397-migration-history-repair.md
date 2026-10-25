# #397 prod migration history repair plan (DRAFT, nothing applied)

Audit: Oct 25, 2026, read-only (`list_migrations`, `information_schema`, `pg_catalog`) against prod.
Repo `main`: 69 migration files (+1 new here). Prod history: 34 rows.

Counts: 16 recorded with the same version, 18 recorded under a different version (same name),
27 unrecorded but effects present or superseded (mark applied), 3 partially applied, 4 not applied
and owned elsewhere (decision), 1 not applied and run here (20260824), 1 new (20261025200000).

## Steps (each needs CTO approval on #397, after a backup; Bucket/DB Guy runs them)

1. Snapshot: `select * from supabase_migrations.schema_migrations` and the grants query below.
2. Re-point the 18 renamed rows to the repo versions (history only, no schema change):
   - `supabase migration repair --status reverted 20260602151211 20260603122419 20260603053807 20260604152337 20260606044250 20260606140326 20260622110309 20260624133832 20260625114141 20260701160531 20260703163836 20260910143705 20261018004252 20261024162849 20261025095010 20261025095024 20261025095034 20261025095043`
   - `supabase migration repair --status applied 20260602 20260603 20260604 20260605 20260606 20260607 20260624 20260625 20260701 20260703 20260729 20261018090000 20261020200000 20261025100000 20261025100100 20261025100200 20261025100300`
3. Record the 27 present/superseded migrations (26 versions; `20260706` covers two files):
   - `supabase migration repair --status applied 20260401 20260402 20260508 20260626 20260706 20260715160100 20260716062349 20260730 20260731 20260802161500 20260803120000 20260826175053 20261011090000 20261015120000 20261016180000 20261017093000 20261017120000 20261017180000 20261017210000 20261019120000 20261019210000 20261019213000 20261019230000 20261019231000 20261020100000 20261020170000`
4. Decisions before push (otherwise `db push --include-all` would run them):
   - 20260710041040 partial: recommend mark applied; its revokes are in 20261025200000, the stats RPC stays absent (API falls back on 404).
   - 20260728 partial: recommend mark applied now and file a follow-up for `entity_memories_check` + the index rebuild (ACCESS EXCLUSIVE on entity_memories).
   - 20261019220000 partial: owner policies missing; ask merge owner (#342) whether to re-run the policy block.
   - 20260714153008 / 20261019180000: #396 decides; recommend mark 20260714153008 applied as superseded.
   - 20261019190000, 20261019200000: still pending their own needs-bucket issues (#390, #378).
5. `supabase db push --dry-run` must list only 20260824122705 and 20261025200000 (plus any decided above).
6. `supabase db push` (both files set lock_timeout 5s / statement_timeout 30s).
7. Verify: grants query shows zero anon/authenticated rows on the 9 tables; updown table exists; /narratives and /stories counts unchanged; security advisor.
8. Correct the stale "NOT APPLIED" headers for the migrations now confirmed present.

Rollback: `supabase/rollbacks/20261025200000_revoke_anon_auth_table_grants.down.sql`,
`supabase/rollbacks/20260824122705_polymarket_updown_reference_prices.down.sql`; history steps
revert with the inverse `migration repair` commands.

Grants query:
```sql
select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type)
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon','authenticated')
group by 1, 2 order by 1, 2;
```

## Mapping

| Migration | Prod state (Oct 25) | Action |
|---|---|---|
| `20260401_add_match_slug` | superseded: x_posts dropped by applied retire_v2_feed_tables | mark applied |
| `20260402_pacific_tracked` | superseded: pacific_tracked dropped by applied retire_v2_feed_tables | mark applied |
| `20260508_ai_explanations` | present, unrecorded | mark applied |
| `20260602_polymarket_markets_data_engineer` | recorded as 20260602151211 | repoint history (revert 20260602151211, apply 20260602) |
| `20260603_polymarket_market_researcher` | recorded as 20260603122419 | repoint history (revert 20260603122419, apply 20260603) |
| `20260603_polymarket_markets_remove_snapshots` | recorded as 20260603053807 | repoint history (revert 20260603053807, apply 20260603) |
| `20260604_polymarket_market_editor` | recorded as 20260604152337 | repoint history (revert 20260604152337, apply 20260604) |
| `20260605_polymarket_market_publisher` | recorded as 20260606044250 | repoint history (revert 20260606044250, apply 20260605) |
| `20260606_retire_v2_feed_tables` | recorded as 20260606140326 | repoint history (revert 20260606140326, apply 20260606) |
| `20260607_polymarket_researcher_optimization` | recorded as 20260622110309 | repoint history (revert 20260622110309, apply 20260607) |
| `20260624_entity_manager_v1` | recorded as 20260624133832 | repoint history (revert 20260624133832, apply 20260624) |
| `20260625_entity_memories_primary_model` | recorded as 20260625114141 | repoint history (revert 20260625114141, apply 20260625) |
| `20260626_hyperliquid_perps_connector_v1` | superseded: tables absent; collector uses local SQLite, no Supabase reader | mark applied |
| `20260701_editor_drafts_v1` | recorded as 20260701160531 | repoint history (revert 20260701160531, apply 20260701) |
| `20260703_publisher_v1_editor_drafts` | recorded as 20260703163836 | repoint history (revert 20260703163836, apply 20260703) |
| `20260706_news_source_state` | superseded: tables dropped by applied 20260818145731 | mark applied |
| `20260706_pipeline_runs` | present, unrecorded | mark applied |
| `20260710041040_internal_entity_browser_security` | PARTIAL: RLS on, but revokes never ran and internal_entity_memory_stats() missing (API tolerates 404). Revokes folded into 20261025200000 | decision |
| `20260714131443_entity_carousel_flag` | recorded (same version) | none |
| `20260714153008_secure_published_narratives` | NOT applied: RLS off on published_narratives; superseded by #396 / 20261019180000 | decision (own issue) |
| `20260715160100_polymarket_catalog_v1` | present, unrecorded | mark applied |
| `20260716062349_polymarket_catalog_dynamic_sports_rules_v2` | present, unrecorded | mark applied |
| `20260728_entity_memories_drop_source_marker` | PARTIAL: memory_type_check rebuilt, but entity_memories_check still present and entity_time_idx still partial | decision |
| `20260729_manual_command_log` | recorded as 20260910143705 | repoint history (revert 20260910143705, apply 20260729) |
| `20260730_published_narratives_drop_editor_draft_fk` | present, unrecorded | mark applied |
| `20260731_entities_tags` | present, unrecorded | mark applied |
| `20260802161500_polymarket_catalog_sports_tags_v3` | present, unrecorded | mark applied |
| `20260803120000_polymarket_featured_limit_for_whole_sports` | present, unrecorded | mark applied |
| `20260817161713_raise_polymarket_featured_limit_to_200` | recorded (same version) | none |
| `20260818145731_drop_retired_pipeline_tables` | recorded (same version) | none |
| `20260824122705_polymarket_updown_reference_prices` | NOT applied: table absent | run |
| `20260826175053_add_entity_memory_identity_key` | present, unrecorded | mark applied |
| `20260920151558_entity_catalog_maintenance` | recorded (same version) | none |
| `20260920161429_entity_catalog_global_lease` | recorded (same version) | none |
| `20260921141231_entity_catalog_automatic_cleanup` | recorded (same version) | none |
| `20260921141414_disable_entity_catalog_automatic_alias_cleanup` | recorded (same version) | none |
| `20260921141544_entity_redirect_single_hop_guard` | recorded (same version) | none |
| `20260921142116_strengthen_entity_catalog_cleanup_boundaries` | recorded (same version) | none |
| `20260921153932_harden_entity_catalog_review_boundaries` | recorded (same version) | none |
| `20261003090000_entity_manager_v4_private_knowledge` | recorded (same version) | none |
| `20261003090001_entity_manager_v4_dedicated_logins` | recorded (same version) | none |
| `20261004103000_entity_manager_article_private_knowledge` | recorded (same version) | none |
| `20261006112717_article_entity_candidate_resolution` | recorded (same version) | none |
| `20261011090000_article_writer_accept_packet_v2` | present, unrecorded | mark applied |
| `20261015120000_token_registry` | present, unrecorded | mark applied |
| `20261016180000_entity_living_state` | present, unrecorded | mark applied |
| `20261017093000_article_uncertain_memberships` | present, unrecorded | mark applied |
| `20261017120000_managed_entity_columns` | present, unrecorded | mark applied |
| `20261017180000_entity_summary_article_refresh` | present, unrecorded | mark applied |
| `20261017210000_managed_entity_knowledge_reader` | present, unrecorded | mark applied |
| `20261018090000_published_entity_managed_ids` | recorded as 20261018004252 | repoint history (revert 20261018004252, apply 20261018090000) |
| `20261019120000_entity_memories_read_only_archive` | present, unrecorded | mark applied |
| `20261019180000_published_narratives_enable_rls` | NOT applied: RLS still off on published_narratives (#396) | decision (own issue) |
| `20261019190000_published_managed_memory_ownership` | NOT applied: managed_owned_memory_ids_v1 absent, guard has old body | decision (own issue) |
| `20261019200000_article_writer_collision_detail` | NOT applied: article_writer_v1 lacks collision detail | decision (own issue) |
| `20261019210000_managed_entity_fuzzy_candidates` | present, unrecorded | mark applied |
| `20261019213000_managed_context_read_costs` | present, unrecorded | mark applied |
| `20261019220000_merge_entities_v1` | PARTIAL: merge_entities_v1 present (231000 body), but its merge_entities_owner_* policies are absent | decision |
| `20261019230000_entity_kind_v1` | present, unrecorded | mark applied |
| `20261019231000_merge_entities_v1_counts` | present, unrecorded | mark applied |
| `20261020100000_published_narratives_feed_idx` | present, unrecorded | mark applied |
| `20261020170000_managed_event_at_reported` | present, unrecorded | mark applied |
| `20261020200000_article_context_v2` | recorded as 20261024162849 | repoint history (revert 20261024162849, apply 20261020200000) |
| `20261025100000_atlas_core` | recorded as 20261025095010 | repoint history (revert 20261025095010, apply 20261025100000) |
| `20261025100100_atlas_queues` | recorded as 20261025095024 | repoint history (revert 20261025095024, apply 20261025100100) |
| `20261025100200_atlas_tool_log` | recorded as 20261025095034 | repoint history (revert 20261025095034, apply 20261025100200) |
| `20261025100300_atlas_shelves_carousel` | recorded as 20261025095043 | repoint history (revert 20261025095043, apply 20261025100300) |
| `20261025114300_waitlist` | recorded (same version) | none |
| `20261025114823_atlas_service_role_read` | recorded (same version) | none |
| `20261025200000_revoke_anon_auth_table_grants` | new (#397) | run |
