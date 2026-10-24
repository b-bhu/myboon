#!/usr/bin/env bash
# #418: run 20261020200000_article_context_v2 + its rollback on a THROWAWAY
# local Postgres 17. Never points at Supabase. Proves byte-identical outputs for
# the article_context_v1 matrix, the temp-disk contrast (per-call temp blocks from
# pg_stat_statements under small work_mem; no query logging), the #420 determinism keys,
# and -- new for v2 -- that the history statement does not pay the #420 v1
# join-back regression: against the v1 fixture (the unmerged 20261020130000
# body, from the #420 review reference) with work_mem 4MB and enable_nestloop=off,
# the new function scans entity_memories no more often than v1
# (pg_stat_xact_user_tables) and its history statement's elapsed
# (pg_stat_statements) stays under 1.2x the v1 elapsed (no re-evaluated predicates on the scan).
# Usage: bash supabase/tests/20261020200000_article_context_v2.pg-test.sh
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
TMP=$(mktemp -d "${PG_TEST_ROOT:-/home/box/work}/issue418v2.XXXX"); PORT=55421; DB=db418v2
MIG=20261020200000_article_context_v2.sql
DOWN=20261020200000_article_context_v2.down.sql
FIX=20261020130000_article_context_spill.fixture.sql
trap '"$BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
"$BIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
"$BIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses='' -c shared_preload_libraries=pg_stat_statements -c pg_stat_statements.track=all -c log_min_duration_statement=-1 -c log_statement=none" -l "$TMP/log" -w start >/dev/null
"$BIN/createdb" -h "$TMP" -p $PORT -U postgres "$DB"
PSQL=(psql -X -q -h "$TMP" -p $PORT -U postgres -d "$DB" -v ON_ERROR_STOP=1)
"${PSQL[@]}" -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements" >/dev/null
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

