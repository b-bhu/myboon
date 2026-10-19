-- Rollback for 20261019210000_managed_entity_fuzzy_candidates.sql (#342 PR-2).
-- Drops the candidate function and the trigram index. pg_trgm itself and the
-- owner's USAGE on schema extensions are left in place (other objects may use
-- them; both are harmless); drop them by hand only if nothing depends on them.
-- No data is touched.
DROP FUNCTION IF EXISTS managed_knowledge_private.fuzzy_entity_candidates_v1(jsonb);
DROP INDEX IF EXISTS managed_knowledge_private.managed_entities_name_key_trgm;
