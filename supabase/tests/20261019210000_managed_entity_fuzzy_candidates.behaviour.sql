-- #342 PR-2 behaviour check. Disposable DB only, as superuser. Seeds managed
-- entities, calls fuzzy_entity_candidates_v1 as the context executor role,
-- prints check|pass rows. Everything is rolled back.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO managed_knowledge_private.leases(operation_id,owner,epoch,expires_at)
  VALUES('progression-v2:' || repeat('0',64),'check-342-seed',1,clock_timestamp() + interval '1 hour');
INSERT INTO managed_knowledge_private.entities(id,identity_key,binding,created_operation,name,slug,type,aliases,status)
SELECT id::uuid, 'article:' || type || ':' || slug, jsonb_build_object('id',id,'name',name,'slug',slug,'aliases','[]'::jsonb),
       'progression-v2:' || repeat('0',64), name, slug, type, '[]'::jsonb, status
FROM (VALUES
  ('00000000-0000-4000-8000-000000000c01','TOKEN2049 Singapore','token2049-singapore','event','review'),
  ('00000000-0000-4000-8000-000000000c02','Ethereum Foundation','ethereum-foundation','organization','active'),
  ('00000000-0000-4000-8000-000000000c03','Ethereum Foundations Archive','ethereum-foundations-archive','organization','archived'),
  ('00000000-0000-4000-8000-000000000c04','BlackRock','blackrock','organization','active')
) AS t(id,name,slug,type,status);
SET LOCAL ROLE myboon_knowledge_context_executor;
CREATE TEMP TABLE r342 AS SELECT k, managed_knowledge_private.fuzzy_entity_candidates_v1(input) AS out FROM (VALUES
  ('near', '{"name":"Token2049 Singapur"}'::jsonb),
  ('exact_key', '{"name":"Token 2049 Singapore"}'::jsonb),
  ('foundation', '{"name":"Ethereum Foundation Inc"}'::jsonb),
  ('far', '{"name":"Solana Breakpoint"}'::jsonb),
  ('floor_clamp', '{"name":"Token2049 Singapur","minSimilarity":0.1}'::jsonb),
  ('high_floor', '{"name":"Token2049 Singapur","minSimilarity":0.99}'::jsonb)
) AS v(k,input);
RESET ROLE;
SELECT k || ' -> ' || out::text FROM r342 ORDER BY k;
SELECT check_name || '|' || pass FROM (VALUES
  ('01 near-miss key returns the review entity (review included)', EXISTS (SELECT 1 FROM r342, jsonb_array_elements(out->'candidates') c WHERE k='near' AND c->>'id'='00000000-0000-4000-8000-000000000c01' AND c->>'status'='review' AND (c->>'similarity')::numeric >= 0.6)),
  ('02 identical name_key is excluded (exact path owns it)', (SELECT jsonb_array_length(out->'candidates')=0 AND out->>'nameKey'<>'' FROM r342 WHERE k='exact_key')),
  ('03 archived entity is excluded', NOT EXISTS (SELECT 1 FROM r342, jsonb_array_elements(out->'candidates') c WHERE c->>'status'='archived')),
  ('04 active near-miss returned with similarity', EXISTS (SELECT 1 FROM r342, jsonb_array_elements(out->'candidates') c WHERE k='foundation' AND c->>'id'='00000000-0000-4000-8000-000000000c02')),
  ('05 unrelated name returns nothing', (SELECT jsonb_array_length(out->'candidates')=0 FROM r342 WHERE k='far')),
  ('06 minSimilarity clamps to >= 0.5', NOT EXISTS (SELECT 1 FROM r342, jsonb_array_elements(out->'candidates') c WHERE k='floor_clamp' AND (c->>'similarity')::numeric < 0.5)),
  ('07 high floor filters', (SELECT jsonb_array_length(out->'candidates')=0 FROM r342 WHERE k='high_floor'))
) AS t(check_name, pass);
DO $neg$ BEGIN
  BEGIN PERFORM managed_knowledge_private.fuzzy_entity_candidates_v1('{"name":""}'); RAISE EXCEPTION 'no error';
  EXCEPTION WHEN SQLSTATE '22023' THEN RAISE NOTICE 'ok'; END;
END $neg$;
SELECT '08 empty name rejected with 22023|t';
SELECT '09 anon cannot execute|' || NOT has_function_privilege('anon','managed_knowledge_private.fuzzy_entity_candidates_v1(jsonb)','EXECUTE');
ROLLBACK;
