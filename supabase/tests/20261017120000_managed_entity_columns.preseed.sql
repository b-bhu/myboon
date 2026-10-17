-- #337 PR-A preseed for 20261017120000_managed_entity_columns.sql.
-- Run BEFORE the migration against a disposable database that already has
-- every earlier migration applied, as a superuser. It COMMITS: a linked
-- managed entity (catalog identity) and an article-only managed entity, both
-- with stale/incomplete values the migration must overwrite properly.
-- Fixed UUIDs:
--   catalogue Ethereum      00000000-0000-4000-8000-000000000337
--   linked managed row      00000000-0000-4000-8000-00000000e337
--   article-only managed     00000000-0000-4000-8000-00000000a337
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO managed_knowledge_private.leases(operation_id,owner,epoch,expires_at)
  VALUES('progression-v2:' || repeat('b',64),'preseed-337',1,clock_timestamp() + interval '1 hour');
INSERT INTO public.entities(id,slug,name,type,aliases,summary,status,show_in_carousel,metadata)
  VALUES('00000000-0000-4000-8000-000000000337','ethereum-337','Ethereum','network','["ETH"]'::jsonb,'catalog summary','active',true,
    '{"imageUrl":"https://example.test/eth.png"}'::jsonb);
INSERT INTO managed_knowledge_private.entities(id,identity_key,catalog_entity_id,binding,created_operation) VALUES
  ('00000000-0000-4000-8000-00000000e337','catalog:00000000-0000-4000-8000-000000000337','00000000-0000-4000-8000-000000000337',
    '{"id":"00000000-0000-4000-8000-00000000e337","name":"Ethereum (stale)","summary":"stale"}'::jsonb,'progression-v2:' || repeat('b',64)),
  ('00000000-0000-4000-8000-00000000a337','article:topic:preseed 337',NULL,
    '{"id":"00000000-0000-4000-8000-00000000a337","name":"Preseed 337 (P337)","slug":"preseed-337","type":"topic","aliases":["P337"],"summary":"binding summary","status":"active","show_in_carousel":false,"metadata":{"articleCreated":true}}'::jsonb,
    'progression-v2:' || repeat('b',64));
COMMIT;