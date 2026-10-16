-- Rollback for 20261016180000_entity_living_state.sql (#341 PR-A).
-- Not applied. Run manually only for rollback, after a backup.
-- entity_revision_v1 is untouched by the forward migration and stays as the
-- write-path pin; writers never moved off it in PR-A, so nothing needs
-- re-pinning. If a later PR has moved writers to entity_revision_v2, revert
-- that code first (back to v1) before running this file.
-- WARNING: drops all living-state data and summary history.
DROP FUNCTION IF EXISTS managed_knowledge_private.entity_summary_claim_due_v1(text,integer,integer);
DROP FUNCTION IF EXISTS managed_knowledge_private.entity_summary_restore_v1(jsonb);
DROP FUNCTION IF EXISTS managed_knowledge_private.entity_summary_refresh_v1(jsonb);
DROP FUNCTION IF EXISTS managed_knowledge_private.entity_revision_v2(uuid);
DROP TABLE IF EXISTS managed_knowledge_private.entity_summary_due;
DROP TABLE IF EXISTS managed_knowledge_private.entity_summary_history;
DROP FUNCTION IF EXISTS managed_knowledge_private.entity_summary_history_append_only();
ALTER TABLE managed_knowledge_private.entities
  DROP COLUMN IF EXISTS summary, DROP COLUMN IF EXISTS current_state, DROP COLUMN IF EXISTS key_timeline,
  DROP COLUMN IF EXISTS open_questions, DROP COLUMN IF EXISTS summary_revision,
  DROP COLUMN IF EXISTS items_since_summary, DROP COLUMN IF EXISTS summary_refreshed_at;
