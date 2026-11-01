-- #418 test seed for 20261024162849_article_context_v2: runs AFTER
-- supabase/tests/20261019213000_managed_context_read_costs.seed.sql
-- on the throwaway cluster only. Adds on top of that seed:
-- - a managed "tie entity" (id 11111111-0000-4000-8000-0000000021fd) whose items
--   share one sort_at (deliberate timestamp ties across items of one entity),
--   incl. a no-article-items row (observed fallback), null event_at rows
--   (published fallback), a retracted head, an uncertain and a removed membership.
-- - a public "legacy tie entity" (id 00000000-0000-4000-8000-00000000006d) with tied
--   event_at and an event_at IS NULL row (observed fallback), plus a legacy row
--   matched through its body and one through source_ref_id.
-- - the spill dataset: 20 managed "Spill Entity" rows (ids 11111111-0000-4000-8000-
--   000000002329..00000000233c) with 20k items and ~20k history memberships whose
--   wide jsonb history values spill the 20261019213000 window sort at small work_mem.
-- - the no-duplicate-scan corpus: 5,000 legacy filler memories under public
--   entity 76 (id 00000000-0000-4000-8000-00000000004c) with neutral ~6.9kB
--   bodies. No case label matches them, so outputs are unchanged, but they make
--   the v1 join-back's second full scan of entity_memories (which re-evaluates
--   the label position() predicates on body) the measurable cost the v2 check
--   asserts away.
-- No source_refs/canonicalUrl packets for these rows: targeted sourceRefs cases keep
-- hitting the 20261019213000 seed data only, and identityOnly=false label scans
-- cannot accidentally match "Spill Entity" rows.
\set op '''progression-v2:6d40dbd6f569f9242173cfb1741bbd507bda607a01618e0d12b316c720791f73'''
\set opr '''progression-v2:533ed97ce59098a530df15a78947134fc5676ae374c7760f3c28e7d245535a33'''
INSERT INTO managed_knowledge_private.leases VALUES (:op,'seed',1,now());
INSERT INTO managed_knowledge_private.leases VALUES (:opr,'seed',1,now());

-- Managed tie entity + spill entities.
INSERT INTO managed_knowledge_private.entities(id,identity_key,binding,created_operation,name,slug,type,aliases,summary,status,show_in_carousel,metadata,updated_at,revision)
SELECT ('11111111-0000-4000-8000-'||lpad(to_hex(n),12,'0'))::uuid, 'b418:ent-'||n, '{}'::jsonb, :op,
  CASE WHEN n=8701 THEN 'Tie Entity One' ELSE 'Spill Entity '||(n-9000) END,
  CASE WHEN n=8701 THEN 'tie-entity-one' ELSE 'spill-'||(n-9000) END,
  'topic', jsonb_build_array(CASE WHEN n=8701 THEN 'TE1' ELSE 'SP'||(n-9000) END),
  CASE WHEN n=8701 THEN 'Tie entity summary one' ELSE 'Spill summary '||(n-9000) END,
  'active', false,
  CASE WHEN n=8701 THEN '{}'::jsonb
    ELSE (SELECT jsonb_object_agg('k'||k, 'metadata value for spill entity '||(n-9000)||' '||repeat('m',60)) FROM generate_series(1,11) k) END,
  now(), 1
FROM (VALUES (8701),(9001),(9002),(9003),(9004),(9005),(9006),(9007),(9008),(9009),(9010),
  (9011),(9012),(9013),(9014),(9015),(9016),(9017),(9018),(9019),(9020)) v(n);

-- Managed tie cluster: 12 items, one per sort bucket; g%3=0 -> event_at NULL
-- with published_at set (published fallback), g%3=1 -> event_at set,
-- g%3=2 -> both NULL (observed fallback); all three land on the same instant.
INSERT INTO managed_knowledge_private.sources(work_id,packet_digest,packet,readiness,readiness_digest,source,source_refs,retrieved_evidence,created_at)
SELECT 'tie-work-'||g, repeat('c',64), jsonb_build_object('packetId','tie-packet-'||g,'signalId','tie-signal-'||g),
  '{}', repeat('d',64), 'news', jsonb_build_array('tie-signal-'||g), '[]', now()