# Every migration before 20261020200000, each in one transaction.
for f in $(ls "$M"/*.sql | sort); do
  base=$(basename "$f")
  if [[ ! "$base" < "$MIG" ]]; then break; fi  # strictly before this migration
  "${PSQL[@]}" --single-transaction -f "$f" >/dev/null || { echo "FAIL migrate $base"; exit 1; }
done
echo "migrations: OK"
"${PSQL[@]}" -f "$T/20261019213000_managed_context_read_costs.seed.sql" >/dev/null || { echo "FAIL seed 213000"; exit 1; }
"${PSQL[@]}" -f "$T/${MIG%.sql}.seed.sql" >/dev/null || { echo "FAIL seed 418 v2"; exit 1; }
echo "seed: OK"
"${PSQL[@]}" -c "CREATE ROLE ctx_fixture LOGIN; GRANT myboon_knowledge_context_executor TO ctx_fixture;" >/dev/null

CTX=(psql -X -q -t -A -h "$TMP" -p $PORT -U ctx_fixture -d "$DB" -v ON_ERROR_STOP=1)
READ=(psql -X -q -t -A -h "$TMP" -p $PORT -U postgres -d "$DB" -v ON_ERROR_STOP=1)

# Fixed call set (article_context_v1 runs as the ctx_fixture login: rejects superusers).
mkdir -p "$TMP/cases"
cat > "$TMP/cases/c_probe.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":[],"labels":["__myboon_database_availability_probe__"],"entityIds":[],"itemIds":[],"identityOnly":true,"limit":1,"historyMode":"targeted"}'::jsonb);
SQL
cat > "$TMP/cases/c_recent_l1.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":[],"labels":[],"entityIds":["11111111-0000-4000-8000-000000000001"],"itemIds":[],"identityOnly":false,"limit":1,"historyMode":"recent"}'::jsonb);
SQL
cat > "$TMP/cases/c_recent_l5.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":[],"labels":[],"entityIds":["11111111-0000-4000-8000-000000000001","11111111-0000-4000-8000-000000000002","00000000-0000-4000-8000-000000000001"],"itemIds":[],"identityOnly":false,"limit":5,"historyMode":"recent"}'::jsonb);
SQL
cat > "$TMP/cases/c_recent_l24.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":[],"labels":[],"entityIds":["11111111-0000-4000-8000-000000000001","11111111-0000-4000-8000-000000000002","11111111-0000-4000-8000-000000000003","11111111-0000-4000-8000-000000000004"],"itemIds":[],"identityOnly":false,"limit":24,"historyMode":"recent"}'::jsonb);
SQL
cat > "$TMP/cases/c_recent_l32.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":[],"labels":[],"entityIds":["11111111-0000-4000-8000-000000000001","11111111-0000-4000-8000-000000000002","11111111-0000-4000-8000-000000000003","11111111-0000-4000-8000-000000000004","11111111-0000-4000-8000-000000000005","11111111-0000-4000-8000-000000000006"],"itemIds":[],"identityOnly":false,"limit":32,"historyMode":"recent"}'::jsonb);
SQL
cat > "$TMP/cases/c_targeted_title.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":[],"labels":["article title 12"],"entityIds":["11111111-0000-4000-8000-000000000001"],"itemIds":[],"identityOnly":false,"limit":8,"historyMode":"targeted"}'::jsonb);
SQL
cat > "$TMP/cases/c_targeted_summary.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":[],"labels":["timeline summary 30"],"entityIds":["11111111-0000-4000-8000-000000000001"],"itemIds":[],"identityOnly":false,"limit":8,"historyMode":"targeted"}'::jsonb);
SQL
# Targeted case carrying labels + sourceRefs + entityIds at once (the #420 v1
# join-back re-applied all of them over a second full entity_memories scan).
# The sourceRef matches nothing, so results are unchanged; the predicate is
# still evaluated per row -- this is the case the no-duplicate-scan check runs.
cat > "$TMP/cases/c_targeted_body.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":["__no_source_ref_418__"],"labels":["legacy body marker 418"],"entityIds":["00000000-0000-4000-8000-00000000004c"],"itemIds":[],"identityOnly":false,"limit":8,"historyMode":"targeted"}'::jsonb);
SQL
cat > "$TMP/cases/c_targeted_note.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":[],"labels":["item note 2300"],"entityIds":["11111111-0000-4000-8000-000000000001"],"itemIds":[],"identityOnly":false,"limit":8,"historyMode":"targeted"}'::jsonb);
SQL
cat > "$TMP/cases/c_itemids_only.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":[],"labels":[],"entityIds":[],"itemIds":["22222222-0000-4000-8000-0000000000c8","22222222-0000-4000-8000-0000000008fc"],"identityOnly":false,"limit":8,"historyMode":"targeted"}'::jsonb);
SQL
cat > "$TMP/cases/c_itemids_outside.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":[],"labels":[],"entityIds":["11111111-0000-4000-8000-000000000001"],"itemIds":["22222222-0000-4000-8000-000000000960"],"identityOnly":false,"limit":6,"historyMode":"recent"}'::jsonb);
SQL
cat > "$TMP/cases/c_sourcerefs_url.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":["https://example.com/a/77"],"labels":[],"entityIds":["11111111-0000-4000-8000-00000000021c"],"itemIds":[],"identityOnly":false,"limit":8,"historyMode":"targeted"}'::jsonb);
SQL
cat > "$TMP/cases/c_sourcerefs_signal.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":["signal-500"],"labels":[],"entityIds":["11111111-0000-4000-8000-000000000001"],"itemIds":[],"identityOnly":false,"limit":8,"historyMode":"targeted"}'::jsonb);
SQL
cat > "$TMP/cases/c_sourcerefs_legacy.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":["ref-700"],"labels":["public entity 701"],"entityIds":["00000000-0000-4000-8000-0000000021fd"],"itemIds":[],"identityOnly":false,"limit":5,"historyMode":"targeted"}'::jsonb);
SQL
cat > "$TMP/cases/c_empty_entityIds_labels.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":[],"labels":["managed entity 1","managed entity 2","managed entity 3"],"entityIds":[],"itemIds":[],"identityOnly":false,"limit":24,"historyMode":"targeted"}'::jsonb);
SQL
cat > "$TMP/cases/c_perentity1_multi.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":[],"labels":[],"entityIds":["11111111-0000-4000-8000-000000000001","11111111-0000-4000-8000-000000000002","00000000-0000-4000-8000-000000000001"],"itemIds":[],"identityOnly":false,"limit":5,"historyMode":"recent","perEntityLimit":1}'::jsonb);
SQL
cat > "$TMP/cases/c_perentity1_single.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":[],"labels":[],"entityIds":["11111111-0000-4000-8000-000000000001"],"itemIds":[],"identityOnly":false,"limit":5,"historyMode":"recent","perEntityLimit":1}'::jsonb);
SQL
cat > "$TMP/cases/c_perentity5.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":[],"labels":[],"entityIds":["11111111-0000-4000-8000-000000000001","11111111-0000-4000-8000-000000000002","11111111-0000-4000-8000-000000000003","11111111-0000-4000-8000-000000000004","11111111-0000-4000-8000-000000000005","11111111-0000-4000-8000-000000000006"],"itemIds":[],"identityOnly":false,"limit":5,"historyMode":"recent","perEntityLimit":5}'::jsonb);
SQL
cat > "$TMP/cases/c_ties.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":[],"labels":[],"entityIds":["11111111-0000-4000-8000-0000000021fd"],"itemIds":[],"identityOnly":false,"limit":12,"historyMode":"recent"}'::jsonb);
SQL
cat > "$TMP/cases/c_legacy_ties.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":[],"labels":[],"entityIds":["00000000-0000-4000-8000-00000000006d"],"itemIds":[],"identityOnly":false,"limit":12,"historyMode":"recent"}'::jsonb);
SQL
cat > "$TMP/cases/c_identityonly_true.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":[],"labels":["managed-3","me3","managed entity 7"],"entityIds":[],"itemIds":[],"identityOnly":true,"limit":16,"historyMode":"targeted"}'::jsonb);
SQL
cat > "$TMP/cases/c_identityonly_false.sql" <<'SQL'
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":[],"labels":["managed-3","me3","managed entity 7"],"entityIds":[],"itemIds":[],"identityOnly":false,"limit":16,"historyMode":"targeted"}'::jsonb);
SQL


phase() {
  local ph=$1 f name
  for f in "$TMP"/cases/c_*.sql; do
    name=$(basename "$f" .sql)
    "${CTX[@]}" -c '\timing on' -f "$f" > "$TMP/out.$name.$ph" 2> "$TMP/err.$name.$ph" || {
      echo "FAIL call $name ($ph): $(tail -3 "$TMP/err.$name.$ph" | tr '\n' ' ' | cut -c1-220)"
      FAILS=$((FAILS+1)); continue
    }
    grep -v '^Time: ' "$TMP/out.$name.$ph" > "$TMP/res.$name.$ph" || true
    echo "$ph $name: $(grep '^Time: ' "$TMP/out.$name.$ph" | tr '\n' ' ')"
  done
}

# tie_equal <a> <b>: same document apart from articleItems; articleItems have
# the same itemId sequence and the same multiset of rows.
tie_equal() {
  local q='{rest: del(.articleItems), ids: [.articleItems[].itemId], rows: (.articleItems | sort_by(.itemId, .entityId))}'
  [[ "$(jq -cS "$q" "$1")" == "$(jq -cS "$q" "$2")" ]]
}

# determinism <phase>: with the #420 entity_id tie-breaker the new function's
# c_itemids_only output is identical over 5 repeated calls, and rows sharing
# an itemId (same sort time) come out in ascending entityId order.
determinism() {
  local ph=$1 i ref ok=1
  ref="$TMP/res.c_itemids_only.$ph"
  for i in 1 2 3 4 5; do
    "${CTX[@]}" -f "$TMP/cases/c_itemids_only.sql" > "$TMP/rep.$i" 2>/dev/null || ok=0
    cmp -s "$ref" "$TMP/rep.$i" || ok=0
  done
  if [[ $ok == 1 ]]; then echo "PASS c_itemids_only identical across 5 repeated runs ($ph)"; else echo "FAIL c_itemids_only differs across repeated runs ($ph)"; FAILS=$((FAILS+1)); fi
  if jq -e '.articleItems as $a | [range(1;($a|length))] | all(($a[.-1].itemId != $a[.].itemId) or ($a[.-1].entityId < $a[.].entityId))' "$ref" >/dev/null; then
    echo "PASS c_itemids_only same-itemId rows ordered by entityId ($ph)"
  else
    echo "FAIL c_itemids_only same-itemId rows not ordered by entityId ($ph)"; FAILS=$((FAILS+1))
  fi
}

compare() {
  local ph=$1 f name
  for f in "$TMP"/cases/c_*.sql; do
    name=$(basename "$f" .sql)
    if cmp -s "$TMP/res.$name.before" "$TMP/res.$name.$ph"; then
      echo "PASS byte-identical $name ($ph)"
    elif tie_equal "$TMP/res.$name.before" "$TMP/res.$name.$ph"; then
      # Old and new both leave the order of one itemId's rows for different
      # entities (same sort time, same itemId) unspecified; everything the
      # ORDER BY determines is still identical.
      echo "PASS identical up to unspecified same-itemId order $name ($ph)"
    else
      echo "FAIL byte-identical $name ($ph): results differ"
      diff "$TMP/res.$name.before" "$TMP/res.$name.$ph" 2>&1 | head -4 | sed 's/^/    /' || true
      FAILS=$((FAILS+1))
    fi
  done
}

# spill_run <work_mem> <label>: one ctx call of cases/spill.sql with that
# work_mem; spill_kB is the top-level call's temp_blks_written x 8kB from
# pg_stat_statements (in-memory counters, no query logging), spilling_stmts the
# nested statements that wrote temp blocks.
# Prints 'label wm: elapsed_ms=.. spill_kB=.. spilling_stmts=..'.
spill_run() {
  local wm=$1 label=$2 t0 t1 kb n
  "${READ[@]}" -c "SELECT pg_stat_statements_reset()" >/dev/null
  t0=$(date +%s%3N)
  if ! PGOPTIONS="-c work_mem=$wm" "${CTX[@]}" -f "$TMP/cases/spill.sql" \
      > "$TMP/spill.$label.$wm.out" 2> "$TMP/spill.$label.$wm.err"; then
    echo "FAIL spill call $label ($wm): $(grep -m1 -E "ERROR|FATAL" "$TMP/spill.$label.$wm.err" | cut -c1-300)"
    return 0
  fi
  t1=$(date +%s%3N)
  kb=$("${READ[@]}" -c "SELECT COALESCE(sum(temp_blks_written),0)*8 FROM pg_stat_statements WHERE toplevel AND query LIKE '%article_context_v1%'")
  n=$("${READ[@]}" -c "SELECT count(*) FROM pg_stat_statements WHERE NOT toplevel AND temp_blks_written > 0")
  echo "$label $wm: elapsed_ms=$((t1-t0)) spill_kB=$kb spilling_stmts=$n"
}
kb_of() { sed -n 's/.*spill_kB=\([0-9]*\).*/\1/p'; }

# 4MB is production's work_mem (SHOW work_mem on the Supabase project, read-only).
LADDER=(64kB 1MB 4MB)
declare -A OLD_KB NEW_KB
ENTIDS='["11111111-0000-4000-8000-000000002329","11111111-0000-4000-8000-00000000232a","11111111-0000-4000-8000-00000000232b","11111111-0000-4000-8000-00000000232c","11111111-0000-4000-8000-00000000232d","11111111-0000-4000-8000-00000000232e","11111111-0000-4000-8000-00000000232f","11111111-0000-4000-8000-000000002330","11111111-0000-4000-8000-000000002331","11111111-0000-4000-8000-000000002332","11111111-0000-4000-8000-000000002333","11111111-0000-4000-8000-000000002334","11111111-0000-4000-8000-000000002335","11111111-0000-4000-8000-000000002336","11111111-0000-4000-8000-000000002337","11111111-0000-4000-8000-000000002338","11111111-0000-4000-8000-000000002339","11111111-0000-4000-8000-00000000233a","11111111-0000-4000-8000-00000000233b","11111111-0000-4000-8000-00000000233c"]'
# Spill call: perEntityLimit 5 over the 20 Spill Entities (their ~20k history
# rows make the 20261019213000 wide-row window sort spill at small work_mem).
cat > "$TMP/cases/spill.sql" <<SQL
SELECT managed_knowledge_private.article_context_v1('{"source":"news","sourceRefs":[],"labels":[],"entityIds":$ENTIDS,"itemIds":[],"identityOnly":false,"limit":24,"historyMode":"recent","perEntityLimit":5}'::jsonb);
SQL
echo "== before migration (spill baseline across work_mem ladder)"
for wm in "${LADDER[@]}"; do
  line=$(spill_run "$wm" old); echo "$line"; OLD_KB[$wm]=$(echo "$line" | kb_of)
done
echo "== byte-identity matrix, before migration"
phase before

echo "== apply migration twice (idempotent)"
"${PSQL[@]}" --single-transaction -f "$M/$MIG" >/dev/null || { echo "FAIL migration apply"; exit 1; }
"${PSQL[@]}" --single-transaction -f "$M/$MIG" >/dev/null || { echo "FAIL migration apply 2"; exit 1; }
echo "apply twice: OK"

echo "== after migration"
phase after
compare after
determinism after

echo "== spill contrast, new function"
for wm in "${LADDER[@]}"; do
  line=$(spill_run "$wm" new); echo "$line"; NEW_KB[$wm]=$(echo "$line" | kb_of)
done
if [[ "${OLD_KB[4MB]:-0}" -gt 0 && "${NEW_KB[4MB]:-x}" == "0" ]]; then
  echo "PASS spill contrast at production work_mem 4MB: old spilled ${OLD_KB[4MB]}kB, new 0kB"
else
  echo "FAIL spill contrast at 4MB: old=${OLD_KB[4MB]:-missing}kB new=${NEW_KB[4MB]:-missing}kB"; FAILS=$((FAILS+1))
fi
for wm in "${LADDER[@]}"; do
  if [[ -n "${OLD_KB[$wm]}" && -n "${NEW_KB[$wm]}" && "${NEW_KB[$wm]}" -lt "${OLD_KB[$wm]}" || "${OLD_KB[$wm]}" == "0" ]]; then
    echo "PASS new spills less at $wm (old ${OLD_KB[$wm]}kB, new ${NEW_KB[$wm]}kB)"
  else
    echo "FAIL new not smaller at $wm (old ${OLD_KB[$wm]:-missing}kB, new ${NEW_KB[$wm]:-missing}kB)"; FAILS=$((FAILS+1))
  fi
done

# No duplicate scan: the #420 v1 body's history statement joined the picked
# rows back AND re-applied every filter predicate, so with hash/seq plans
# entity_memories was seq-scanned a second time evaluating the label
# position() predicates. Deploy the v1 fixture (the old, regressed body),
# then v2 again, and compare the article_context history statement, i.e. the
# nested statement that reads entity_memories, run at the
# production work_mem with enable_nestloop=off (hash/seq plans) on the
# targeted case that carries labels + sourceRefs + entityIds.
echo "== no duplicate scan: v1 fixture vs v2 (history statement, enable_nestloop=off)"
declare -A DUP_MS DUP_SCANS
scan_run() {
  local label=$1
  "${READ[@]}" -c "SELECT pg_stat_statements_reset()" >/dev/null
  # One transaction: pg_stat_xact_user_tables shows this call's scans on
  # entity_memories before any stats flush. No plan logging involved.
  if ! { echo "BEGIN;"; cat "$TMP/cases/c_targeted_body.sql"; echo "SELECT 'SCANS=' || (seq_scan + idx_scan) FROM pg_stat_xact_user_tables WHERE relname = 'entity_memories'; COMMIT;"; } \
      | PGOPTIONS='-c work_mem=4MB -c enable_nestloop=off' "${CTX[@]}" > "$TMP/dup.$label.out" 2> "$TMP/dup.$label.err"; then
    echo "FAIL no-duplicate-scan call $label: $(tail -2 "$TMP/dup.$label.err" | tr '\n' ' ' | cut -c1-220)"
    FAILS=$((FAILS+1)); return 1
  fi
  DUP_SCANS[$label]=$(sed -n 's/^SCANS=\([0-9]*\)$/\1/p' "$TMP/dup.$label.out" | tail -1)
  # History statement: the slowest nested statement reading entity_memories.
  DUP_MS[$label]=$("${READ[@]}" -c "SELECT round(max(total_exec_time)::numeric, 3) FROM pg_stat_statements WHERE NOT toplevel AND query ILIKE '%entity_memories%'")
  if [[ -n "${DUP_SCANS[$label]}" && -n "${DUP_MS[$label]}" ]]; then return 0; fi
  echo "FAIL no-duplicate-scan stats for $label: scans='${DUP_SCANS[$label]}' ms='${DUP_MS[$label]}'"
  FAILS=$((FAILS+1)); return 1
}
if "${PSQL[@]}" --single-transaction -f "$T/$FIX" >/dev/null; then
  if scan_run old && "${PSQL[@]}" --single-transaction -f "$M/$MIG" >/dev/null && scan_run new; then
    echo "no duplicate scan: old scans=${DUP_SCANS[old]} elapsed_ms=${DUP_MS[old]} / new scans=${DUP_SCANS[new]} elapsed_ms=${DUP_MS[new]}"
    if [[ -n "${DUP_SCANS[old]}" && -n "${DUP_SCANS[new]}" ]]; then
      if (( DUP_SCANS[new] <= DUP_SCANS[old] )); then
        echo "PASS entity_memories scans per call, v2 <= v1 (${DUP_SCANS[new]} <= ${DUP_SCANS[old]})"
      else
        echo "FAIL entity_memories scans per call increased (v1 ${DUP_SCANS[old]}, v2 ${DUP_SCANS[new]})"; FAILS=$((FAILS+1))
      fi
      if awk "BEGIN{exit !(${DUP_MS[new]} < 1.2 * ${DUP_MS[old]})}"; then
        echo "PASS history statement elapsed ${DUP_MS[new]}ms < 1.2 x ${DUP_MS[old]}ms (v1 re-filtered second scan gone)"
      else
        echo "FAIL history statement elapsed ${DUP_MS[new]}ms not under 1.2 x ${DUP_MS[old]}ms"; FAILS=$((FAILS+1))
      fi
    fi
  else
    echo "FAIL no-duplicate-scan run aborted"; FAILS=$((FAILS+1))
  fi
else
  echo "FAIL deploy v1 fixture $FIX"; FAILS=$((FAILS+1))
fi

echo "== batching: one perEntityLimit call equals four single calls"
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

echo "== rollback twice"
"${PSQL[@]}" --single-transaction -f "$R/$DOWN" >/dev/null || { echo "FAIL rollback apply"; exit 1; }
"${PSQL[@]}" --single-transaction -f "$R/$DOWN" >/dev/null || { echo "FAIL rollback apply 2"; exit 1; }
echo "rollback twice: OK"
phase rolled
compare rolled

echo "== re-apply migration and re-check"
"${PSQL[@]}" --single-transaction -f "$M/$MIG" >/dev/null || { echo "FAIL migration re-apply"; exit 1; }
"${PSQL[@]}" --single-transaction -f "$M/$MIG" >/dev/null || { echo "FAIL migration re-apply 2"; exit 1; }
phase after2
compare after2
determinism after2

echo "== FAILS=$FAILS"
exit $((FAILS>0))