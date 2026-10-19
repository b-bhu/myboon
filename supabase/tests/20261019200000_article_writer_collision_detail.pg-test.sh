#!/usr/bin/env bash
# #378: apply every repo migration (so 20261017120000 #368 and 20261017180000
# #341 Part B come before 20261019200000) to a THROWAWAY local Postgres 17,
# force duplicate collisions through article_writer_v1, then run the down file.
# Never points at Supabase; never runs `supabase db push` (#397).
# Usage: bash supabase/tests/20261019200000_article_writer_collision_detail.pg-test.sh
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
TMP=$(mktemp -d /tmp/pg378.XXXX); PORT=${PG_TEST_PORT:-55378}
trap '"$BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
"$BIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
"$BIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null
PSQL=(psql -X -q -h "$TMP" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1)
T=$REPO/supabase/tests/20261019200000_article_writer_collision_detail; FAILS=0

"${PSQL[@]}" -c "CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE ROLE authenticator NOINHERIT LOGIN; GRANT anon, authenticated, service_role TO authenticator;
  CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto SCHEMA extensions; CREATE EXTENSION \"uuid-ossp\" SCHEMA extensions;"
apply() { PGOPTIONS='-c client_min_messages=error' "${PSQL[@]}" -1 -f "$1" >/dev/null 2>"$TMP/m.err" || { cat "$TMP/m.err"; echo "FAIL apply $(basename "$1")"; exit 1; }; }
collide() {
  if "${PSQL[@]}" -v mode="$1" -f "$T.collision.sql" >"$TMP/c.out" 2>&1; then grep -o 'check 378.*' "$TMP/c.out"; else grep -v '^$' "$TMP/c.out" | tail -5; echo "FAIL collision ($1)"; FAILS=$((FAILS+1)); fi
}
checkfile() {
  local out; out=$("${PSQL[@]}" -t -A -F'|' -f "$1"); echo "$out"
  if echo "$out" | grep -q '|f$'; then echo "FAIL $(basename "$1")"; FAILS=$((FAILS+1)); else echo "PASS $(basename "$1")"; fi
}

count=0
for m in "$REPO"/supabase/migrations/*.sql; do
  [[ $(basename "$m") == 20261019200000_* ]] && continue
  apply "$m"; count=$((count + 1))
done
echo "migrations applied before #378: $count (last: $(ls "$REPO"/supabase/migrations/*.sql | grep -v 20261019200000_ | tail -1 | xargs basename))"
echo "== baseline (pre-#378 writer)"
collide rollback
BODY0=$("${PSQL[@]}" -t -A -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='managed_knowledge_private.article_writer_v1(text,jsonb)'::regprocedure")
echo "== apply 20261019200000 (single transaction)"
apply "$REPO/supabase/migrations/20261019200000_article_writer_collision_detail.sql"; echo "migration: OK"
echo "== apply it again (idempotent CREATE OR REPLACE)"
apply "$REPO/supabase/migrations/20261019200000_article_writer_collision_detail.sql"; echo "re-apply: OK"
checkfile "$T.check.sql"
collide forward
echo "== #341 Part B check still passes on the new body"
if "${PSQL[@]}" -f "$REPO/supabase/tests/20261017180000_entity_summary_article_refresh.check.sql" >"$TMP/341.out" 2>&1; then echo "PASS 20261017180000 check"; else tail -5 "$TMP/341.out"; echo "FAIL 20261017180000 check"; FAILS=$((FAILS+1)); fi
echo "== rollback"
apply "$REPO/supabase/rollbacks/20261019200000_article_writer_collision_detail.down.sql"; echo "rollback: OK"
checkfile "$T.rollback.check.sql"
collide rollback
BODY1=$("${PSQL[@]}" -t -A -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='managed_knowledge_private.article_writer_v1(text,jsonb)'::regprocedure")
if [[ "$BODY1" == "$BODY0" ]]; then echo "PASS writer body after rollback is byte-identical to the 20261017180000 body (md5 ${BODY1:0:12})"; else echo "FAIL writer body differs after rollback"; FAILS=$((FAILS+1)); fi
echo "== FAILS=$FAILS"; exit $((FAILS>0))