FROM generate_series(1,12) g;
INSERT INTO managed_knowledge_private.items(id,note,payload,operation_id,work_id,observed_at,created_at)
SELECT ('44444444-0000-4000-8000-'||lpad(to_hex(g),12,'0'))::uuid, 'Tie note '||g, '{}', :op, 'tie-work-'||g,
  now()-interval '123 minutes', now()-interval '123 minutes'
FROM generate_series(1,12) g;
INSERT INTO managed_knowledge_private.item_heads(item_id,revision,status)
SELECT ('44444444-0000-4000-8000-'||lpad(to_hex(g),12,'0'))::uuid, 7, CASE WHEN g=10 THEN 'retracted' ELSE 'active' END
FROM generate_series(1,12) g;
INSERT INTO managed_knowledge_private.article_items(item_id,title,timeline_summary,body,source_url,captured_text,captured_at,content_hash,captured_text_hash,published_at,event_at,observed_at)
SELECT ('44444444-0000-4000-8000-'||lpad(to_hex(g),12,'0'))::uuid, 'Tie article '||g, 'Tie summary '||g, 'tie body '||g,
  'https://example.com/tie/'||g, 'tie', now(), repeat('e',32), repeat('f',64),
  CASE WHEN g%3=0 THEN now()-interval '123 minutes' END,
  CASE WHEN g%3=1 THEN now()-interval '123 minutes' END,
  now()-interval '123 minutes'
FROM generate_series(1,8) g;
INSERT INTO managed_knowledge_private.memberships(item_id,entity_id,role,added_operation,removed_operation,uncertain)
SELECT ('44444444-0000-4000-8000-'||lpad(to_hex(g),12,'0'))::uuid, ('11111111-0000-4000-8000-'||lpad(to_hex(8701),12,'0'))::uuid,
  'primary', :op, CASE WHEN g=12 THEN :opr END, g=11
FROM generate_series(1,12) g;

-- Spill dataset: 20k items across the 20 Spill Entities, ~18k with article_items.
INSERT INTO managed_knowledge_private.sources(work_id,packet_digest,packet,readiness,readiness_digest,source,source_refs,retrieved_evidence,created_at)
SELECT 'spill-work-'||g, repeat('a',64), jsonb_build_object('packetId','spill-packet-'||g,'signalId','spill-signal-'||g),
  '{}', repeat('b',64), 'news', '[]'::jsonb, '[]', now()-((g%997)+1)*interval '5 minutes'
FROM generate_series(1,20000) g;
INSERT INTO managed_knowledge_private.items(id,note,payload,operation_id,work_id,observed_at,created_at)
SELECT ('33333333-0000-4000-8000-'||lpad(to_hex(g),12,'0'))::uuid, 'Spill note '||g, '{}', :op, 'spill-work-'||g,
  now()-((g%997)+1)*interval '7 minutes', now()-((g%997)+1)*interval '7 minutes'
FROM generate_series(1,20000) g;
INSERT INTO managed_knowledge_private.item_heads(item_id,revision,status)
SELECT ('33333333-0000-4000-8000-'||lpad(to_hex(g),12,'0'))::uuid, 1, 'active' FROM generate_series(1,20000) g;
INSERT INTO managed_knowledge_private.article_items(item_id,title,timeline_summary,body,source_url,captured_text,captured_at,content_hash,captured_text_hash,published_at,event_at,observed_at)
SELECT ('33333333-0000-4000-8000-'||lpad(to_hex(g),12,'0'))::uuid, 'Spill article '||g, 'Spill summary '||g||' '||repeat('s',20),
  repeat('spill body ',20), 'https://example.com/spill/'||g, 'spill', now(), repeat('e',32), repeat('f',64),
  now()-((g%997)+1)*interval '1 minute', now()-((g%997)+1)*interval '3 minutes', now()-((g%997)+1)*interval '7 minutes'
