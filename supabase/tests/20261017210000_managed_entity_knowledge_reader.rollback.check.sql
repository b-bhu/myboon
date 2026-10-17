-- Read-only check after the 20261017210000 rollback (#337 PR-C). Every row should be pass = true.
SELECT check_name, pass FROM (VALUES
  ('01 public.read_managed_entity_knowledge_v1 is gone', 1, NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = 'read_managed_entity_knowledge_v1')),
  ('02 managed_knowledge_private still closed to service_role', 2, NOT has_schema_privilege('service_role','managed_knowledge_private','USAGE'))
) AS c(check_name, ord, pass)
ORDER BY ord;
