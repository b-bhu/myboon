-- Read-only check for 20261020090000_article_context_label_match.sql (#336 item 1, PR B).
-- pg_catalog SELECTs only. Every row must be pass = true.
WITH fn AS (
  SELECT p.oid, p.proname, ns.nspname AS schema, p.prosecdef, p.provolatile, p.proconfig, p.prorettype,
    pg_get_userbyid(p.proowner) AS owner, p.prosrc
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE p.proname IN ('read_managed_entity_knowledge_v1','context_v1','article_context_v1')
    AND ns.nspname IN ('public','managed_knowledge_private')
), reader AS (SELECT * FROM fn WHERE schema='public'), ctx AS (SELECT * FROM fn WHERE schema='managed_knowledge_private' AND proname='context_v1'),
art AS (SELECT * FROM fn WHERE schema='managed_knowledge_private' AND proname='article_context_v1')
SELECT check_name, pass FROM (VALUES
  ('01 three functions exist exactly once each', 1, (SELECT count(*) = 3 FROM fn)),
  ('02 article_context_v1 signature unchanged', 2, (SELECT count(*) = 1 FROM art
     WHERE oid = to_regprocedure('managed_knowledge_private.article_context_v1(jsonb)') AND prorettype = 'jsonb'::regtype)),
  ('03 article_context_v1 SECURITY DEFINER owned by myboon_knowledge_owner with search_path=pg_catalog', 3,
     (SELECT count(*) = 1 FROM art WHERE prosecdef AND owner = 'myboon_knowledge_owner' AND proconfig @> ARRAY['search_path=pg_catalog'])),
  ('04 label matching uses the qualified trigram operator', 4, (SELECT position($x$OPERATOR(extensions.%)$x$ in prosrc) > 0 FROM art)),
  ('05 label matching applies the 0.6 floor on name_key similarity', 5,
     (SELECT position($x$extensions.similarity(p.name_key, l.label_key) >= 0.6$x$ in prosrc) > 0 FROM art)),
  ('06 empty label keys are skipped', 6, (SELECT position($x$l.label_key <> ''$x$ in prosrc) > 0 FROM art)),
  ('07 trigram candidates honour identityOnly', 7,
     (SELECT position($x$NOT coalesce((input->>'identityOnly')::boolean,false) AND l.label_key <> ''$x$ in prosrc) > 0 FROM art)),
  ('08 no substring scans over metadata::text', 8, (SELECT position($x$metadata::text$x$ in prosrc) = 0 FROM art)),
  ('09 no candidate substring scan over managed name/summary', 9,
     (SELECT position($x$position(l.label in lower(p.name)) > 0$x$ in prosrc) = 0
        AND position($x$in lower(coalesce(p.summary,$x$ in prosrc) = 0 FROM art)),
  ('10 public.entities supplementary candidates are exact only', 10,
     (SELECT position($x$position(l.label in lower(e.name)) > 0$x$ in prosrc) = 0
        AND position($x$in lower(coalesce(e.summary,$x$ in prosrc) = 0 FROM art)),
  ('11 articleItems history label matching is unchanged', 11,
     (SELECT position($x$position(l.label in lower(coalesce(a.title,i.note)))>0$x$ in prosrc) > 0
        AND position($x$position(l.label in lower(m.title))>0$x$ in prosrc) > 0 FROM art)),
  ('12 ranking over the deduplicated candidates is unchanged', 12,
     (SELECT position($x$position(l.label in lower(coalesce(value->>'name','')))$x$ in prosrc) > 0 FROM art)),
  ('13 perEntityLimit behaviour unchanged', 13, (SELECT position($x$perEntityLimit$x$ in prosrc) > 0 FROM art)),
  ('14 context_v1 untouched (no trigram operator inside)', 14, (SELECT count(*) = 1 FROM ctx WHERE position($x$OPERATOR(extensions.%)$x$ in prosrc) = 0)),
  ('15 trigram index still present and usable', 15, EXISTS (
     SELECT 1 FROM pg_indexes WHERE schemaname='managed_knowledge_private' AND indexname='managed_entities_name_key_trgm'
       AND indexdef LIKE '%USING gin%' AND indexdef LIKE '%name_key%' AND indexdef LIKE '%gin_trgm_ops%')),
  ('16 definer still may call extensions and entity_name_key_v1', 16,
     has_schema_privilege('myboon_knowledge_owner','extensions','USAGE')
     AND has_function_privilege('myboon_knowledge_owner','managed_knowledge_private.entity_name_key_v1(text)','EXECUTE')),
  ('17 grants unchanged: executor roles execute, anon/authenticated do not, no PUBLIC grant', 17,
     (SELECT has_function_privilege('myboon_knowledge_executor', oid, 'EXECUTE')
        AND has_function_privilege('myboon_knowledge_context_executor', oid, 'EXECUTE')
        AND NOT has_function_privilege('anon', oid, 'EXECUTE')
        AND NOT has_function_privilege('authenticated', oid, 'EXECUTE') FROM art)
     AND NOT EXISTS (SELECT 1 FROM art, aclexplode((SELECT proacl FROM pg_proc WHERE oid = art.oid)) a
       WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')),
  ('18 owner is NOLOGIN, not superuser, no BYPASSRLS', 18, EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'myboon_knowledge_owner'
     AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls)),
  ('19 private schema still closed to service_role/anon/authenticated', 19, NOT has_schema_privilege('service_role','managed_knowledge_private','USAGE')
     AND NOT has_schema_privilege('anon','managed_knowledge_private','USAGE') AND NOT has_schema_privilege('authenticated','managed_knowledge_private','USAGE'))
) AS c(check_name, ord, pass)
ORDER BY ord;