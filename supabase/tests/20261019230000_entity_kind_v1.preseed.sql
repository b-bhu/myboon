-- #342 PR-4 A preseed: rows with legacy free-text types, committed BEFORE
-- 20261019230000_entity_kind_v1 applies (the CHECK does not exist yet, so the
-- raw strings insert fine - exactly the state the migration must fix).
-- Only supabase/tests/20261019230000_entity_kind_v1.pg-test.sh runs this.
-- Expected mapping (checked in .check.sql):
--   1a1 project              -> protocol      (legacyType 'project')
--   1a2 conflict             -> event         (legacyType 'conflict')
--   1a3 company              -> organization  (legacyType 'company')
--   1a4 ai coding tool       -> product       (legacyType 'ai coding tool')
--   1a5 exchange-traded fund -> asset         (legacyType 'exchange-traded fund')
--   1a6 trader               -> unclassified  (legacyType 'trader')
--   1a7 organization         -> organization  (unchanged, NO legacyType)
-- 1a1 (survivor) and 1a3 (merged) also form the merge pair used by
-- .behaviour.sql, with item 1b1 holding the merged side's only membership.
INSERT INTO managed_knowledge_private.leases(operation_id,owner,epoch,expires_at)
  VALUES('progression-v2:' || repeat('0',64),'kind-v1-preseed',1,clock_timestamp() + interval '1 hour');
INSERT INTO managed_knowledge_private.sources(work_id,packet_digest,packet,readiness,readiness_digest,source,source_refs,retrieved_evidence)
  VALUES('work-kind-342',repeat('a',64),'{"schemaVersion":"myboon.research_packet.v1","packetId":"p-kind-342"}'::jsonb,
         '{"schemaVersion":"myboon.research_readiness.v1"}'::jsonb,repeat('b',64),'news','[{"ref":"kind-342"}]'::jsonb,'{}'::jsonb);
INSERT INTO managed_knowledge_private.entities(id,identity_key,binding,created_operation,name,slug,type,aliases,status,metadata)
SELECT id::uuid,'preseed342:' || slug,
       jsonb_build_object('id',id,'name',name,'slug',slug,'type',type,'aliases','[]'::jsonb),
       'progression-v2:' || repeat('0',64),name,slug,type,'[]'::jsonb,'active','{}'::jsonb
FROM (VALUES
  ('00000000-0000-4000-8000-0000000001a1','Bound Project','bound-project','project'),
  ('00000000-0000-4000-8000-0000000001a2','Border Conflict','border-conflict','conflict'),
  ('00000000-0000-4000-8000-0000000001a3','Marlow Collective','marlow-collective','company'),
  ('00000000-0000-4000-8000-0000000001a4','Pixel Coder','pixel-coder','ai coding tool'),
  ('00000000-0000-4000-8000-0000000001a5','Global Tech Fund','global-tech-fund','exchange-traded fund'),
  ('00000000-0000-4000-8000-0000000001a6','Whale Trader','whale-trader','trader'),
  ('00000000-0000-4000-8000-0000000001a7','Kestrel Group','kestrel-group','organization')
) AS t(id,name,slug,type);
INSERT INTO managed_knowledge_private.items(id,note,payload,operation_id,work_id,observed_at)
  VALUES('00000000-0000-4000-8000-0000000001b1','preseed merged-only item','{}'::jsonb,
         'progression-v2:' || repeat('0',64),'work-kind-342',now());
INSERT INTO managed_knowledge_private.item_heads(item_id)
  VALUES('00000000-0000-4000-8000-0000000001b1');
INSERT INTO managed_knowledge_private.memberships(item_id,entity_id,role,added_operation,removed_operation)
  VALUES('00000000-0000-4000-8000-0000000001b1','00000000-0000-4000-8000-0000000001a3','primary',
         'progression-v2:' || repeat('0',64),NULL);