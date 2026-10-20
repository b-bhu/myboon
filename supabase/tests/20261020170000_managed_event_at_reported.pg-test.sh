#!/usr/bin/env bash
# #388: run 20261020170000_managed_event_at_reported + its rollback on a
# THROWAWAY local Postgres 17. Never points at Supabase.
# BEFORE captures the old reader body (strictly earlier migrations only) and
# asserts the documented bug (a scheduled-dated row tops event-desc at the
# future date); the migration applies twice; ordered rows, context.scheduled_at,
# cursor pagination and totalCount are asserted; unchanged orders and the
# rollback/re-apply cycles must be byte-identical.
# Usage: bash supabase/tests/20261020170000_managed_event_at_reported.pg-test.sh
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
TMP=$(mktemp -d /tmp/issue388pg.XXXX); PORT=55388; DB=db388
MIG=20261020170000_managed_event_at_reported.sql
DOWN=20261020170000_managed_event_at_reported.down.sql
E1='11111111-0000-4000-8000-000000000001'
E2='11111111-0000-4000-8000-000000000002'
trap '"$BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
"$BIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
"$BIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses='' -c timezone=UTC -c datestyle=iso" -l "$TMP/log" -w start >/dev/null
"$BIN/createdb" -h "$TMP" -p $PORT -U postgres "$DB"
PSQL=(psql -X -q -h "$TMP" -p $PORT -U postgres -d "$DB" -v ON_ERROR_STOP=1)
READ=(psql -X -q -t -A -h "$TMP" -p $PORT -U postgres -d "$DB" -v ON_ERROR_STOP=1)
M=$REPO/supabase/migrations; T=$REPO/supabase/tests; R=$REPO/supabase/rollbacks; FAILS=0

# Supabase shim (roles/schemas/extensions) for the throwaway cluster; NOT Supabase, NOT prod.
"${PSQL[@]}" <<'SQL' >/dev/null
DO $$ BEGIN
  PERFORM 1;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticator') THEN CREATE ROLE authenticator NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_admin') THEN CREATE ROLE supabase_admin NOLOGIN; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_user::text $$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
SQL

