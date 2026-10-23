-- #336 item 1 (PR B): writer-scale seed for article_writer_v1 measurement.
-- THROWAWAY CLUSTER ONLY. Adds the operation-row scale article_writer_v1 sees
-- in production (~5.9k accepted operations): leases, plans with realistic
-- plan/snapshot JSON, receipts and planning contexts. Work ids reused from the
-- 20261019213000 prod-scale seed so the receipts FK settles. Part of the
-- measurement harness in 20261020091000_article_writer_latency.inputs.sql;
-- the latency patch itself was STOPPED after measurement (see its commit).
\set op_seed '''progression-v2:'' || lpad(to_hex(g), 64, ''0'')'
INSERT INTO managed_knowledge_private.leases(operation_id,owner,epoch,expires_at)
SELECT :op_seed, 'seed-336-writer', 1, now() + interval '6 hours' FROM generate_series(1,5924) g
ON CONFLICT DO NOTHING;
INSERT INTO managed_knowledge_private.plans(operation_id,revision,attempt_digest,plan_digest,plan,effects,snapshot)
SELECT :op_seed, 1, repeat('a',64), repeat('b',64),
  jsonb_build_object(
    'schemaVersion','myboon.article_progression_plan.v1',
    'operationId',:op_seed,
    'workId','work-' || (((g - 1) % 3142) + 1),
    'contextDigest',repeat('c',64),
    'targetRevisions','{}'::jsonb,
    'effect',jsonb_build_object('kind','article_source_attachment','article',
      jsonb_build_object('sourceUrl','https://example.com/a/' || (((g - 1) % 3142) + 1),
        'title','Seeded writer plan ' || g,'timelineSummary',repeat('summary ',120))),
    'memberships','[]'::jsonb),
  jsonb_build_array(jsonb_build_object('kind','article_source_attachment','seed',repeat('e',200))),
  jsonb_build_object('revision',1,'planDigest',repeat('b',64),'savedAt',clock_timestamp(),
    'owner','seed-336-writer','ownerEpoch',1,'snapshotPadding',repeat('s',600))
FROM generate_series(1,5924) g
ON CONFLICT DO NOTHING;
INSERT INTO managed_knowledge_private.receipts(operation_id,work_id,plan_revision,plan_digest,content_digest,receipt)
SELECT :op_seed, 'work-' || (((g - 1) % 3142) + 1), 1, repeat('b',64), repeat('d',64),
  jsonb_build_object('schemaVersion','myboon.knowledge_operation_receipt.v2','status','accepted',
    'operationId',:op_seed,'contentDigest',repeat('d',64))
FROM generate_series(1,5924) g
ON CONFLICT DO NOTHING;
INSERT INTO managed_knowledge_private.planning_contexts(work_id,context_digest,watermark,entities,item_revisions,snapshot)
SELECT 'work-' || (((g - 1) % 3142) + 1), repeat('f',64), 1, '[]'::jsonb, '{}'::jsonb,
  jsonb_build_object('seeded',true,'padding',repeat('p',200))
FROM generate_series(1,3142) g
ON CONFLICT DO NOTHING;
ANALYZE managed_knowledge_private.plans;
ANALYZE managed_knowledge_private.receipts;
ANALYZE managed_knowledge_private.leases;
ANALYZE managed_knowledge_private.planning_contexts;