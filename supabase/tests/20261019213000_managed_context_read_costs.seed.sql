-- Synthetic data at prod scale (Oct 19 read-only counts). Throwaway DB only.
\set op '''progression-v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'''
INSERT INTO managed_knowledge_private.leases VALUES (:op,'seed',1,now());
INSERT INTO public.entities(id,slug,name,type,aliases,summary,status,metadata,created_at,updated_at,show_in_carousel)
SELECT ('00000000-0000-4000-8000-'||lpad(to_hex(g),12,'0'))::uuid, 'pub-'||g, 'Public Entity '||g, 'topic',
  jsonb_build_array('PE'||g,'pub alias '||g), left(repeat('public summary '||g||' ',8),84),
  CASE WHEN g%180=0 THEN 'merged' ELSE 'active' END,
  (SELECT jsonb_object_agg('key_'||k, CASE WHEN k%4=0 THEN jsonb_build_object('a',k,'b','nested value '||g,'c',jsonb_build_array(1,2,3)) ELSE to_jsonb('value '||g||' '||repeat('x',30)) END) FROM generate_series(1,23) k),
  now()-g*interval '1 minute', now()-g*interval '1 minute', g%50=0
FROM generate_series(1,1653) g;
INSERT INTO managed_knowledge_private.entities(id,identity_key,binding,created_operation,name,slug,type,aliases,summary,status,show_in_carousel,metadata,updated_at,revision)
SELECT ('11111111-0000-4000-8000-'||lpad(to_hex(g),12,'0'))::uuid, 'article:ent-'||g, '{}'::jsonb, :op,
  'Managed Entity '||g, 'managed-'||g, 'topic', jsonb_build_array('ME'||g), left(repeat('managed summary '||g||' ',20),236),
  'active', false,
  (SELECT jsonb_object_agg('k'||k, CASE WHEN k%3=0 THEN jsonb_build_object('x',k,'y','nested '||g,'z',jsonb_build_array('a','b')) ELSE to_jsonb('val '||g||' '||repeat('y',25)) END) FROM generate_series(1,11) k),
  now(), 1
FROM generate_series(1,1107) g;
INSERT INTO managed_knowledge_private.sources(work_id,packet_digest,packet,readiness,readiness_digest,source,source_refs,retrieved_evidence,created_at)
SELECT 'work-'||g, repeat('a',64),
  jsonb_build_object('packetId','packet-'||g,'signalId','signal-'||g,'sourceSignal',jsonb_build_object('title','Signal title '||g,'canonicalUrl','https://example.com/a/'||g),
    'article',jsonb_build_object('sourceUrl','https://example.com/a/'||g,'body',repeat('packet body text ',150))),
  '{}', repeat('b',64), CASE WHEN g%10=0 THEN 'polymarket' ELSE 'news' END, jsonb_build_array('signal-'||g), '[]', now()-g*interval '5 minutes'
FROM generate_series(1,3142) g;
INSERT INTO managed_knowledge_private.items(id,note,payload,operation_id,work_id,observed_at,created_at)
SELECT ('22222222-0000-4000-8000-'||lpad(to_hex(g),12,'0'))::uuid, 'Item note '||g||' '||repeat('note text ',20), '{}', :op, 'work-'||g,
  now()-g*interval '7 minutes', now()-g*interval '7 minutes'+interval '1 minute'
FROM generate_series(1,2409) g;
INSERT INTO managed_knowledge_private.item_heads(item_id,revision,status)
SELECT id, 1, CASE WHEN right(id::text,2)='0f' THEN 'retracted' ELSE 'active' END FROM managed_knowledge_private.items;
INSERT INTO managed_knowledge_private.item_sources(item_id,work_id,operation_id)
SELECT ('22222222-0000-4000-8000-'||lpad(to_hex(g),12,'0'))::uuid, 'work-'||g, :op FROM generate_series(1,2409) g
UNION ALL SELECT ('22222222-0000-4000-8000-'||lpad(to_hex(g),12,'0'))::uuid, 'work-'||(g+2409), :op FROM generate_series(1,427) g;
INSERT INTO managed_knowledge_private.article_items(item_id,title,timeline_summary,body,source_url,captured_text,captured_at,content_hash,captured_text_hash,published_at,event_at,observed_at)
SELECT ('22222222-0000-4000-8000-'||lpad(to_hex(g),12,'0'))::uuid, 'Article title '||g, 'Timeline summary '||g||' '||repeat('summary ',20), repeat('article body ',100),
  'https://example.com/a/'||g, 'captured', now(), repeat('e',32), repeat('f',64), now()-g*interval '8 minutes', CASE WHEN g%3=0 THEN now()-g*interval '9 minutes' END, now()-g*interval '7 minutes'
FROM generate_series(1,2290) g;
-- Skewed memberships: 20% of items land on 10 hot entities, the rest spread out.
INSERT INTO managed_knowledge_private.memberships(item_id,entity_id,role,added_operation,removed_operation,uncertain)
SELECT ('22222222-0000-4000-8000-'||lpad(to_hex(g),12,'0'))::uuid,
  ('11111111-0000-4000-8000-'||lpad(to_hex(CASE WHEN g%5=0 THEN 1+g%10 ELSE 1+(g*7)%1107 END),12,'0'))::uuid, 'primary', :op, NULL, g%97=0
FROM generate_series(1,2409) g;
INSERT INTO managed_knowledge_private.memberships(item_id,entity_id,role,added_operation,removed_operation,uncertain)
SELECT ('22222222-0000-4000-8000-'||lpad(to_hex(g),12,'0'))::uuid,
  ('11111111-0000-4000-8000-'||lpad(to_hex(1+(g*13+500)%1107),12,'0'))::uuid, 'related', :op, NULL, false
FROM generate_series(1,2132) g
ON CONFLICT DO NOTHING;
INSERT INTO managed_knowledge_private.evidence(item_id,work_id,claim_id,evidence_id,source_ref,claim,evidence,operation_id)
SELECT ('22222222-0000-4000-8000-'||lpad(to_hex(g),12,'0'))::uuid, 'work-'||g, 'c'||g, 'e'||g, 'https://example.com/a/'||g, jsonb_build_object('claimId','c'||g), jsonb_build_object('evidenceId','e'||g,'url','https://example.com/a/'||g), :op
FROM generate_series(1,478) g;
INSERT INTO managed_knowledge_private.history(operation_id,work_id,item_id,event_kind,payload)
SELECT :op, 'work-'||g, NULL, 'seed', '{}' FROM generate_series(1,3015) g;
SET session_replication_role = replica;
INSERT INTO public.entity_memories(id,entity_id,source,source_area,source_type,source_ref_id,source_research_id,memory_type,title,summary,body,event_at,observed_at,created_at,updated_at,memory_identity_key,context)
SELECT gen_random_uuid(), ('00000000-0000-4000-8000-'||lpad(to_hex(CASE WHEN (1+(g%1636))%180=0 THEN 2+(g%1636) ELSE 1+(g%1636) END),12,'0'))::uuid, 'news','feed','article','ref-'||g,'res-'||g,'news_event',
  left('Legacy memory title '||g||' '||repeat('t',40),58), left(repeat('legacy summary '||g||' ',20),233), left(repeat('b',50),50),
  now()-g*interval '1 minute', now()-g*interval '1 minute', now()-g*interval '1 minute', now()-g*interval '1 minute', 'myboon.memory_identity.v1:'||encode(extensions.digest('m'||g,'sha256'),'hex'), jsonb_build_object('url','https://example.com/l/'||g)
FROM generate_series(1,47598) g;
SET session_replication_role = origin;
ANALYZE;
