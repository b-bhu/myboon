#!/usr/bin/env bash
# #342 PR-4 A: apply every repo migration BEFORE 20261019230000 (including
# 20261019220000, now replayed from supabase/tests/fixtures), seed legacy-type rows, then apply the kind migration and run
# its checks, behaviour cases and the down file - on a THROWAWAY local
# Postgres 17. Later migrations (e.g. 20261019231000) are NOT applied, so this
# exercises the migration standalone. Never points at Supabase; never runs
# `supabase db push` (#397).
# Usage: bash supabase/tests/20261019230000_entity_kind_v1.pg-test.sh
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
TMP=$(mktemp -d /tmp/pg342k.XXXX); PORT=${PG_TEST_PORT:-55351}
trap '"$BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
"$BIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
"$BIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null
PSQL=(psql -X -q -h "$TMP" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1)
M=20261019230000_entity_kind_v1; T=$REPO/supabase/tests/$M; FAILS=0
"${PSQL[@]}" -c "CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE ROLE authenticator NOINHERIT LOGIN; GRANT anon, authenticated, service_role TO authenticator;
  CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto SCHEMA extensions; CREATE EXTENSION \"uuid-ossp\" SCHEMA extensions;"
apply() { PGOPTIONS='-c client_min_messages=error' "${PSQL[@]}" -1 -f "$1" >/dev/null 2>"$TMP/m.err" || { cat "$TMP/m.err"; echo "FAIL apply $(basename "$1")"; exit 1; }; }
checkfile() {
  local out; out=$("${PSQL[@]}" -t -A -F'|' -f "$1" 2>&1) || { echo "$out"; echo "FAIL $(basename "$1")"; FAILS=$((FAILS+1)); return; }
  echo "$out"
  if echo "$out" | grep -qE '[|](f|false)$'; then echo "FAIL $(basename "$1")"; FAILS=$((FAILS+1)); else echo "PASS $(basename "$1")"; fi
}
count=0
for m in "$REPO"/supabase/migrations/*.sql; do
  # Only migrations strictly before the kind migration: it must still apply on
  # the state they leave behind, and nothing after it may be required.
  [[ $(basename "$m") < ${M}.sql ]] || continue
  # #549: 20261019220000 was deleted from migrations; replay its fixture at the old slot.
  if [[ -z ${PRIOR342:-} && $(basename "$m") > 20261019220000 ]]; then apply "$REPO/supabase/tests/fixtures/20261019220000_merge_entities_v1.prior-state.sql"; PRIOR342=1; fi
  apply "$m"; count=$((count + 1))
done
[[ -n ${PRIOR342:-} ]] || apply "$REPO/supabase/tests/fixtures/20261019220000_merge_entities_v1.prior-state.sql"
echo "migrations applied before $M: $count"
echo "== preseed legacy-type rows (committed BEFORE the migration)"
apply "$T.preseed.sql"; echo "preseed: OK"
echo "== apply $M (single transaction)"; apply "$REPO/supabase/migrations/$M.sql"; echo "migration: OK"
echo "== re-apply (idempotent)"; apply "$REPO/supabase/migrations/$M.sql"; echo "re-apply: OK"
checkfile "$T.check.sql"
checkfile "$T.behaviour.sql"
echo "== rollback"; apply "$REPO/supabase/rollbacks/$M.down.sql"; echo "rollback: OK"
checkfile "$T.rollback.check.sql"
echo "== re-apply after rollback"; apply "$REPO/supabase/migrations/$M.sql"; checkfile "$T.check.sql"
echo "== FAILS=$FAILS"; exit $((FAILS>0))