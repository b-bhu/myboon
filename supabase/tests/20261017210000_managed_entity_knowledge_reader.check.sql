-- Read-only post-migration check for 20261017210000_managed_entity_knowledge_reader.sql (#337 PR-C).
-- Only SELECTs on pg_catalog / information_schema. Every row should be pass = true.
WITH fn AS (
  SELECT p.oid, p.prosecdef, p.provolatile, p.proconfig, p.prorettype, pg_get_userbyid(p.proowner) AS owner
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public' AND p.proname = 'read_managed_entity_knowledge_v1'
)
SELECT check_name, pass FROM (VALUES
  ('01 exactly one public.read_managed_entity_knowledge_v1', 1, (SELECT count(*) = 1 FROM fn)),
  ('02 signature (text,uuid,uuid[],timestamptz,text[],text[],timestamptz,uuid,integer) returns jsonb', 2, EXISTS (SELECT 1 FROM fn
     WHERE fn.oid = to_regprocedure('public.read_managed_entity_knowledge_v1(text,uuid,uuid[],timestamptz,text[],text[],timestamptz,uuid,integer)')
       AND fn.prorettype = 'jsonb'::regtype)),
  ('03 SECURITY DEFINER', 3, EXISTS (SELECT 1 FROM fn WHERE fn.prosecdef)),
  ('04 STABLE (read-only)', 4, EXISTS (SELECT 1 FROM fn WHERE fn.provolatile = 's')),
  ('05 search_path pinned to empty', 5, EXISTS (SELECT 1 FROM fn WHERE fn.proconfig @> ARRAY['search_path=""'])),
  ('06 owned by myboon_knowledge_owner', 6, EXISTS (SELECT 1 FROM fn WHERE fn.owner = 'myboon_knowledge_owner')),
  ('07 owner is NOLOGIN, not superuser, no BYPASSRLS', 7, EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'myboon_knowledge_owner'
     AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls)),
  ('08 service_role can EXECUTE', 8, (SELECT has_function_privilege('service_role', fn.oid, 'EXECUTE') FROM fn)),
  ('09 anon cannot EXECUTE', 9, (SELECT NOT has_function_privilege('anon', fn.oid, 'EXECUTE') FROM fn)),
  ('10 authenticated cannot EXECUTE', 10, (SELECT NOT has_function_privilege('authenticated', fn.oid, 'EXECUTE') FROM fn)),
  ('11 no EXECUTE grant to PUBLIC', 11, NOT EXISTS (SELECT 1 FROM fn, aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid = fn.oid), acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = fn.oid)))) a
     WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')),
  ('12 only owner and service_role hold EXECUTE', 12, NOT EXISTS (SELECT 1 FROM fn, aclexplode((SELECT proacl FROM pg_proc WHERE oid = fn.oid)) a
     WHERE a.privilege_type = 'EXECUTE' AND pg_get_userbyid(a.grantee) NOT IN ('myboon_knowledge_owner','service_role'))),
  ('13 managed_knowledge_private still closed to service_role/anon/authenticated', 13, NOT has_schema_privilege('service_role','managed_knowledge_private','USAGE')
     AND NOT has_schema_privilege('anon','managed_knowledge_private','USAGE') AND NOT has_schema_privilege('authenticated','managed_knowledge_private','USAGE')),
  ('14 owner holds no CREATE on public after migration', 14, NOT has_schema_privilege('myboon_knowledge_owner','public','CREATE')),
  ('15 body never writes', 15, EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = (SELECT oid FROM fn)
     AND p.prosrc !~* '\m(insert|update|delete|truncate|merge)\M'))
) AS c(check_name, ord, pass)
ORDER BY ord;
