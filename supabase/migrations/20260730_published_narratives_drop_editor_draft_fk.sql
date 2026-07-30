-- The entity pipeline rebuild (issue #256) moved editor_drafts off Supabase
-- into the collectors' local pipeline store; the Supabase editor_drafts table
-- no longer receives rows. published_narratives.editor_draft_id still records
-- WHICH draft produced each narrative - the id now points at the local
-- store's draft row and is kept purely as provenance - so the cross-database
-- foreign key can no longer hold. Left in place it blocks EVERY publish:
--   "insert or update on table "published_narratives" violates foreign key
--    constraint "published_narratives_editor_draft_id_fkey""
-- (observed live 2026-07-30, first end-to-end run of the rebuilt pipeline).
alter table published_narratives
  drop constraint if exists published_narratives_editor_draft_id_fkey;
