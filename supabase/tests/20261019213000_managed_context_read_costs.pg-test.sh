#!/usr/bin/env bash
# #336 item 1 (PR A): run 20261019213000_managed_context_read_costs + its rollback
# on a THROWAWAY local Postgres 17. Never points at Supabase.
# Usage: bash supabase/tests/20261019213000_managed_context_read_costs.pg-test.sh
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
TMP=$(mktemp -d /tmp/issue336pg.XXXX); PORT=55447; DB=db336
MIG=20261019213000_managed_context_read_costs.sql
DOWN=20261019213000_managed_context_read_costs.down.sql
trap '"$BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
"$BIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
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

# Every migration before this one, each in one transaction.
for f in $(ls "$M"/*.sql | sort); do
  base=$(basename "$f")
  if [[ "$base" > "$MIG" ]]; then break; fi
  "${PSQL[@]}" --single-transaction -f "$f" >/dev/null || { echo "FAIL migrate $base"; exit 1; }
done
echo "migrations: OK"
"${PSQL[@]}" -f "$T/${MIG%.sql}.seed.sql" >/dev/null || { echo "FAIL seed"; exit 1; }
echo "seed: OK"
"${PSQL[@]}" -c "CREATE ROLE ctx_fixture LOGIN; GRANT myboon_knowledge_context_executor TO ctx_fixture;" >/dev/null

CTX=(psql -X -q -t -A -h "$TMP" -p $PORT -U ctx_fixture -d "$DB" -v ON_ERROR_STOP=1)
READ=(psql -X -q -t -A -h "$TMP" -p $PORT -U postgres -d "$DB" -v ON_ERROR_STOP=1)

# Fixed call set: reader cases run as postgres after SET ROLE service_role;
# context cases run as the ctx_fixture login (they reject superusers).
mkdir -p "$TMP/cases"
cat > "$TMP/cases/r_obs61.sql" <<'SQL'
SET ROLE service_role;
SELECT public.read_managed_entity_knowledge_v1('observed-desc', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 61);
SQL
cat > "$TMP/cases/r_obs101.sql" <<'SQL'
SET ROLE service_role;
SELECT public.read_managed_entity_knowledge_v1('observed-desc', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 101);
SQL
cat > "$TMP/cases/r_cursor.sql" <<'SQL'
SET ROLE service_role;
SELECT public.read_managed_entity_knowledge_v1('observed-desc', NULL, NULL, NULL, NULL, NULL, now()-interval '8400 minutes', '22222222-0000-4000-8000-0000000004b0', 61);
SQL
cat > "$TMP/cases/r_scoped.sql" <<'SQL'
SET ROLE service_role;
SELECT public.read_managed_entity_knowledge_v1('observed-desc', '11111111-0000-4000-8000-000000000001', NULL, NULL, NULL, NULL, NULL, NULL, 61);
SQL
cat > "$TMP/cases/r_types.sql" <<'SQL'
SET ROLE service_role;
SELECT public.read_managed_entity_knowledge_v1('observed-desc', NULL, NULL, NULL, ARRAY['news_event'], NULL, NULL, NULL, 101);
SQL
cat > "$TMP/cases/r_since.sql" <<'SQL'
SET ROLE service_role;
SELECT public.read_managed_entity_knowledge_v1('observed-desc', NULL, NULL, now()-interval '5000 minutes', NULL, NULL, NULL, NULL, 101);
SQL
cat > "$TMP/cases/r_priority.sql" <<'SQL'
SET ROLE service_role;
SELECT public.read_managed_entity_knowledge_v1('observed-desc', NULL, NULL, NULL, NULL, ARRAY['high'], NULL, NULL, 101);
SQL
cat > "$TMP/cases/r_upd_since.sql" <<'SQL'
SET ROLE service_role;
SELECT public.read_managed_entity_knowledge_v1('updated-asc', NULL, NULL, now()-interval '5100 minutes', NULL, NULL, NULL, NULL, 61);
SQL
cat > "$TMP/cases/r_upd_cursor.sql" <<'SQL'
SET ROLE service_role;
SELECT public.read_managed_entity_knowledge_v1('updated-asc', NULL, NULL, NULL, NULL, NULL, now()-interval '7000 minutes', '22222222-0000-4000-8000-0000000003e8', 61);
SQL
cat > "$TMP/cases/r_ids40.sql" <<'SQL'
SET ROLE service_role;
SELECT public.read_managed_entity_knowledge_v1('id-asc', NULL, (SELECT array_agg(('22222222-0000-4000-8000-'||lpad(to_hex(g),12,'0'))::uuid ORDER BY g) FROM generate_series(1,40) AS s(g)), NULL, NULL, NULL, NULL, NULL, 61);
SQL
cat > "$TMP/cases/r_event.sql" <<'SQL'
SET ROLE service_role;
SELECT public.read_managed_entity_knowledge_v1('event-desc', '11111111-0000-4000-8000-000000000001', NULL, NULL, NULL, NULL, NULL, NULL, 61);
SQL
cat > "$TMP/cases/r_event_cursor.sql" <<'SQL'
SET ROLE service_role;
SELECT public.read_managed_entity_knowledge_v1('event-desc', '11111111-0000-4000-8000-000000000001', NULL, NULL, NULL, NULL, now()-interval '270 minutes', '22222222-0000-4000-8000-00000000001e', 61);
SQL
cat > "$TMP/cases/c_probe.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":[],"labels":["__myboon_database_availability_probe__"],"entityIds":[],"itemIds":[],"identityOnly":true,"limit":1,"historyMode":"targeted"}'::jsonb);
SQL
cat > "$TMP/cases/c_recent.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":[],"labels":[],"entityIds":["11111111-0000-4000-8000-000000000001"],"itemIds":[],"identityOnly":false,"limit":5,"historyMode":"recent"}'::jsonb);
SQL
cat > "$TMP/cases/c_search.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":[],"labels":["managed entity 1","managed entity 2","managed entity 3","managed entity 4","managed entity 5","managed entity 6","managed entity 7","managed entity 8","managed entity 9","managed entity 10","managed entity 11","managed entity 12"],"entityIds":[],"itemIds":[],"identityOnly":false,"limit":24,"historyMode":"targeted"}'::jsonb);
SQL
cat > "$TMP/cases/c_exact.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":[],"labels":["managed-3","me3","managed entity 7"],"entityIds":[],"itemIds":[],"identityOnly":true,"limit":16,"historyMode":"targeted"}'::jsonb);
SQL
cat > "$TMP/cases/c_ctx.sql" <<'SQL'
SELECT managed_knowledge_private.context_v1('{"source":"news","sourceRefs":["signal-100","signal-200"],"labels":["managed entity 5"],"entityIds":[],"itemIds":[],"limit":24}'::jsonb);
SQL

# phase <label>: run every fixed call once, strip the "Time:" lines for the
# byte-identical diff, and print the per-call timings ("Time:" lines).
phase() {
  local ph=$1 f name
  for f in "$TMP"/cases/*.sql; do
    name=$(basename "$f" .sql)
    if [[ "$name" == r_* ]]; then runner=("${READ[@]}"); else runner=("${CTX[@]}"); fi
    if ! "${runner[@]}" -c '\timing on' -f "$f" > "$TMP/out.$name.$ph" 2> "$TMP/err.$name.$ph"; then
      echo "FAIL call $name ($ph): $(grep -v '^SET$' "$TMP/err.$name.$ph" | tail -3 | tr '\n' ' ' | cut -c1-220)"
      FAILS=$((FAILS+1)); continue
    fi
    grep -v '^Time: ' "$TMP/out.$name.$ph" > "$TMP/res.$name.$ph" || true
    echo "$ph $name: $(grep '^Time: ' "$TMP/out.$name.$ph" | tr '\n' ' ')"
  done
}

# compare <label>: every fixed call's result must equal the before-migration
# result byte for byte.
compare() {
  local ph=$1 f name
  for f in "$TMP"/cases/*.sql; do
    name=$(basename "$f" .sql)
    if cmp -s "$TMP/res.$name.before" "$TMP/res.$name.$ph"; then
      echo "PASS byte-identical $name ($ph)"
    else
      echo "FAIL byte-identical $name ($ph): results differ"
      diff "$TMP/res.$name.before" "$TMP/res.$name.$ph" 2>&1 | head -4 | sed 's/^/    /' || true
      FAILS=$((FAILS+1))
    fi
  done
}

run_check_file() {
  local file=$1 label=$2 out
  out=$("${PSQL[@]}" -t -A -F'|' -f "$file")
  echo "$out"
  if echo "$out" | grep -q '|f$'; then echo "FAIL $label"; FAILS=$((FAILS+1)); else echo "PASS $label"; fi
}

echo "== before migration"
phase before

echo "== apply migration twice (idempotent)"
"${PSQL[@]}" --single-transaction -f "$M/$MIG" >/dev/null || { echo "FAIL migration apply"; exit 1; }
"${PSQL[@]}" --single-transaction -f "$M/$MIG" >/dev/null || { echo "FAIL migration apply 2"; exit 1; }
echo "apply twice: OK"
run_check_file "$T/${MIG%.sql}.check.sql" "post-apply check file"

echo "== after migration"
phase after
compare after

echo "== batching: one perEntityLimit call equals four single calls"
batch_out=$("${CTX[@]}" -F'|' -e "
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
  (SELECT pg_catalog.jsonb_agg(v ORDER BY v->>'itemId') FROM jsonb_array_elements(batch.b->'articleItems') v WHERE v->>'entityId' = eids.eid)
  = (SELECT pg_catalog.jsonb_agg(v ORDER BY v->>'itemId') FROM jsonb_array_elements(singles.s->'articleItems') v)
  THEN 'PASS' ELSE 'FAIL' END, 'batched articleItems equal single articleItems for ' || eids.eid
FROM batch, singles JOIN eids ON eids.n = singles.n;
SELECT CASE WHEN (SELECT b->>'perEntityLimit' FROM batch) = '5' THEN 'PASS' ELSE 'FAIL' END, 'batched result carries perEntityLimit 5';")
echo "$batch_out"
if echo "$batch_out" | grep -q '^FAIL'; then echo "FAIL batching equality"; FAILS=$((FAILS+1)); else echo "PASS batching equality"; fi

expect() {
  local label=$1 want=$2 sql=$3 got
  got=$("${CTX[@]}" -v ON_ERROR_STOP=0 -c "DO \$t\$ BEGIN $sql; RAISE NOTICE 'RESULT=OK'; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT=% %', SQLSTATE, SQLERRM; END \$t\$;" 2>&1 | sed -n 's/.*RESULT=//p')
  if [[ "${got%% *}" == "$want" ]]; then echo "PASS $label -> $got"; else echo "FAIL $label: want $want got $got"; FAILS=$((FAILS+1)); fi
}
expect "perEntityLimit 0 rejected" 22023 "PERFORM managed_knowledge_private.article_context_v1('{\"source\":\"news\",\"sourceRefs\":[],\"labels\":[],\"entityIds\":[\"11111111-0000-4000-8000-000000000001\"],\"itemIds\":[],\"identityOnly\":false,\"limit\":5,\"historyMode\":\"recent\",\"perEntityLimit\":0}'::jsonb)"
expect "perEntityLimit 11 rejected" 22023 "PERFORM managed_knowledge_private.article_context_v1('{\"source\":\"news\",\"sourceRefs\":[],\"labels\":[],\"entityIds\":[\"11111111-0000-4000-8000-000000000001\"],\"itemIds\":[],\"identityOnly\":false,\"limit\":5,\"historyMode\":\"recent\",\"perEntityLimit\":11}'::jsonb)"

echo "== rollback twice"
"${PSQL[@]}" --single-transaction -f "$REPO/supabase/rollbacks/$DOWN" >/dev/null || { echo "FAIL rollback apply"; exit 1; }
"${PSQL[@]}" --single-transaction -f "$REPO/supabase/rollbacks/$DOWN" >/dev/null || { echo "FAIL rollback apply 2"; exit 1; }
echo "rollback twice: OK"
run_check_file "$T/${MIG%.sql}.rollback.check.sql" "post-rollback check file"
phase rolled
compare rolled

echo "== re-apply migration and re-check"
"${PSQL[@]}" --single-transaction -f "$M/$MIG" >/dev/null || { echo "FAIL migration re-apply"; exit 1; }
"${PSQL[@]}" --single-transaction -f "$M/$MIG" >/dev/null || { echo "FAIL migration re-apply 2"; exit 1; }
run_check_file "$T/${MIG%.sql}.check.sql" "re-apply check file"

echo "== FAILS=$FAILS"
exit $((FAILS>0))