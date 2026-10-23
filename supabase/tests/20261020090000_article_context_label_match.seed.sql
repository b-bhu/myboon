-- #336 item 1 (PR B): purpose-built rows for the label-match pg-test. Runs on
-- top of 20261019213000_managed_context_read_costs.seed.sql (prod-scale) in
-- the THROWAWAY cluster only. Own lease, so the file is self-contained.
\set op '''progression-v2:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'''
INSERT INTO managed_knowledge_private.leases(operation_id,owner,epoch,expires_at) VALUES (:op,'seed-336-prb',1,now()+interval '6 hours');
-- Distinct names so the trigram labels below cannot accidentally match the
-- synthetic 'Managed Entity N' rows. 'Jupiter Exchang' must trigram-hit
-- Jupiter Exchange (similarity 0.824 on name_key) and nothing else seeded;
-- 'jup' (0.176) and the summary/metadata-only strings (0.0) must hit nothing.
INSERT INTO managed_knowledge_private.entities(id,identity_key,binding,created_operation,name,slug,type,aliases,summary,status,show_in_carousel,metadata,updated_at,revision)
VALUES
  ('55555555-0000-4000-8000-000000000001','article:entity-jupe','{}'::jsonb,:op,'Jupiter Exchange','jupiter-exchange','asset',
    jsonb_build_array('JEX'),'aggregation layer and perps on Solana','active',false,'{}'::jsonb,now(),1),
  ('55555555-0000-4000-8000-000000000002','article:entity-krypton','{}'::jsonb,:op,'Krypton Ventures','krypton-ventures','asset',
    '[]'::jsonb,'quantum harvesting update and outlook','active',false,
    jsonb_build_object('fund_code','quantum-harv-fund'),now(),1);
-- A legacy public entity whose summary carries the same narrative-only label.
INSERT INTO public.entities(id,slug,name,type,aliases,summary,status,metadata,created_at,updated_at,show_in_carousel)
VALUES ('55555555-0000-4000-8000-000000000101','meridian-labs','Meridian Labs','company','[]'::jsonb,
  'quantum harvesting research notes','active','{}'::jsonb,now(),now(),false);
ANALYZE;