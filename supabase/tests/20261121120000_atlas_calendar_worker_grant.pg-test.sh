#!/usr/bin/env bash
# #702 GRANT calendar_worker TO latest_update_worker WITH INHERIT TRUE, on a THROWAWAY
# local Postgres 17. Never points at Supabase. Applies every atlas migration before
# 20261121120000 (including #701), seeds one event entity, then:
#   schema snapshot -> up -> down (snapshot must match) -> down again -> up -> up again,
# a plain GRANT is shown to leave inherit_option false and refuse event_releases access
# without SET ROLE, the migration repairs that to inherit_option true, and as
# latest_update_worker with no SET ROLE: select/insert/upsert pass, delete is refused,
# entities id/slug read works, and latest_update_worker's role timeouts stay 60s/5s.
# Needs server binaries (initdb, pg_ctl, postgres) in PG_BIN; psql, createdb and pg_dump come from PATH.
# Usage: PG_BIN=/path/to/pg17/bin bash supabase/tests/20261121120000_atlas_calendar_worker_grant.pg-test.sh
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
TMP=$(mktemp -d /tmp/issue702grant.XXXX); PORT=$((50000 + RANDOM % 10000)); DB=db702g
V=20261121120000_atlas_calendar_worker_grant
UP=$REPO/supabase/migrations/$V.sql
DOWN=$REPO/supabase/rollbacks/$V.down.sql
trap '"$BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
"$BIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
"$BIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null
createdb -h "$TMP" -p $PORT -U postgres "$DB"
export PGOPTIONS='-c client_min_messages=warning'
PSQL=(psql -X -q -h "$TMP" -p $PORT -U postgres -d "$DB" -v ON_ERROR_STOP=1)
PASS=0; REFUSED=0; FAILS=0
ok()  { echo "PASS $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL $1"; FAILS=$((FAILS+1)); }
q()   { "${PSQL[@]}" -t -A -c "$1" 2>/dev/null || echo "QUERY-ERROR"; }
check() { local got; got=$(q "$2"); [[ "$got" == "$3" ]] && ok "$1" || bad "$1 (got '$got', want '$3')"; }
MEMB="select count(*) from pg_auth_members where roleid='calendar_worker'::regrole and member='latest_update_worker'::regrole"
INH="select inherit_option::text from pg_auth_members where roleid='calendar_worker'::regrole and member='latest_update_worker'::regrole"
PRIV="select has_table_privilege('latest_update_worker','atlas.event_releases','select')::text||has_table_privilege('latest_update_worker','atlas.event_releases','insert')::text||has_table_privilege('latest_update_worker','atlas.event_releases','update')::text||has_table_privilege('latest_update_worker','atlas.event_releases','delete')::text"
LU_SET="select array_to_string(array(select unnest(setconfig) order by 1), ',') from pg_db_role_setting where setrole='latest_update_worker'::regrole and setdatabase=0"
CW_SET="select array_to_string(array(select unnest(setconfig) order by 1), ',') from pg_db_role_setting where setrole='calendar_worker'::regrole and setdatabase=0"
dump() { pg_dump -h "$TMP" -p $PORT -U postgres -d "$DB" --schema-only --no-owner -n atlas | grep -v -E '^\\(un)?restrict '; \
  "${PSQL[@]}" -t -A -c "select member::regrole::text, roleid::regrole::text, inherit_option::text, set_option::text, admin_option::text from pg_auth_members where roleid::regrole::text in ('calendar_worker','latest_update_worker') or member::regrole::text in ('calendar_worker','latest_update_worker') order by 1,2"; \
  "${PSQL[@]}" -t -A -c "select setrole::regrole::text, setconfig::text from pg_db_role_setting where setrole <> 0 order by 1"; \
  "${PSQL[@]}" -t -A -c "select grantee, table_name, privilege_type from information_schema.role_table_grants where table_schema='atlas' and grantee in ('calendar_worker','latest_update_worker') order by 1,2,3"; }