FROM generate_series(1,20000) g WHERE g%10 <> 0;
INSERT INTO managed_knowledge_private.memberships(item_id,entity_id,role,added_operation,removed_operation,uncertain)
SELECT ('33333333-0000-4000-8000-'||lpad(to_hex(g),12,'0'))::uuid,
  ('11111111-0000-4000-8000-'||lpad(to_hex(9001+(g%20)),12,'0'))::uuid, 'primary', :op, NULL, g%9971=0
FROM generate_series(1,20000) g;

-- Legacy rows: fixed ids, one body-matched on the existing public entity 76
-- (id 00000000-0000-4000-8000-00000000004c), a tied cluster plus an
-- event_at-is-null row on the legacy tie entity (id ...006d).
ALTER TABLE public.entity_memories DISABLE TRIGGER USER;
SET session_replication_role = replica;
INSERT INTO public.entity_memories(id,entity_id,source,source_area,source_type,source_ref_id,source_research_id,memory_type,title,summary,body,event_at,observed_at,created_at,updated_at,memory_identity_key,context)
SELECT ('55555555-0000-4000-8000-'||lpad(to_hex(n),12,'0'))::uuid,
  CASE WHEN n=301 THEN ('00000000-0000-4000-8000-'||lpad(to_hex(76),12,'0'))::uuid
       ELSE ('00000000-0000-4000-8000-'||lpad(to_hex(109),12,'0'))::uuid END,
  'news','feed','article','ref-'||n,'res-'||n,'news_event',
  CASE WHEN n=301 THEN 'Body memory marker 418 headline' ELSE 'Legacy tie memory '||n END,
  CASE WHEN n=301 THEN 'Body memory marker 418 summary'
       WHEN n=206 THEN 'Legacy null event memory' ELSE 'Legacy tie summary '||n END,
  CASE WHEN n=301 THEN 'legacy body marker 418 '||n ELSE 'legacy tie body '||n END,
  CASE WHEN n=206 THEN NULL
       WHEN n<=205 THEN now()-interval '10 minutes'
       ELSE now()-((n-200)+10)*interval '11 minutes' END,
  now()-interval '10 minutes', now()-interval '10 minutes', now()-interval '10 minutes',
  'myboon.memory_identity.v1:'||encode(extensions.digest('b418-'||n::text,'sha256'),'hex'),
  jsonb_build_object('url','https://example.com/b418/'||n)
FROM (VALUES (201),(202),(203),(204),(205),(206),(301)) v(n);

-- No-duplicate-scan corpus: 5k filler memories on entity 76, neutral bodies
-- that no case label matches. Ids 0x3e9..0x1770 never collide with the rows
-- above (0xc9..0x12d).
INSERT INTO public.entity_memories(id,entity_id,source,source_area,source_type,source_ref_id,source_research_id,memory_type,title,summary,body,event_at,observed_at,created_at,updated_at,memory_identity_key,context)
SELECT ('55555555-0000-4000-8000-'||lpad(to_hex(1000+n),12,'0'))::uuid,
  ('00000000-0000-4000-8000-'||lpad(to_hex(76),12,'0'))::uuid,
  'news','feed','article','filler-ref-'||n,'filler-res-'||n,'news_event',
  'Filler memory 418 '||n, 'filler summary 418 '||n,
  'filler body 418 '||n||' '||repeat('x',6800),
  now()-((n%240)+1)*interval '3 minutes', now()-interval '5 minutes',
  now()-interval '5 minutes', now()-interval '5 minutes',
  'myboon.memory_identity.v1:'||encode(extensions.digest('b418fill-'||n::text,'sha256'),'hex'),
  jsonb_build_object('url','https://example.com/b418fill/'||n)
FROM generate_series(1,5000) n;
SET session_replication_role = origin;
ALTER TABLE public.entity_memories ENABLE TRIGGER USER;
ANALYZE;