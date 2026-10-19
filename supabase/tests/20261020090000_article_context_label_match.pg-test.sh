#!/usr/bin/env bash
# #336 item 1 (PR B): run 20261020090000_article_context_label_match + its rollback
# on a THROWAWAY local Postgres 17. Never points at Supabase, never runs
# `supabase db push`. Applies every migration up to and including
# 20261019213000 (the prerequisite pair), seeds the 20261019213000 prod-scale
# data plus patch-specific rows, measures a 12-label call before/after, runs
# the label-match behaviour checks, then the down file and its checks.
# Usage: bash supabase/tests/20261020090000_article_context_label_match.pg-test.sh
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
TMP=$(mktemp -d /tmp/issue336prb.XXXX); PORT=${PG_TEST_PORT:-55450}; DB=db336b
MIG=20261020090000_article_context_label_match.sql
PREV=20261019213000_managed_context_read_costs.sql
DOWN=20261020090000_article_context_label_match.down.sql
trap '"$BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
"$BIN/initdb" -D "$TMP/data" -U postgres -A trust --nosync >/dev/null
"$BIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null
"$BIN/createdb" -h "$TMP" -p $PORT -U postgres "$DB"
PSQL=(psql -X -q -h "$TMP" -p $PORT -U postgres -d "$DB" -v ON_ERROR_STOP=1)
M=$REPO/supabase/migrations; T=$REPO/supabase/tests; FAILS=0

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

