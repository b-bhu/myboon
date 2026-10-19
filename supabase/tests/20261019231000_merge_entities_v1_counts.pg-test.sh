#!/usr/bin/env bash
# #342 PR-4 B: apply every repo migration BEFORE 20261019231000 (including
# 20261019220000 and 20261019230000), capture the PR-3 merge body, apply the
# counts migration, run the checks and behaviour cases (certain-row collisions
# and the suppressed-row 40001), then the down file and prove the PR-3 body is
# restored byte-for-byte - on a THROWAWAY local Postgres 17. Never points at
# Supabase; never runs `supabase db push` (#397).
# Usage: bash supabase/tests/20261019231000_merge_entities_v1_counts.pg-test.sh
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
TMP=$(mktemp -d /tmp/pg342b.XXXX); PORT=${PG_TEST_PORT:-55352}
trap '"$BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
"$BIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
"$BIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null
PSQL=(psql -X -q -h "$TMP" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1)
M=20261019231000_merge_entities_v1_counts; T=$REPO/supabase/tests/$M; FAILS=0
"${PSQL[@]}" -c "CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE ROLE authenticator NOINHERIT LOGIN; GRANT anon, authenticated, service_role TO authenticator;
  CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto SCHEMA extensions; CREATE EXTENSION \"uuid-ossp\" SCHEMA extensions;"
apply() { PGOPTIONS='-c client_min_messages=error' "${PSQL[@]}" -1 -f "$1" >/dev/null 2>"$TMP/m.err" || { cat "$TMP/m.err"; echo "FAIL apply $(basename "$1")"; exit 1; }; }
checkfile() {
  local out; out=$("${PSQL[@]}" -t -A -F'|' -f "$1" 2>&1) || { echo "$out"; echo "FAIL $(basename "$1")"; FAILS=$((FAILS+1)); return; }
  echo "$out"
  if echo "$out" | grep -qE '[|](f|false)$'; then echo "FAIL $(basename "$1")"; FAILS=$((FAILS+1)); else echo "PASS $(basename "$1")"; fi
}
body() { "${PSQL[@]}" -t -A -c "SELECT coalesce(md5(prosrc),'missing') FROM pg_catalog.pg_proc WHERE oid = 'managed_knowledge_private.merge_entities_v1(uuid, uuid, boolean)'::regprocedure"; }
count=0
for m in "$REPO"/supabase/migrations/*.sql; do
  # Only migrations strictly before the counts migration: it must still apply
  # on the state they leave behind, and nothing after it may be required.
  [[ $(basename "$m") < ${M}.sql ]] || continue
  apply "$m"; count=$((count + 1))
done
echo "migrations applied before $M: $count"
BODY0=$(body)
echo "== apply $M (single transaction)"; apply "$REPO/supabase/migrations/$M.sql"; echo "migration: OK"
echo "== re-apply (idempotent)"; apply "$REPO/supabase/migrations/$M.sql"; echo "re-apply: OK"
checkfile "$T.check.sql"
checkfile "$T.behaviour.sql"
echo "== rollback"; apply "$REPO/supabase/rollbacks/$M.down.sql"; echo "rollback: OK"
BODY1=$(body)
if [[ "$BODY1" == "$BODY0" ]]; then echo "PASS merge body after rollback is byte-identical to the 20261019220000 body (md5 ${BODY1:0:12})"; else echo "FAIL merge body differs after rollback ($BODY0 -> $BODY1)"; FAILS=$((FAILS+1)); fi
checkfile "$T.rollback.check.sql"
echo "== re-apply after rollback"; apply "$REPO/supabase/migrations/$M.sql"; checkfile "$T.check.sql"
echo "== FAILS=$FAILS"; exit $((FAILS>0))