# Every migration STRICTLY before ours, each in one transaction.
for f in $(ls "$M"/*.sql | sort); do
  base=$(basename "$f")
  if [[ ! "$base" < "$MIG" ]]; then break; fi
  "${PSQL[@]}" --single-transaction -f "$f" >/dev/null || { echo "FAIL migrate $base"; exit 1; }
done
echo "migrations: OK"

# Small fixed fixture on two entities. (a) a1 published only; (b) a2 no article
# row, a3 article with NULL published_at/event_at; (c) a4 published 2026-10-08
# 22:00 UTC with event_at 2026-10-29 21:00 UTC (Bitcoin style, scheduled later);
# (d) a5 event_at earlier than published_at; (e) a6 article with all nulls.
# No legacy public.entity_memories rows are seeded; that table has read-only
# triggers since 20261019120000, so any future legacy insert here must be wrapped
# in ALTER TABLE public.entity_memories DISABLE/ENABLE TRIGGER USER.
# The lease identity must match '^progression-v2:[0-9a-f]{64}$'.
"${PSQL[@]}" <<'SQL' >/dev/null || { echo "FAIL seed"; exit 1; }
INSERT INTO managed_knowledge_private.leases VALUES ('progression-v2:'||repeat('a',64),'seed',1,now());
INSERT INTO managed_knowledge_private.entities(id,identity_key,binding,created_operation,name,slug,type,aliases,summary,status,show_in_carousel,metadata,updated_at,revision)
VALUES ('11111111-0000-4000-8000-000000000001','article:issue388-e1','{}'::jsonb,'progression-v2:'||repeat('a',64),'Issue 388 Entity One','issue388-e1','topic','["IE1"]'::jsonb,'entity one summary','active',false,'{}'::jsonb,now(),1),
       ('11111111-0000-4000-8000-000000000002','article:issue388-e2','{}'::jsonb,'progression-v2:'||repeat('a',64),'Issue 388 Entity Two','issue388-e2','topic','["IE2"]'::jsonb,'entity two summary','active',false,'{}'::jsonb,now(),1);
INSERT INTO managed_knowledge_private.sources(work_id,packet_digest,packet,readiness,readiness_digest,source,source_refs,retrieved_evidence,created_at)
SELECT 'work-388-'||g, repeat('a',64),
  jsonb_build_object('packetId','packet-388-'||g,'signalId','signal-388-'||g,
    'sourceSignal',jsonb_build_object('title','Signal 388 '||g,'canonicalUrl','https://example.com/388/'||g)),
  '{}', repeat('b',64), 'news', jsonb_build_array('signal-388-'||g), '[]', now()
FROM generate_series(1,7) g;
INSERT INTO managed_knowledge_private.items(id,note,payload,operation_id,work_id,observed_at,created_at) VALUES
  ('22222222-0000-4000-8000-0000000000a1','Item a1 published only','{}','progression-v2:'||repeat('a',64),'work-388-1','2026-10-10 00:00+00','2026-10-10 00:05+00'),
  ('22222222-0000-4000-8000-0000000000a2','Item a2 no article row','{}','progression-v2:'||repeat('a',64),'work-388-2','2026-10-12 00:00+00','2026-10-12 00:05+00'),
  ('22222222-0000-4000-8000-0000000000a3','Item a3 article all null','{}','progression-v2:'||repeat('a',64),'work-388-3','2026-10-13 00:00+00','2026-10-13 00:05+00'),
  ('22222222-0000-4000-8000-0000000000a4','Item a4 scheduled later','{}','progression-v2:'||repeat('a',64),'work-388-4','2026-10-08 21:30+00','2026-10-08 21:35+00'),
  ('22222222-0000-4000-8000-0000000000a5','Item a5 event earlier','{}','progression-v2:'||repeat('a',64),'work-388-5','2026-10-11 12:00+00','2026-10-11 12:05+00'),
  ('22222222-0000-4000-8000-0000000000a6','Item a6 article all null','{}','progression-v2:'||repeat('a',64),'work-388-6','2026-10-06 00:00+00','2026-10-06 00:05+00'),
  ('22222222-0000-4000-8000-0000000000a7','Item a7 entity two','{}','progression-v2:'||repeat('a',64),'work-388-7','2026-10-09 00:00+00','2026-10-09 00:05+00');
INSERT INTO managed_knowledge_private.item_heads(item_id,revision,status)
SELECT id, 1, 'active' FROM managed_knowledge_private.items;
INSERT INTO managed_knowledge_private.item_sources(item_id,work_id,operation_id)
SELECT id, 'work-388-'||(right(id::text,1))::int, 'progression-v2:'||repeat('a',64) FROM managed_knowledge_private.items;
INSERT INTO managed_knowledge_private.article_items(item_id,title,timeline_summary,body,source_url,captured_text,captured_at,content_hash,captured_text_hash,published_at,event_at,observed_at) VALUES
  ('22222222-0000-4000-8000-0000000000a1','Article a1','Timeline summary a1',repeat('body ',40),'https://example.com/388/1','captured','2026-10-10 06:00+00',repeat('e',32),repeat('f',64),'2026-10-10 05:00+00',NULL,'2026-10-10 00:00+00'),
  ('22222222-0000-4000-8000-0000000000a3','Article a3','Timeline summary a3',repeat('body ',40),'https://example.com/388/3','captured','2026-10-13 06:00+00',repeat('f',32),repeat('e',64),NULL,NULL,'2026-10-13 00:00+00'),
  ('22222222-0000-4000-8000-0000000000a4','Article a4 scheduled earnings','Timeline summary a4',repeat('body ',40),'https://example.com/388/4','captured','2026-10-08 23:00+00',repeat('4',32),repeat('4',64),'2026-10-08 22:00+00','2026-10-29 21:00+00','2026-10-08 21:30+00'),
  ('22222222-0000-4000-8000-0000000000a5','Article a5 dated article','Timeline summary a5',repeat('body ',40),'https://example.com/388/5','captured','2026-10-15 06:00+00',repeat('5',32),repeat('5',64),'2026-10-15 00:00+00','2026-10-14 00:00+00','2026-10-11 12:00+00'),
  ('22222222-0000-4000-8000-0000000000a6','Article a6','Timeline summary a6',repeat('body ',40),'https://example.com/388/6','captured','2026-10-06 06:00+00',repeat('6',32),repeat('6',64),NULL,NULL,'2026-10-06 00:00+00'),
  ('22222222-0000-4000-8000-0000000000a7','Article a7','Timeline summary a7',repeat('body ',40),'https://example.com/388/7','captured','2026-10-09 06:00+00',repeat('7',32),repeat('7',64),'2026-10-09 03:00+00',NULL,'2026-10-09 00:00+00');
INSERT INTO managed_knowledge_private.memberships(item_id,entity_id,role,added_operation,removed_operation,uncertain)
SELECT id, CASE WHEN right(id::text,1) = '7' THEN '11111111-0000-4000-8000-000000000002'::uuid ELSE '11111111-0000-4000-8000-000000000001'::uuid END,
  'primary', 'progression-v2:'||repeat('a',64), NULL, false
FROM managed_knowledge_private.items;
INSERT INTO managed_knowledge_private.evidence(item_id,work_id,claim_id,evidence_id,source_ref,claim,evidence,operation_id) VALUES
  ('22222222-0000-4000-8000-0000000000a4','work-388-4','c-388-4','e-388-4','https://example.com/388/4',jsonb_build_object('claimId','c-388-4'),jsonb_build_object('evidenceId','e-388-4','url','https://example.com/388/4'),'progression-v2:'||repeat('a',64)),
  ('22222222-0000-4000-8000-0000000000a7','work-388-7','c-388-7','e-388-7','https://example.com/388/7',jsonb_build_object('claimId','c-388-7'),jsonb_build_object('evidenceId','e-388-7','url','https://example.com/388/7'),'progression-v2:'||repeat('a',64));
ANALYZE;
SQL
echo "seed: OK"

# Reader cases run as postgres after SET ROLE service_role (like the #336 harness).
mkdir -p "$TMP/cases" "$TMP/asserts"
case_file() { cat > "$TMP/cases/$1.sql"; }
case_file r_event <<SQL
SET ROLE service_role;
SELECT public.read_managed_entity_knowledge_v1('event-desc', '$E1', NULL, NULL, NULL, NULL, NULL, NULL, 101);
SQL
case_file r_event_page1 <<SQL
SET ROLE service_role;
SELECT public.read_managed_entity_knowledge_v1('event-desc', '$E1', NULL, NULL, NULL, NULL, NULL, NULL, 2);
SQL
case_file r_event_page2 <<SQL
SET ROLE service_role;
SELECT public.read_managed_entity_knowledge_v1('event-desc', '$E1', NULL, NULL, NULL, NULL, '2026-10-13T00:00:00+00:00', '22222222-0000-4000-8000-0000000000a3', 2);
SQL
case_file r_event_page3 <<SQL
SET ROLE service_role;
SELECT public.read_managed_entity_knowledge_v1('event-desc', '$E1', NULL, NULL, NULL, NULL, '2026-10-10T05:00:00+00:00', '22222222-0000-4000-8000-0000000000a1', 2);
SQL
case_file r_event_page4 <<SQL
SET ROLE service_role;
SELECT public.read_managed_entity_knowledge_v1('event-desc', '$E1', NULL, NULL, NULL, NULL, '2026-10-06T00:00:00+00:00', '22222222-0000-4000-8000-0000000000a6', 2);
SQL
case_file r_event_e2 <<SQL
SET ROLE service_role;
SELECT public.read_managed_entity_knowledge_v1('event-desc', '$E2', NULL, NULL, NULL, NULL, NULL, NULL, 101);
SQL
case_file r_obs <<SQL
SET ROLE service_role;
SELECT public.read_managed_entity_knowledge_v1('observed-desc', '$E1', NULL, NULL, NULL, NULL, NULL, NULL, 101);
SQL
case_file r_upd <<SQL
SET ROLE service_role;
SELECT public.read_managed_entity_knowledge_v1('updated-asc', '$E1', NULL, NULL, NULL, NULL, NULL, NULL, 101);
SQL
case_file r_ids <<SQL
SET ROLE service_role;
SELECT public.read_managed_entity_knowledge_v1('id-asc', NULL, ARRAY[
  '22222222-0000-4000-8000-0000000000a1'::uuid, '22222222-0000-4000-8000-0000000000a2'::uuid,
  '22222222-0000-4000-8000-0000000000a3'::uuid, '22222222-0000-4000-8000-0000000000a4'::uuid,
  '22222222-0000-4000-8000-0000000000a5'::uuid, '22222222-0000-4000-8000-0000000000a6'::uuid,
  '22222222-0000-4000-8000-0000000000a7'::uuid], NULL, NULL, NULL, NULL, NULL, 101);
SQL

# phase <label>: run every reader case once.
phase() {
  local ph=$1 f name
  for f in "$TMP"/cases/*.sql; do
    name=$(basename "$f" .sql)
    if ! "${READ[@]}" -f "$f" > "$TMP/res.$name.$ph" 2> "$TMP/err.$name.$ph"; then
      echo "FAIL call $name ($ph): $(tail -3 "$TMP/err.$name.$ph" | tr '\n' ' ' | cut -c1-220)"
      FAILS=$((FAILS+1)); continue
    fi
  done
}

# compare <label> <phase> <case>...: case output must equal the base capture word for word.
compare() {
  local base=$1 ph=$2 name
  shift 2
  for name in "$@"; do
    if cmp -s "$TMP/res.$name.$base" "$TMP/res.$name.$ph"; then
      echo "PASS byte-identical $name ($ph)"
    else
      echo "FAIL byte-identical $name ($ph): results differ"
      diff "$TMP/res.$name.$base" "$TMP/res.$name.$ph" 2>&1 | head -4 | sed 's/^/    /' || true
      FAILS=$((FAILS+1))
    fi
  done
}

# assert_file <label> <sql file>: a single SELECT that must print a PASS| row.
assert_file() {
  local label=$1 file=$2 out
  if ! out=$("${READ[@]}" -f "$file" 2>&1); then
    echo "FAIL $label: $(echo "$out" | tail -2 | tr '\n' ' ' | cut -c1-220)"; FAILS=$((FAILS+1)); return
  fi
  if [[ "$out" == PASS* ]]; then echo "PASS $label"; else echo "FAIL $label: $out"; FAILS=$((FAILS+1)); fi
}

run_check_file() {
  local file=$1 label=$2 out
  out=$("${PSQL[@]}" -t -A -F'|' -f "$file")
  echo "$out"
  if echo "$out" | grep -q '|f$'; then echo "FAIL $label"; FAILS=$((FAILS+1)); else echo "PASS $label"; fi
}

# BEFORE assert: the old body lets the scheduled-dated row top event-desc.
cat > "$TMP/asserts/before_bug.sql" <<SQL
SET ROLE service_role;
SELECT CASE WHEN
  (c.v->'rows'->0->>'id') = '22222222-0000-4000-8000-0000000000a4'
  AND (c.v->'rows'->0->>'event_at') = '2026-10-29T21:00:00+00:00'
  AND NOT (c.v->'rows'->0->'context' ?| ARRAY['scheduled_at'])
  AND (c.v->'rows'->1->>'event_at') = '2026-10-14T00:00:00+00:00'
  AND (c.v->>'totalCount') = '6'
  THEN 'PASS|before documents the bug: a4 (scheduled 2026-10-29) tops event-desc, no scheduled_at'
  ELSE 'FAIL|before: expected a4 first at 2026-10-29 without scheduled_at' END
FROM (SELECT public.read_managed_entity_knowledge_v1('event-desc', '$E1', NULL, NULL, NULL, NULL, NULL, NULL, 101) AS v) AS c;
SQL

# AFTER assert: event-desc by reported time, scheduled_at only on a4.
cat > "$TMP/asserts/after_rows.sql" <<SQL
SET ROLE service_role;
WITH c AS (
  SELECT public.read_managed_entity_knowledge_v1('event-desc', '$E1', NULL, NULL, NULL, NULL, NULL, NULL, 101) AS v
), want(pos, id, ea, ctx_event, ctx_sched) AS (VALUES
  (1,'22222222-0000-4000-8000-0000000000a5','2026-10-15T00:00:00+00:00','2026-10-14T00:00:00+00:00',NULL::text),
  (2,'22222222-0000-4000-8000-0000000000a3','2026-10-13T00:00:00+00:00',NULL,NULL),
  (3,'22222222-0000-4000-8000-0000000000a2','2026-10-12T00:00:00+00:00',NULL,NULL),
  (4,'22222222-0000-4000-8000-0000000000a1','2026-10-10T05:00:00+00:00',NULL,NULL),
  (5,'22222222-0000-4000-8000-0000000000a4','2026-10-08T22:00:00+00:00','2026-10-29T21:00:00+00:00','2026-10-29T21:00:00+00:00'),
  (6,'22222222-0000-4000-8000-0000000000a6','2026-10-06T00:00:00+00:00',NULL,NULL)
), got AS (
  SELECT (t.jr)->>'id' AS id, (t.jr)->>'event_at' AS ea,
         (t.jr)->'context'->>'event_at' AS ctx_event, (t.jr)->'context'->>'scheduled_at' AS ctx_sched,
         t.pos
  FROM c, LATERAL pg_catalog.jsonb_array_elements(c.v->'rows') WITH ORDINALITY AS t(jr, pos)
)
SELECT CASE WHEN
  (SELECT count(*) FROM got) = 6
  AND (SELECT count(*) FROM got g JOIN want w USING (id)
       WHERE g.pos = w.pos AND g.ea = w.ea
       AND g.ctx_event IS NOT DISTINCT FROM w.ctx_event
       AND g.ctx_sched IS NOT DISTINCT FROM w.ctx_sched) = 6
  AND (SELECT c.v->>'totalCount') = '6'
  THEN 'PASS|after: event_at = reported time per row, event-desc order, scheduled_at only on a4'
  ELSE 'FAIL|after: rows/event_at/order/scheduled_at mismatch' END
FROM c;
SQL

# AFTER assert: keyset cursor walk (limit 2) covers all rows in order, no dupes/gaps.
cat > "$TMP/asserts/after_cursor.sql" <<SQL
SET ROLE service_role;
WITH p1 AS (SELECT public.read_managed_entity_knowledge_v1('event-desc', '$E1', NULL, NULL, NULL, NULL, NULL, NULL, 2) AS v),
p2 AS (SELECT public.read_managed_entity_knowledge_v1('event-desc', '$E1', NULL, NULL, NULL, NULL, '2026-10-13T00:00:00+00:00', '22222222-0000-4000-8000-0000000000a3', 2) AS v),
p3 AS (SELECT public.read_managed_entity_knowledge_v1('event-desc', '$E1', NULL, NULL, NULL, NULL, '2026-10-10T05:00:00+00:00', '22222222-0000-4000-8000-0000000000a1', 2) AS v),
p4 AS (SELECT public.read_managed_entity_knowledge_v1('event-desc', '$E1', NULL, NULL, NULL, NULL, '2026-10-06T00:00:00+00:00', '22222222-0000-4000-8000-0000000000a6', 2) AS v)
SELECT CASE WHEN
  (SELECT p1.v->'rows'->0->>'id' FROM p1) = '22222222-0000-4000-8000-0000000000a5'
  AND (SELECT p1.v->'rows'->1->>'id' FROM p1) = '22222222-0000-4000-8000-0000000000a3'
  AND (SELECT p2.v->'rows'->0->>'id' FROM p2) = '22222222-0000-4000-8000-0000000000a2'
  AND (SELECT p2.v->'rows'->1->>'id' FROM p2) = '22222222-0000-4000-8000-0000000000a1'
  AND (SELECT p3.v->'rows'->0->>'id' FROM p3) = '22222222-0000-4000-8000-0000000000a4'
  AND (SELECT p3.v->'rows'->1->>'id' FROM p3) = '22222222-0000-4000-8000-0000000000a6'
  AND (SELECT pg_catalog.jsonb_array_length(p4.v->'rows') FROM p4) = 0
  AND (SELECT p4.v->>'totalCount' FROM p4) = '6'
  THEN 'PASS|cursor walk: three pages of two then empty, no dupes/gaps, totalCount 6 on every page'
  ELSE 'FAIL|cursor walk' END;
SQL

echo "== before migration"
phase before
assert_file "before: scheduled-dated row tops event-desc" "$TMP/asserts/before_bug.sql"
total_before=$(grep -oE '"totalCount": *[0-9]*' "$TMP/res.r_event.before" | tr -d ' ' || true)
ids_before=$(grep -oE '"id": *"22222222-0000-4000-8000-0000000000a[0-9]"' "$TMP/res.r_event.before" | sort | uniq || true)
echo "before totalCount token: ${total_before:-none}"

echo "== apply migration twice (idempotent)"
"${PSQL[@]}" --single-transaction -f "$M/$MIG" >/dev/null || { echo "FAIL migration apply"; exit 1; }
"${PSQL[@]}" --single-transaction -f "$M/$MIG" >/dev/null || { echo "FAIL migration apply 2"; exit 1; }
echo "apply twice: OK"
run_check_file "$T/${MIG%.sql}.check.sql" "post-apply check file"

echo "== after migration"
phase after
total_after=$(grep -oE '"totalCount": *[0-9]*' "$TMP/res.r_event.after" | tr -d ' ' || true)
ids_after=$(grep -oE '"id": *"22222222-0000-4000-8000-0000000000a[0-9]"' "$TMP/res.r_event.after" | sort | uniq || true)
if [[ "$total_after" == "$total_before" && -n "$total_after" ]]; then
  echo "PASS unchanged totalCount: $total_after"
else
  echo "FAIL totalCount changed: before [$total_before] after [$total_after]"; FAILS=$((FAILS+1))
fi
if [[ "$ids_after" == "$ids_before" && -n "$ids_after" ]]; then
  echo "PASS row set identical (same ids)"
else
  echo "FAIL row set changed: $(diff <(echo "$ids_before") <(echo "$ids_after") | head -4)"; FAILS=$((FAILS+1))
fi
assert_file "after: rows, order and context" "$TMP/asserts/after_rows.sql"
assert_file "after: cursor walk" "$TMP/asserts/after_cursor.sql"
# r_obs/r_upd/r_ids keep the exact row sequence; the per-row event_at and
# context.scheduled_at of a4/a5 legitimately change in every order's output, so
# byte equality is only claimed where row content cannot change (r_event_e2).
order_ids() { grep -oE '"id": *"22222222-0000-4000-8000-0000000000a[0-9]"' "$1" | tr -d ' '; }
for name in r_obs r_upd r_ids; do
  if [[ "$(order_ids "$TMP/res.$name.before")" == "$(order_ids "$TMP/res.$name.after")" ]]; then
    echo "PASS order identical $name (after)"
  else
    echo "FAIL order identical $name (after): sequence changed"; FAILS=$((FAILS+1))
  fi
done
compare before after r_event_e2

echo "== rollback twice"
"${PSQL[@]}" --single-transaction -f "$R/$DOWN" >/dev/null || { echo "FAIL rollback apply"; exit 1; }
"${PSQL[@]}" --single-transaction -f "$R/$DOWN" >/dev/null || { echo "FAIL rollback apply 2"; exit 1; }
echo "rollback twice: OK"
run_check_file "$T/${MIG%.sql}.rollback.check.sql" "post-rollback check file"
phase rolled
compare before rolled r_event r_event_page1 r_event_page2 r_event_page3 r_event_page4 r_event_e2 r_obs r_upd r_ids

echo "== re-apply migration and re-check"
"${PSQL[@]}" --single-transaction -f "$M/$MIG" >/dev/null || { echo "FAIL migration re-apply"; exit 1; }
"${PSQL[@]}" --single-transaction -f "$M/$MIG" >/dev/null || { echo "FAIL migration re-apply 2"; exit 1; }
run_check_file "$T/${MIG%.sql}.check.sql" "re-apply check file"
phase after2
compare after after2 r_event r_event_page1 r_event_page2 r_event_page3 r_event_page4 r_event_e2 r_obs r_upd r_ids

echo "== FAILS=$FAILS"
exit $((FAILS>0))