# Every migration up to and including the PR A prerequisite (20261019213000),
# each in one transaction. 20261019210000 brings pg_trgm + the trigram index.
for f in $(ls "$M"/*.sql | sort); do
  base=$(basename "$f")
  if [[ "$base" > "$PREV" ]]; then break; fi
  "${PSQL[@]}" --single-transaction -f "$f" >/dev/null 2>"$TMP/m.err" || { cat "$TMP/m.err"; echo "FAIL migrate $base"; exit 1; }
done
echo "migrations up to $PREV: OK"

"${PSQL[@]}" -f "$T/20261019213000_managed_context_read_costs.seed.sql" >/dev/null 2>"$TMP/s1.err" || { cat "$TMP/s1.err"; echo "FAIL prod-scale seed"; exit 1; }
"${PSQL[@]}" -f "$T/${MIG%.sql}.seed.sql" >/dev/null 2>"$TMP/s2.err" || { cat "$TMP/s2.err"; echo "FAIL patch seed"; exit 1; }
echo "seed: OK"
"${PSQL[@]}" -c "CREATE ROLE ctx_fixture LOGIN; GRANT myboon_knowledge_context_executor TO ctx_fixture;" >/dev/null

CTX=(psql -X -q -t -A -h "$TMP" -p $PORT -U ctx_fixture -d "$DB" -v ON_ERROR_STOP=1)
READ=(psql -X -q -t -A -h "$TMP" -p $PORT -U postgres -d "$DB" -v ON_ERROR_STOP=1)

LBL12='"labels":["managed entity 1","managed entity 2","managed entity 3","managed entity 4","managed entity 5","managed entity 6","managed entity 7","managed entity 8","managed entity 9","managed entity 10","managed entity 11","managed entity 12"]'
# Fixed call set. r_* run as postgres after SET ROLE service_role; c_* run as
# the ctx_fixture login (they reject superusers). Changing cases are excluded
# from the byte-identity compare: c_tri (substring/trigram behaviour differs
# by design) and c12 (timing only).
mkdir -p "$TMP/cases"
cat > "$TMP/cases/c_probe.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":[],"labels":["__myboon_database_availability_probe__"],"entityIds":[],"itemIds":[],"identityOnly":true,"limit":1,"historyMode":"targeted"}'::jsonb);
SQL
cat > "$TMP/cases/c_exact.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":[],"labels":["managed-3","me3","managed entity 7"],"entityIds":[],"itemIds":[],"identityOnly":true,"limit":16,"historyMode":"targeted"}'::jsonb);
SQL
cat > "$TMP/cases/c_ctx.sql" <<'SQL'
SELECT managed_knowledge_private.context_v1('{"source":"news","sourceRefs":["signal-100","signal-200"],"labels":["managed entity 5"],"entityIds":[],"itemIds":[],"limit":24}'::jsonb);
SQL
cat > "$TMP/cases/c_hist.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":[],"labels":[],"entityIds":["11111111-0000-4000-8000-000000000001"],"itemIds":[],"identityOnly":false,"limit":5,"historyMode":"recent"}'::jsonb);
SQL
cat > "$TMP/cases/c_hist2.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":[],"labels":["Krypton Ventures"],"entityIds":[],"itemIds":[],"identityOnly":false,"limit":16,"historyMode":"targeted"}'::jsonb);
SQL
cat > "$TMP/cases/c_tri.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":[],"labels":["Jupiter Exchang","jup","quantum harvesting","quantum-harv-fund"],"entityIds":[],"itemIds":[],"identityOnly":false,"limit":24,"historyMode":"targeted"}'::jsonb);
SQL
cat > "$TMP/cases/c12.sql" <<SQL
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":[],$LBL12,"entityIds":[],"itemIds":[],"identityOnly":false,"limit":24,"historyMode":"targeted"}'::jsonb);
SQL

# phase <label> <names...>: run the named cases once, strip the "Time:" lines
# for the byte-identical diff, print per-case timings.
phase() {
  local ph=$1 name
  shift
  for name in "$@"; do
    local f="$TMP/cases/$name.sql"
    if ! "${CTX[@]}" -c '\timing on' -f "$f" > "$TMP/out.$name.$ph" 2> "$TMP/err.$name.$ph"; then
      echo "FAIL call $name ($ph): $(grep -v '^SET$' "$TMP/err.$name.$ph" | tail -3 | tr '\n' ' ' | cut -c1-220)"
      FAILS=$((FAILS+1)); continue
    fi
    grep -v '^Time: ' "$TMP/out.$name.$ph" > "$TMP/res.$name.$ph" || true
    echo "$ph $name: $(grep '^Time: ' "$TMP/out.$name.$ph" | tr '\n' ' ')"
  done
}
ALL_CASES=(c_probe c_exact c_ctx c_hist c_hist2 c_tri c12)
SAME_CASES=(c_probe c_exact c_ctx c_hist c_hist2)

# compare <label> <names...>: each named case result must equal the
# before-migration result byte for byte.
compare() {
  local ph=$1 name
  shift
  for name in "$@"; do
    if [[ -s "$TMP/res.$name.before" ]] && cmp -s "$TMP/res.$name.before" "$TMP/res.$name.$ph"; then
      echo "PASS byte-identical $name ($ph)"
    else
      echo "FAIL byte-identical $name ($ph): results differ or empty"
      diff "$TMP/res.$name.before" "$TMP/res.$name.$ph" 2>&1 | head -4 | sed 's/^/    /' || true
      FAILS=$((FAILS+1))
    fi
  done
}

run_check_file() {
  local file=$1 label=$2 out
  if ! out=$("${PSQL[@]}" -t -A -F'|' -f "$file" 2>&1); then
    echo "$out"; echo "FAIL $label (error)"; FAILS=$((FAILS+1)); return
  fi
  if [[ -z "$out" ]]; then echo "FAIL $label (empty output)"; FAILS=$((FAILS+1)); return; fi
  echo "$out"
  if echo "$out" | grep -q '|f$'; then echo "FAIL $label"; FAILS=$((FAILS+1)); else echo "PASS $label"; fi
}

# rows <label> <sql>: run one SELECT CASE...'PASS|...'/'FAIL|...' statement as
# the ctx_fixture login; require non-empty output, no FAIL rows.
rows() {
  local label=$1 sql=$2 out pass fail
  if ! out=$("${CTX[@]}" -t -A -c "$sql" 2>"$TMP/rows.err"); then
    echo "FAIL $label (error): $(tail -2 "$TMP/rows.err" | tr '\n' ' ' | cut -c1-200)"
    FAILS=$((FAILS+1)); return
  fi
  if [[ -z "$out" ]]; then echo "FAIL $label (empty output)"; FAILS=$((FAILS+1)); return; fi
  echo "$out"
  pass=$(printf '%s\n' "$out" | grep -c '^PASS|' || true)
  fail=$(printf '%s\n' "$out" | grep -c '^FAIL|' || true)
  if [[ "$pass" -ge 1 && "$fail" -eq 0 ]]; then echo "PASS $label"; else echo "FAIL $label ($pass PASS, $fail FAIL rows)"; FAILS=$((FAILS+1)); fi
}

# postgres (table) runner for documentation queries that read tables directly.
DOC=(psql -X -q -t -A -h "$TMP" -p $PORT -U postgres -d "$DB" -v ON_ERROR_STOP=1)

timing12() {
  local ph=$1 i
  for i in 1 2 3; do
    echo "timing-12-label $ph run $i: $("${CTX[@]}" -c '\timing on' -f "$TMP/cases/c12.sql" 2>&1 | grep '^Time: ' || echo 'FAIL no timing output')"
  done
  local expl
  if ! expl=$("${CTX[@]}" -t -A -c "EXPLAIN (ANALYZE, BUFFERS) $(cat "$TMP/cases/c12.sql")" 2>&1 | grep -m1 'actual time'); then
    echo "FAIL timing-12-label $ph EXPLAIN (no plan)"; FAILS=$((FAILS+1))
  else
    echo "timing-12-label $ph EXPLAIN (ANALYZE, BUFFERS): $expl"
  fi
}

expect() {
  local label=$1 want=$2 sql=$3 got
  got=$("${CTX[@]}" -v ON_ERROR_STOP=0 -c "DO \$t\$ BEGIN $sql; RAISE NOTICE 'RESULT=OK'; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT=% %', SQLSTATE, SQLERRM; END \$t\$;" 2>&1 | sed -n 's/.*RESULT=//p')
  if [[ "${got%% *}" == "$want" ]]; then echo "PASS $label -> $got"; else echo "FAIL $label: want $want got $got"; FAILS=$((FAILS+1)); fi
}

echo "== BEFORE (on 20261019213000, substring scans)"
# Document the pre-change behaviour the PR removes: the substring path matched
# these labels; the after-checks below assert the behaviour changes.
doc_out=$("${DOC[@]}" -c "SELECT CASE WHEN a AND b AND c AND d
  THEN 'PASS|old substring path matched all four labels'
  ELSE 'FAIL|old substring path missing some: a=' || a || ' b=' || b || ' c=' || c || ' d=' || d END
FROM (SELECT EXISTS(SELECT 1 FROM managed_knowledge_private.entities p WHERE p.status='active' AND position('jup' in lower(p.name))>0) a,
  EXISTS(SELECT 1 FROM managed_knowledge_private.entities p WHERE p.status='active' AND position('jupiter exchang' in lower(p.name))>0) b,
  EXISTS(SELECT 1 FROM managed_knowledge_private.entities p WHERE p.status='active' AND position('quantum harvesting' in lower(coalesce(p.summary,'')))>0) c,
  EXISTS(SELECT 1 FROM managed_knowledge_private.entities p WHERE p.status='active' AND position('quantum-harv-fund' in lower(p.metadata::text))>0) d) t;" 2>&1 || true)
if [[ -n "$doc_out" && "$doc_out" == PASS* ]]; then echo "$doc_out"; echo "PASS substring-path documentation";
else echo "$doc_out"; echo "FAIL substring-path documentation"; FAILS=$((FAILS+1)); fi
timing12 before
phase before "${ALL_CASES[@]}"

echo "== apply migration twice (idempotent)"
"${PSQL[@]}" --single-transaction -f "$M/$MIG" >/dev/null 2>"$TMP/mm.err" || { cat "$TMP/mm.err"; echo "FAIL migration apply"; exit 1; }
"${PSQL[@]}" --single-transaction -f "$M/$MIG" >/dev/null 2>"$TMP/mm.err" || { cat "$TMP/mm.err"; echo "FAIL migration apply 2"; exit 1; }
echo "apply twice: OK"
run_check_file "$T/${MIG%.sql}.check.sql" "post-apply check file"

echo "== AFTER behaviour checks"
rows "exact label hit still resolves (identityOnly=false, Krypton Ventures)" "
SELECT CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(res->'entities') v WHERE v->>'id'='55555555-0000-4000-8000-000000000002')
  THEN 'PASS|exact hit Krypton Ventures' ELSE 'FAIL|exact hit missing: ' || coalesce(res::text,'null') END
FROM (SELECT managed_knowledge_private.article_context_v1('{\"source\":\"news\",\"sourceRefs\":[],\"labels\":[\"Krypton Ventures\"],\"entityIds\":[],\"itemIds\":[],\"identityOnly\":false,\"limit\":24,\"historyMode\":\"targeted\"}'::jsonb) res) s;"
rows "trigram hit at >= 0.6: 'Jupiter Exchang' -> Jupiter Exchange, no others" "
SELECT CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(res->'entities') v WHERE v->>'id'='55555555-0000-4000-8000-000000000001')
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(res->'entities') v WHERE v->>'id' IN ('55555555-0000-4000-8000-000000000002','55555555-0000-4000-8000-000000000101'))
  THEN 'PASS|trigram hit Jupiter Exchange only' ELSE 'FAIL|trigram hit wrong set: ' || coalesce(res->>'entities','null') END
FROM (SELECT managed_knowledge_private.article_context_v1('{\"source\":\"news\",\"sourceRefs\":[],\"labels\":[\"Jupiter Exchang\"],\"entityIds\":[],\"itemIds\":[],\"identityOnly\":false,\"limit\":24,\"historyMode\":\"targeted\"}'::jsonb) res) s;"
rows "miss below 0.6: 'jup' matches nothing" "
SELECT CASE WHEN res->'entities' = '[]'::jsonb AND res->>'candidateTruncated' = 'false'
  THEN 'PASS|below-threshold label matched nothing' ELSE 'FAIL|below-threshold label matched: ' || coalesce(res->>'entities','null') END
FROM (SELECT managed_knowledge_private.article_context_v1('{\"source\":\"news\",\"sourceRefs\":[],\"labels\":[\"jup\"],\"entityIds\":[],\"itemIds\":[],\"identityOnly\":false,\"limit\":24,\"historyMode\":\"targeted\"}'::jsonb) res) s;"
rows "identityOnly returns no trigram-only matches" "
SELECT CASE WHEN res->'entities' = '[]'::jsonb
  THEN 'PASS|identityOnly returned no trigram-only candidates' ELSE 'FAIL|identityOnly returned: ' || coalesce(res->>'entities','null') END
FROM (SELECT managed_knowledge_private.article_context_v1('{\"source\":\"news\",\"sourceRefs\":[],\"labels\":[\"Jupiter Exchang\"],\"entityIds\":[],\"itemIds\":[],\"identityOnly\":true,\"limit\":24,\"historyMode\":\"targeted\"}'::jsonb) res) s;"
rows "labels that only appear in summary/metadata no longer match" "
SELECT CASE WHEN res->'entities' = '[]'::jsonb AND res->>'candidateTruncated' = 'false'
  THEN 'PASS|summary/metadata-only labels matched nothing' ELSE 'FAIL|summary/metadata-only labels matched: ' || coalesce(res->>'entities','null') END
FROM (SELECT managed_knowledge_private.article_context_v1('{\"source\":\"news\",\"sourceRefs\":[],\"labels\":[\"quantum harvesting\",\"quantum-harv-fund\"],\"entityIds\":[],\"itemIds\":[],\"identityOnly\":false,\"limit\":24,\"historyMode\":\"targeted\"}'::jsonb) res) s;"
rows "public.entities exact label matching survived" "
SELECT CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(res->'entities') v WHERE v->>'id'='55555555-0000-4000-8000-000000000101')
  THEN 'PASS|public exact hit Meridian Labs' ELSE 'FAIL|public exact missing: ' || coalesce(res->>'entities','null') END
FROM (SELECT managed_knowledge_private.article_context_v1('{\"source\":\"news\",\"sourceRefs\":[],\"labels\":[\"Meridian Labs\"],\"entityIds\":[],\"itemIds\":[],\"identityOnly\":false,\"limit\":24,\"historyMode\":\"targeted\"}'::jsonb) res) s;"
rows "public.entities substring matching is gone ('Meridian Lab')" "
SELECT CASE WHEN res->'entities' = '[]'::jsonb
  THEN 'PASS|public substring label matched nothing' ELSE 'FAIL|public substring label matched: ' || coalesce(res->>'entities','null') END
FROM (SELECT managed_knowledge_private.article_context_v1('{\"source\":\"news\",\"sourceRefs\":[],\"labels\":[\"Meridian Lab\"],\"entityIds\":[],\"itemIds\":[],\"identityOnly\":false,\"limit\":24,\"historyMode\":\"targeted\"}'::jsonb) res) s;"
timing12 after

echo "== EXPLAIN proof: the trigram predicate uses managed_entities_name_key_trgm"
plan=$("${READ[@]}" -c "SET enable_seqscan=off; EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM managed_knowledge_private.entities p
  WHERE p.status='active' AND p.name_key OPERATOR(extensions.%) managed_knowledge_private.entity_name_key_v1('Jupiter Exchang')
    AND extensions.similarity(p.name_key, managed_knowledge_private.entity_name_key_v1('Jupiter Exchang')) >= 0.6;" 2>&1 || true)
echo "$plan" | grep -E 'Index|actual' | sed 's/^/    /' || true
if [[ -n "$plan" ]] && echo "$plan" | grep -q 'Bitmap Index Scan on managed_entities_name_key_trgm'; then
  echo "PASS EXPLAIN uses managed_entities_name_key_trgm (enable_seqscan=off)"
else
  echo "FAIL EXPLAIN does not use managed_entities_name_key_trgm"; FAILS=$((FAILS+1))
fi

echo "== byte-identity for behaviour-preserving cases"
phase after "${ALL_CASES[@]}"
compare after "${SAME_CASES[@]}"

echo "== perEntityLimit batching still works"
batch_out=$("${CTX[@]}" -F'|' -c "
WITH batch AS (
  SELECT managed_knowledge_private.article_context_v1('{\"source\":\"news\",\"sourceRefs\":[],\"labels\":[],\"entityIds\":[\"11111111-0000-4000-8000-000000000001\",\"11111111-0000-4000-8000-000000000002\",\"11111111-0000-4000-8000-000000000222\",\"11111111-0000-4000-8000-000000000300\"],\"itemIds\":[],\"identityOnly\":false,\"limit\":5,\"historyMode\":\"recent\",\"perEntityLimit\":5}'::jsonb) b
), singles AS (
  SELECT 1 n, managed_knowledge_private.article_context_v1('{\"source\":\"news\",\"sourceRefs\":[],\"labels\":[],\"entityIds\":[\"11111111-0000-4000-8000-000000000001\"],\"itemIds\":[],\"identityOnly\":false,\"limit\":5,\"historyMode\":\"recent\"}'::jsonb) s
  UNION ALL SELECT 2, managed_knowledge_private.article_context_v1('{\"source\":\"news\",\"sourceRefs\":[],\"labels\":[],\"entityIds\":[\"11111111-0000-4000-8000-000000000002\"],\"itemIds\":[],\"identityOnly\":false,\"limit\":5,\"historyMode\":\"recent\"}'::jsonb)
  UNION ALL SELECT 3, managed_knowledge_private.article_context_v1('{\"source\":\"news\",\"sourceRefs\":[],\"labels\":[],\"entityIds\":[\"11111111-0000-4000-8000-000000000222\"],\"itemIds\":[],\"identityOnly\":false,\"limit\":5,\"historyMode\":\"recent\"}'::jsonb)
  UNION ALL SELECT 4, managed_knowledge_private.article_context_v1('{\"source\":\"news\",\"sourceRefs\":[],\"labels\":[],\"entityIds\":[\"11111111-0000-4000-8000-000000000300\"],\"itemIds\":[],\"identityOnly\":false,\"limit\":5,\"historyMode\":\"recent\"}'::jsonb)
), eids AS (
  SELECT unnest(ARRAY['11111111-0000-4000-8000-000000000001','11111111-0000-4000-8000-000000000002','11111111-0000-4000-8000-000000000222','11111111-0000-4000-8000-000000000300']) AS eid, generate_series(1,4) AS n
)
SELECT CASE WHEN
  (SELECT COALESCE(pg_catalog.jsonb_agg(v ORDER BY v->>'itemId'), '[]'::jsonb) FROM jsonb_array_elements(batch.b->'articleItems') v WHERE v->>'entityId' = eids.eid)
  = (SELECT COALESCE(pg_catalog.jsonb_agg(v ORDER BY v->>'itemId'), '[]'::jsonb) FROM jsonb_array_elements(singles.s->'articleItems') v)
  THEN 'PASS' ELSE 'FAIL' END, 'batched articleItems equal single articleItems for ' || eids.eid
FROM batch, singles JOIN eids ON eids.n = singles.n
UNION ALL
SELECT CASE WHEN (SELECT b->>'perEntityLimit' FROM batch) = '5' THEN 'PASS' ELSE 'FAIL' END, 'batched result carries perEntityLimit 5';" 2>&1 || true)
echo "$batch_out"
pass_rows=$(printf '%s\n' "$batch_out" | grep -c '^PASS|' || true)
fail_rows=$(printf '%s\n' "$batch_out" | grep -c '^FAIL|' || true)
if [[ -n "$batch_out" && "$pass_rows" -eq 5 && "$fail_rows" -eq 0 ]]; then
  echo "PASS batching equality"
else
  echo "FAIL batching equality: expected exactly five PASS rows and no FAIL (got $pass_rows PASS, $fail_rows FAIL)"
  FAILS=$((FAILS+1))
fi
expect "perEntityLimit 0 rejected" 22023 "PERFORM managed_knowledge_private.article_context_v1('{\"source\":\"news\",\"sourceRefs\":[],\"labels\":[],\"entityIds\":[\"11111111-0000-4000-8000-000000000001\"],\"itemIds\":[],\"identityOnly\":false,\"limit\":5,\"historyMode\":\"recent\",\"perEntityLimit\":0}'::jsonb)"
expect "perEntityLimit 11 rejected" 22023 "PERFORM managed_knowledge_private.article_context_v1('{\"source\":\"news\",\"sourceRefs\":[],\"labels\":[],\"entityIds\":[\"11111111-0000-4000-8000-000000000001\"],\"itemIds\":[],\"identityOnly\":false,\"limit\":5,\"historyMode\":\"recent\",\"perEntityLimit\":11}'::jsonb)"
expect "perEntityLimit with empty entityIds rejected" 22023 "PERFORM managed_knowledge_private.article_context_v1('{\"source\":\"news\",\"sourceRefs\":[],\"labels\":[],\"entityIds\":[],\"itemIds\":[],\"identityOnly\":false,\"limit\":5,\"historyMode\":\"recent\",\"perEntityLimit\":5}'::jsonb)"

echo "== rollback twice"
"${PSQL[@]}" --single-transaction -f "$REPO/supabase/rollbacks/$DOWN" >/dev/null 2>"$TMP/rb.err" || { cat "$TMP/rb.err"; echo "FAIL rollback apply"; exit 1; }
"${PSQL[@]}" --single-transaction -f "$REPO/supabase/rollbacks/$DOWN" >/dev/null 2>"$TMP/rb.err" || { cat "$TMP/rb.err"; echo "FAIL rollback apply 2"; exit 1; }
echo "rollback twice: OK"
run_check_file "$T/${MIG%.sql}.rollback.check.sql" "post-rollback check file"
phase rolled "${ALL_CASES[@]}"
compare rolled "${ALL_CASES[@]}"
rows "rollback restores substring behaviour ('jup' matches again)" "
SELECT CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(res->'entities') v WHERE v->>'id'='55555555-0000-4000-8000-000000000001')
  THEN 'PASS|substring behaviour restored' ELSE 'FAIL|substring behaviour missing: ' || coalesce(res->>'entities','null') END
FROM (SELECT managed_knowledge_private.article_context_v1('{\"source\":\"news\",\"sourceRefs\":[],\"labels\":[\"jup\"],\"entityIds\":[],\"itemIds\":[],\"identityOnly\":false,\"limit\":24,\"historyMode\":\"targeted\"}'::jsonb) res) s;"

echo "== re-apply migration and re-check"
"${PSQL[@]}" --single-transaction -f "$M/$MIG" >/dev/null 2>"$TMP/mm.err" || { cat "$TMP/mm.err"; echo "FAIL migration re-apply"; exit 1; }
"${PSQL[@]}" --single-transaction -f "$M/$MIG" >/dev/null 2>"$TMP/mm.err" || { cat "$TMP/mm.err"; echo "FAIL migration re-apply 2"; exit 1; }
run_check_file "$T/${MIG%.sql}.check.sql" "re-apply check file"

echo "== FAILS=$FAILS"
exit $((FAILS>0))