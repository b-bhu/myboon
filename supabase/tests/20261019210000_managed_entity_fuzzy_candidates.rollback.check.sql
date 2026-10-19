-- Read-only post-rollback check for 20261019210000_managed_entity_fuzzy_candidates.down.sql (#342 PR-2).
SELECT check_name, pass FROM (VALUES
  ('01 function dropped', 1, to_regprocedure('managed_knowledge_private.fuzzy_entity_candidates_v1(jsonb)') IS NULL),
  ('02 trigram index dropped', 2, NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='managed_knowledge_private' AND indexname='managed_entities_name_key_trgm')),
  ('03 #368 btree name_key index still present', 3, EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='managed_knowledge_private' AND indexname='managed_entities_name_key'))
) AS checks(check_name, ord, pass) ORDER BY ord;