"${PSQL[@]}" -c "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;" >/dev/null
for f in $(ls "$REPO"/supabase/migrations/*_atlas*.sql | sort); do
  b=$(basename "$f")
  [[ $b < ${V}.sql ]] || continue
  [[ $b == 20261031200000_atlas_tool_log_14_ahead.sql ]] && continue
  if [[ $b == 20261025100200_atlas_tool_log.sql ]]; then
    "${PSQL[@]}" -c "create table atlas.tool_log (id bigint generated always as identity, logged_at timestamptz not null default now(), run_id text, tool text not null, input jsonb, output jsonb, duration_ms bigint, error text, primary key (logged_at, id)); alter table atlas.tool_log enable row level security;" >/dev/null || { echo "tool_log stand-in failed"; exit 1; }
    continue
  fi
  "${PSQL[@]}" -f "$f" >/dev/null 2>&1 || { echo "apply $b failed"; exit 1; }
done

"${PSQL[@]}" >/dev/null <<'SQL'
insert into atlas.entities (id, slug, name, type, status, summary) values
  ('00000000-0000-7000-8000-0000000000e1', 'us-cpi', 'US CPI', 'event', 'active', 'a summary');
SQL
E1=00000000-0000-7000-8000-0000000000e1
SID=backpack:economic:0123456789abcdef01234567
INS="insert into atlas.event_releases (entity_id, source_event_id, source_title, country, period, release_date, starts_at, unit, actual, estimate, previous) values ('$E1','$SID','Inflation Rate YoY (Oct)','US','Oct','2026-11-13','2026-11-13 13:30:00+00','%',3.0,3.1,2.9)"
UPS="insert into atlas.event_releases (entity_id, source_event_id, source_title, country, period, release_date, starts_at, unit, actual, estimate, previous, fetched_at) values ('$E1','$SID','Inflation Rate YoY (Oct)','US','Oct','2026-11-13','2026-11-13 13:30:00+00','%',3.2,3.1,2.9,now()) on conflict on constraint event_releases_entity_date_title_key do update set actual=excluded.actual, fetched_at=now(), updated_at=now()"

as_lu() { "${PSQL[@]}" -t -A -c "begin; set role latest_update_worker; $1; commit;" >"$TMP/out" 2>"$TMP/err"; }
run_lu() { if as_lu "$2"; then ok "$1"; else bad "$1: $(head -1 "$TMP/err")"; fi; }
refuse_lu() {
  if as_lu "$2"; then bad "$1 (accepted)"
  elif grep -qE "permission denied|row-level security" "$TMP/err"; then echo "REFUSED $1: $(head -1 "$TMP/err")"; REFUSED=$((REFUSED+1))
  else bad "$1 failed oddly: $(head -1 "$TMP/err")"; fi
}

echo "== schema before up =="
LU_SET_BEFORE=$(q "$LU_SET")
CW_SET_BEFORE=$(q "$CW_SET")
dump > "$TMP/before.sql"
echo "snapshot: $(wc -l < "$TMP/before.sql") lines (atlas schema + memberships + role settings + grants)"
check "before: no calendar_worker membership on latest_update_worker" "$MEMB" 0
check "before: latest_update_worker timeouts 60s/5s" "$LU_SET" "lock_timeout=5s,statement_timeout=60s"
check "before: calendar_worker timeouts 60s/5s" "$CW_SET" "lock_timeout=5s,statement_timeout=60s"
check "before: no event_releases privs on latest_update_worker" "$PRIV" "falsefalsefalsefalse"
refuse_lu "before: select event_releases refused" "select count(*) from atlas.event_releases"

echo "== a plain GRANT is not enough (both roles are NOINHERIT) =="
"${PSQL[@]}" -c "grant calendar_worker to latest_update_worker;" >/dev/null && ok "plain GRANT accepted" || bad "plain GRANT"
check "plain GRANT: inherit_option is false" "$INH" false
check "plain GRANT: has_table_privilege still false (no inherit)" "$PRIV" "falsefalsefalsefalse"
refuse_lu "plain GRANT: select event_releases refused (no SET ROLE)" "select count(*) from atlas.event_releases"
refuse_lu "plain GRANT: insert event_releases refused (no SET ROLE)" "$INS"
# The migration must repair this leftover plain GRANT.
echo "== up repairs a leftover plain GRANT, then down / down / up / up =="
"${PSQL[@]}" -f "$UP" >/dev/null && ok "up applied over a plain GRANT" || bad "up over plain GRANT"
check "up: membership exists" "$MEMB" 1
check "up: inherit_option is true (locked in; a plain GRANT is not enough)" "$INH" true
check "up: sel/ins/upd true, delete false" "$PRIV" "truetruetruefalse"
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down applied" || bad "down"
check "down: membership gone" "$MEMB" 0
check "down: has_table_privilege back to false" "$PRIV" "falsefalsefalsefalse"
dump > "$TMP/after_down.sql"
if diff -u "$TMP/before.sql" "$TMP/after_down.sql" > "$TMP/diff.txt"; then ok "schema diff before up vs after down: identical ($(wc -l < "$TMP/before.sql") lines compared)"; else bad "schema differs after down"; head -40 "$TMP/diff.txt"; fi
check "down: fixture entity kept" "select count(*) from atlas.entities" 1
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down rerun (idempotent)" || bad "down rerun"
"${PSQL[@]}" -f "$UP" >/dev/null && ok "up again applied" || bad "up again"
dump > "$TMP/after_up2.sql"
"${PSQL[@]}" -f "$UP" >/dev/null && ok "up rerun (idempotent)" || bad "up rerun"
dump > "$TMP/after_up3.sql"
diff -q "$TMP/after_up2.sql" "$TMP/after_up3.sql" >/dev/null && ok "up rerun changes nothing" || bad "up rerun changed schema"
check "up rerun: still 1 membership, inherit_option true" "select ($MEMB)||','||($INH)" "1,true"

echo "== as latest_update_worker, no SET ROLE =="
run_lu "select event_releases" "select count(*) from atlas.event_releases"
run_lu "insert event_releases" "$INS"
run_lu "upsert/update event_releases" "$UPS"
check "upsert left 1 row, actual 3.2" "select count(*)||','||max(actual) from atlas.event_releases" "1,3.2"
refuse_lu "delete event_releases refused" "delete from atlas.event_releases"
run_lu "entities id, slug read" "select id, slug from atlas.entities where slug='us-cpi' and status='active'"
check "id/slug returned" "begin; set role latest_update_worker; select slug from atlas.entities; commit" "us-cpi"
# Timeouts on the roles themselves must be unchanged by the grant.
check "latest_update_worker timeouts unchanged (still 60s/5s)" "$LU_SET" "$LU_SET_BEFORE"
check "calendar_worker timeouts unchanged (still 60s/5s)" "$CW_SET" "$CW_SET_BEFORE"
# A real login (trust, no password; LOGIN is test-only, not in the migration).
"${PSQL[@]}" -c "alter role latest_update_worker login;" >/dev/null
got=$(psql -X -q -h "$TMP" -p $PORT -U latest_update_worker -d "$DB" -t -A -c "select current_setting('statement_timeout')||','||current_setting('lock_timeout')")
# Postgres prints 60s as 1min at login time.
[[ "$got" == "1min,5s" || "$got" == "60s,5s" ]] && ok "real login timeouts are latest_update_worker's (got $got), not altered" || bad "real login timeouts $got"
if psql -X -q -h "$TMP" -p $PORT -U latest_update_worker -d "$DB" -v ON_ERROR_STOP=1 -c "select count(*) from atlas.event_releases; $UPS" >/dev/null 2>"$TMP/err"; then ok "real login (no SET ROLE) can select and upsert"; else bad "real login failed: $(head -1 "$TMP/err")"; fi
if psql -X -q -h "$TMP" -p $PORT -U latest_update_worker -d "$DB" -c "delete from atlas.event_releases" >/dev/null 2>"$TMP/err"; then bad "real login delete accepted"
elif grep -qE "permission denied|row-level security" "$TMP/err"; then echo "REFUSED real login delete: $(head -1 "$TMP/err")"; REFUSED=$((REFUSED+1))
else bad "real login delete failed oddly: $(head -1 "$TMP/err")"; fi
# latest_update_worker's own grants still work
run_lu "still can select latest_updates (own grant)" "select count(*) from atlas.latest_updates"
refuse_lu "still cannot update entities" "update atlas.entities set name='x'"

echo "== final down after data restores the schema =="
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down after data (revokes membership, keeps rows and roles)" || bad "final down"
# LOGIN we turned on for the real-login check is test-only; put it back so the snapshot matches.
"${PSQL[@]}" -c "alter role latest_update_worker nologin;" >/dev/null
dump > "$TMP/after_final.sql"
diff -q "$TMP/before.sql" "$TMP/after_final.sql" >/dev/null && ok "schema identical to before up after the final down" || { bad "schema differs after final down"; diff -u "$TMP/before.sql" "$TMP/after_final.sql" | head -40; }
check "membership gone after final down" "$MEMB" 0
check "event_releases rows kept (revoke does not delete data)" "select count(*) from atlas.event_releases" 1
check "roles still exist" "select count(*) from pg_roles where rolname in ('calendar_worker','latest_update_worker')" 2
refuse_lu "after final down: select event_releases refused again" "select count(*) from atlas.event_releases"

echo "RESULT: $PASS passed, $REFUSED refused as expected, $FAILS failures"
[[ $FAILS -eq 0 ]]
