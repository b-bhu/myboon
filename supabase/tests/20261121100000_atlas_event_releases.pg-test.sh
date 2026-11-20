#!/usr/bin/env bash
# #701 atlas.event_releases + calendar_worker, on a THROWAWAY local Postgres 17. Never points at Supabase.
# Applies every atlas migration before 20261121100000, seeds a small fixture, then:
#   schema snapshot -> up -> down (snapshot must match) -> down again -> up -> up again,
# role attributes, shape, constraint tests (source, source_event_id, country, period, starts_at vs
# release_date, upsert key, cascade), grants as calendar_worker / service_role / atlas_analyst /
# anon / authenticated, and a final down after data that restores the snapshot.
# Needs server binaries (initdb, pg_ctl, postgres) in PG_BIN; psql, createdb and pg_dump come from PATH.
# Usage: PG_BIN=/path/to/pg17/bin bash supabase/tests/20261121100000_atlas_event_releases.pg-test.sh
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
TMP=$(mktemp -d /tmp/issue701.XXXX); PORT=$((50000 + RANDOM % 10000)); DB=db701
V=20261121100000_atlas_event_releases
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
dump() { pg_dump -h "$TMP" -p $PORT -U postgres -d "$DB" --schema-only --no-owner -n atlas | grep -v -E '^\\(un)?restrict '; \
  "${PSQL[@]}" -t -A -c "select grantee, table_name, column_name, privilege_type from information_schema.column_privileges where table_schema='atlas' and grantee not in ('postgres') order by 1,2,3,4"; \
  "${PSQL[@]}" -t -A -c "select rolname, rolcanlogin, rolinherit, rolconnlimit from pg_roles where rolname like '%worker%' or rolname in ('atlas_analyst','service_role') order by 1"; \
  "${PSQL[@]}" -t -A -c "select setrole::regrole::text, setconfig::text from pg_db_role_setting where setrole <> 0 order by 1"; }

"${PSQL[@]}" -c "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;" >/dev/null
for f in $(ls "$REPO"/supabase/migrations/*_atlas*.sql | sort); do
  b=$(basename "$f")
  [[ $b < $V ]] || continue
  [[ $b == 20261031200000_atlas_tool_log_14_ahead.sql ]] && continue  # needs pg_cron
  if [[ $b == 20261025100200_atlas_tool_log.sql ]]; then
    "${PSQL[@]}" -c "create table atlas.tool_log (id bigint generated always as identity, logged_at timestamptz not null default now(), run_id text, tool text not null, input jsonb, output jsonb, duration_ms bigint, error text, primary key (logged_at, id)); alter table atlas.tool_log enable row level security;" >/dev/null || { echo "tool_log stand-in failed"; exit 1; }
    continue
  fi
  "${PSQL[@]}" -f "$f" >/dev/null 2>&1 || { echo "apply $b failed"; exit 1; }
done

# Fixture: 3 entities shaped like prod's event entities (e3 is used for the cascade test).
"${PSQL[@]}" >/dev/null <<'SQL'
insert into atlas.entities (id, slug, name, type, status) values
  ('00000000-0000-7000-8000-0000000000e1', 'us-cpi', 'US CPI', 'event', 'active'),
  ('00000000-0000-7000-8000-0000000000e2', 'us-ppi', 'US PPI', 'event', 'active'),
  ('00000000-0000-7000-8000-0000000000e3', 'us-gdp', 'US GDP', 'event', 'active');
SQL
E1=00000000-0000-7000-8000-0000000000e1; E2=00000000-0000-7000-8000-0000000000e2; E3=00000000-0000-7000-8000-0000000000e3

TABLE="select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='atlas' and c.relname='event_releases'"
ROLE="select count(*) from pg_roles where rolname='calendar_worker'"
POL="select count(*) from pg_policies where schemaname='atlas' and (tablename='event_releases' or policyname like 'calendar_worker_%')"

echo "== schema before up =="
dump > "$TMP/before.sql"
echo "snapshot: $(wc -l < "$TMP/before.sql") lines (atlas schema-only dump + column grants + roles + role settings)"
check "before: no event_releases table" "$TABLE" 0
check "before: no calendar_worker role" "$ROLE" 0
ENT_COLS=$(q "select count(*) from information_schema.columns where table_schema='atlas' and table_name='entities'")

echo "== up / down / down / up / up =="
"${PSQL[@]}" -f "$UP" >/dev/null && ok "up applied" || bad "up"
check "up: table exists" "$TABLE" 1
check "up: role exists" "$ROLE" 1
check "up: atlas.entities still has $ENT_COLS columns (no change)" "select count(*) from information_schema.columns where table_schema='atlas' and table_name='entities'" "$ENT_COLS"
check "up: 6 policies (5 on event_releases + calendar_worker_select on entities)" "$POL" 6
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down applied" || bad "down"
check "down: table gone" "$TABLE" 0
check "down: role gone" "$ROLE" 0
check "down: 0 policies" "$POL" 0
dump > "$TMP/after_down.sql"
if diff -u "$TMP/before.sql" "$TMP/after_down.sql" > "$TMP/diff.txt"; then ok "schema diff before up vs after down: identical ($(wc -l < "$TMP/before.sql") lines compared)"; else bad "schema differs after down"; head -40 "$TMP/diff.txt"; fi
check "down: fixture entities kept" "select count(*) from atlas.entities" 3
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down rerun (idempotent)" || bad "down rerun"
"${PSQL[@]}" -f "$UP" >/dev/null && ok "up again applied" || bad "up again"
dump > "$TMP/after_up2.sql"
"${PSQL[@]}" -f "$UP" >/dev/null && ok "up rerun (idempotent)" || bad "up rerun"
dump > "$TMP/after_up3.sql"
diff -q "$TMP/after_up2.sql" "$TMP/after_up3.sql" >/dev/null && ok "up rerun changes nothing" || bad "up rerun changed schema"
check "up rerun: still 1 table, 1 role, 6 policies" "select ($TABLE)||','||($ROLE)||','||($POL)" "1,1,6"

echo "== role attributes =="
check "nologin noinherit, no bypassrls, not super, no createrole/createdb" "select rolcanlogin::text||rolinherit::text||rolbypassrls::text||rolsuper::text||rolcreaterole::text||rolcreatedb::text from pg_roles where rolname='calendar_worker'" falsefalsefalsefalsefalsefalse
check "no password set" "select (rolpassword is null)::text from pg_authid where rolname='calendar_worker'" true
check "connection limit 2" "select rolconnlimit from pg_roles where rolname='calendar_worker'" 2
check "role timeouts set" "select array_to_string(array(select unnest(setconfig) order by 1), ',') from pg_db_role_setting where setrole='calendar_worker'::regrole and setdatabase=0" "lock_timeout=5s,statement_timeout=60s"
check "schema usage + uuidv7 execute" "select has_schema_privilege('calendar_worker','atlas','usage')::text||has_function_privilege('calendar_worker','atlas.uuidv7()','execute')::text" truetrue
check "no create on schema atlas" "select has_schema_privilege('calendar_worker','atlas','create')::text" false

echo "== shape =="
check "columns exactly" "select string_agg(column_name||':'||data_type||':'||is_nullable, ' ' order by ordinal_position) from information_schema.columns where table_schema='atlas' and table_name='event_releases'" "id:uuid:NO entity_id:uuid:NO source:text:NO source_event_id:text:NO source_title:text:NO country:text:NO period:text:YES release_date:date:NO starts_at:timestamp with time zone:YES unit:text:YES actual:double precision:YES estimate:double precision:YES previous:double precision:YES fetched_at:timestamp with time zone:NO created_at:timestamp with time zone:NO updated_at:timestamp with time zone:NO"
check "defaults" "select string_agg(column_name||'='||column_default, ' ' order by ordinal_position) from information_schema.columns where table_schema='atlas' and table_name='event_releases' and column_default is not null" "id=atlas.uuidv7() source='backpack'::text fetched_at=now() created_at=now() updated_at=now()"
check "upsert key unique (entity_id, release_date, source_title)" "select pg_get_constraintdef(oid) from pg_constraint where conname='event_releases_entity_date_title_key'" "UNIQUE (entity_id, release_date, source_title)"
check "source_event_id is not unique (no other unique index)" "select count(*) from pg_index where indrelid='atlas.event_releases'::regclass and indisunique" 2
check "only 2 indexes (pkey + upsert key)" "select count(*) from pg_indexes where schemaname='atlas' and tablename='event_releases'" 2
check "fk to entities on delete cascade" "select string_agg(confdeltype::text, ',') from pg_constraint where conrelid='atlas.event_releases'::regclass and contype='f'" "c"
check "6 check constraints" "select count(*) from pg_constraint where conrelid='atlas.event_releases'::regclass and contype='c'" 6
check "RLS on, not forced" "select relrowsecurity::text||relforcerowsecurity::text from pg_class where oid='atlas.event_releases'::regclass" "truefalse"
check "no triggers on event_releases" "select count(*) from pg_trigger where tgrelid='atlas.event_releases'::regclass and not tgisinternal" 0
check "atlas.entities columns unchanged by up" "select count(*) from information_schema.columns where table_schema='atlas' and table_name='entities'" "$ENT_COLS"

echo "== policies (table, name, cmd, roles) =="
"${PSQL[@]}" -t -A -F ' | ' -c "select tablename, policyname, cmd, roles::text from pg_policies where schemaname='atlas' and (tablename='event_releases' or policyname like 'calendar_worker_%') order by tablename, policyname"
check "policies exactly" "select string_agg(tablename||'.'||policyname||':'||cmd||':'||roles::text, ' ' order by tablename, policyname) from pg_policies where schemaname='atlas' and (tablename='event_releases' or policyname like 'calendar_worker_%')" "entities.calendar_worker_select:SELECT:{calendar_worker} event_releases.analyst_read:SELECT:{atlas_analyst} event_releases.calendar_worker_insert:INSERT:{calendar_worker} event_releases.calendar_worker_select:SELECT:{calendar_worker} event_releases.calendar_worker_update:UPDATE:{calendar_worker} event_releases.service_role_select:SELECT:{service_role}"

echo "== grants =="
check "table grants on event_releases exactly" "select string_agg(grantee||':'||p, ' ' order by grantee) from (select grantee, string_agg(privilege_type, ',' order by privilege_type) p from information_schema.role_table_grants where table_schema='atlas' and table_name='event_releases' and grantee <> 'postgres' group by grantee) s" "atlas_analyst:SELECT calendar_worker:INSERT,SELECT,UPDATE service_role:SELECT"
check "calendar_worker table-level grants: only event_releases" "select string_agg(table_name||':'||privilege_type, ' ' order by table_name, privilege_type) from information_schema.role_table_grants where grantee='calendar_worker'" "event_releases:INSERT event_releases:SELECT event_releases:UPDATE"
check "calendar_worker column grants on entities: select id, slug, status" "select string_agg(column_name||':'||privilege_type, ' ' order by column_name) from information_schema.column_privileges where grantee='calendar_worker' and table_name='entities'" "id:SELECT slug:SELECT status:SELECT"
check "calendar_worker: nothing on any other atlas table" "select count(*) from information_schema.column_privileges where grantee='calendar_worker' and table_name not in ('entities','event_releases')" 0
check "anon / authenticated / public: no access" "select has_table_privilege('anon','atlas.event_releases','select')::text||has_table_privilege('authenticated','atlas.event_releases','select')::text||has_table_privilege('public','atlas.event_releases','select')::text" falsefalsefalse

run() { if "${PSQL[@]}" -t -A -c "begin; set role $2; $3; commit;" >"$TMP/out" 2>"$TMP/err"; then ok "$1"; else bad "$1: $(head -1 "$TMP/err")"; fi; }
refuse() {
  if "${PSQL[@]}" -c "begin; set role $2; $3; commit;" >/dev/null 2>"$TMP/err"; then bad "$1 (accepted)"
  elif grep -qE "permission denied|row-level security" "$TMP/err"; then echo "REFUSED $1: $(head -1 "$TMP/err")"; REFUSED=$((REFUSED+1))
  else bad "$1 failed oddly: $(head -1 "$TMP/err")"; fi
}
# Refused by a constraint (as postgres, so grants are not what stops it).
cons() {
  if "${PSQL[@]}" -c "$2" >/dev/null 2>"$TMP/err"; then bad "$1 (accepted)"
  elif grep -q "$3" "$TMP/err"; then echo "REFUSED $1: $(head -1 "$TMP/err")"; REFUSED=$((REFUSED+1))
  else bad "$1 failed oddly: $(head -1 "$TMP/err")"; fi
}
SID="backpack:economic:0123456789abcdef01234567"
INS="insert into atlas.event_releases (entity_id, source, source_event_id, source_title, country, period, release_date, starts_at, unit, actual, estimate, previous) values"
row() { echo "('$1','${2:-backpack}','${3:-$SID}','${4:-Inflation Rate YoY (Oct)}','${5:-US}',${6:-'Oct'},'${7:-2026-11-13}',${8:-'2026-11-13 13:30:00+00'},'%',3.0,3.1,2.9)"; }

echo "== constraint tests (as postgres) =="
"${PSQL[@]}" -c "$INS $(row $E1)" >/dev/null && ok "full valid row accepted" || bad "full valid row: $(q "$INS $(row $E1)")"
check "source defaults to backpack; fetched/created/updated_at filled; actual stored" "select (select column_default from information_schema.columns where table_schema='atlas' and table_name='event_releases' and column_name='source')||','||bool_and(fetched_at is not null and created_at is not null and updated_at is not null)::text||','||max(actual) from atlas.event_releases" "'backpack'::text,true,3"
cons "source 'other' rejected"                "$INS $(row $E1 other '' 'T1')" "event_releases_source_check"
cons "source_event_id backpack:earnings:… rejected" "$INS $(row $E1 backpack 'backpack:earnings:0123456789abcdef01234567' 'T2')" "event_releases_source_event_id_check"
cons "source_event_id with uppercase hex rejected" "$INS $(row $E1 backpack 'backpack:economic:0123456789ABCDEF01234567' 'T3')" "event_releases_source_event_id_check"
cons "empty source_title rejected"            "insert into atlas.event_releases (entity_id, source_event_id, source_title, country, release_date) values ('$E1','$SID','','US','2026-11-13')" "event_releases_source_title_check"
cons "source_title over 200 chars rejected"   "insert into atlas.event_releases (entity_id, source_event_id, source_title, country, release_date) values ('$E1','$SID',repeat('a',201),'US','2026-11-13')" "event_releases_source_title_check"
cons "country 'usa' rejected"                 "$INS $(row $E1 backpack '' 'T4' usa)" "event_releases_country_check"
cons "period 'October' rejected"              "$INS $(row $E1 backpack '' 'T5' US "'October'")" "event_releases_period_check"
"${PSQL[@]}" -c "$INS $(row $E1 backpack '' 'T6' US "'Oct'")" >/dev/null && ok "period 'Oct' accepted" || bad "period Oct"
"${PSQL[@]}" -c "$INS $(row $E1 backpack '' 'T7' US "'Q3'")" >/dev/null && ok "period 'Q3' accepted" || bad "period Q3"
"${PSQL[@]}" -c "$INS $(row $E1 backpack '' 'T8' US null)" >/dev/null && ok "period null accepted" || bad "period null"
cons "period 'Q5' rejected"                   "$INS $(row $E1 backpack '' 'T9' US "'Q5'")" "event_releases_period_check"
cons "starts_at on a different UTC day rejected" "$INS $(row $E1 backpack '' 'T10' US "'Oct'" 2026-11-13 "'2026-11-14 00:30:00+00'")" "event_releases_starts_at_date_check"
"${PSQL[@]}" -c "$INS $(row $E1 backpack '' 'T11' US "'Oct'" 2026-11-13 "'2026-11-13 20:00:00-05'")" >/dev/null 2>"$TMP/err" && bad "starts_at 2026-11-13 20:00 -05 (= Nov 14 01:00 UTC) accepted" || { grep -q event_releases_starts_at_date_check "$TMP/err" && echo "REFUSED starts_at whose UTC date differs (local Nov 13 20:00 -05 = Nov 14 UTC)" && REFUSED=$((REFUSED+1)) || bad "T11 oddly"; }
"${PSQL[@]}" -c "$INS $(row $E1 backpack '' 'T12' US "'Oct'" 2026-11-13 null)" >/dev/null && ok "null starts_at accepted" || bad "null starts_at"
cons "same entity, date and title twice rejected" "$INS $(row $E1)" "event_releases_entity_date_title_key"
"${PSQL[@]}" -c "$INS $(row $E2 backpack '' 'PPI MoM (Oct)' US "'Oct'" 2026-01-14 null), $(row $E2 backpack '' 'PPI MoM (Nov)' US "'Nov'" 2026-01-14 null)" >/dev/null && ok "same entity and date, different titles accepted (PPI Oct + Nov on Jan 14)" || bad "two PPI prints"
"${PSQL[@]}" -c "$INS $(row $E2 backpack "$SID" 'PPI YoY (Oct)' US "'Oct'" 2026-01-14 null)" >/dev/null && ok "repeated source_event_id accepted (not unique)" || bad "repeated source_event_id"
cons "missing source_event_id rejected" "insert into atlas.event_releases (entity_id, source_title, country, release_date) values ('$E1','x','US','2026-11-13')" "null value in column \"source_event_id\""
cons "unknown entity rejected (fk)" "$INS $(row 00000000-0000-7000-8000-0000000000ff)" "event_releases_entity_id_fkey"
"${PSQL[@]}" -c "$INS $(row $E3 backpack '' 'GDP Growth Rate QoQ Adv (Q3)' US "'Q3'" 2026-10-30 null), $(row $E3 backpack '' 'GDP Growth Rate QoQ 2nd Est (Q3)' US "'Q3'" 2026-11-26 null)" >/dev/null && ok "two releases for e3" || bad "e3 rows"
"${PSQL[@]}" -c "delete from atlas.entities where id='$E3'" >/dev/null && ok "deleting entity e3 works" || bad "delete e3"
check "cascade removed e3's releases" "select count(*) from atlas.event_releases where entity_id='$E3'" 0

echo "== read path uses the upsert key (\"last 3 before date D\") =="
"${PSQL[@]}" -c "set enable_seqscan=off; explain select release_date, actual from atlas.event_releases where entity_id='$E1' and release_date < '2026-12-01' order by release_date desc limit 3" > "$TMP/plan" 2>&1
grep -q "event_releases_entity_date_title_key" "$TMP/plan" && ok "plan uses event_releases_entity_date_title_key (backward scan, no sort)" || { bad "plan does not use upsert key"; cat "$TMP/plan"; }

echo "== calendar_worker =="
CW=calendar_worker
run "calendar_worker select event_releases" $CW "select count(*) from atlas.event_releases"
run "calendar_worker insert (id from uuidv7)" $CW "$INS $(row $E1 backpack '' 'Core Inflation Rate YoY (Oct)')"
run "calendar_worker upsert on the key (fills actual, bumps updated_at)" $CW "$INS ('$E1','backpack','$SID','Inflation Rate YoY (Oct)','US','Oct','2026-11-13','2026-11-13 13:30:00+00','%',3.2,3.1,2.9) on conflict on constraint event_releases_entity_date_title_key do update set actual=excluded.actual, estimate=excluded.estimate, previous=excluded.previous, fetched_at=now(), updated_at=now()"
check "upsert updated the existing row (actual 3.2, still 1 row)" "select count(*)||','||max(actual) from atlas.event_releases where entity_id='$E1' and release_date='2026-11-13' and source_title='Inflation Rate YoY (Oct)'" "1,3.2"
run "calendar_worker plain update" $CW "update atlas.event_releases set unit='%' where entity_id='$E1'"
refuse "calendar_worker delete refused" $CW "delete from atlas.event_releases"
refuse "calendar_worker truncate refused" $CW "truncate atlas.event_releases"
run "calendar_worker select id, slug, status on entities" $CW "select id, slug, status from atlas.entities where slug in ('us-cpi','us-ppi') and status='active'"
check "calendar_worker sees both remaining event entities" "begin; set role $CW; select string_agg(slug, ',' order by slug) from atlas.entities; commit" "us-cpi,us-ppi"
refuse "calendar_worker select entities.summary refused" $CW "select summary from atlas.entities"
refuse "calendar_worker select * on entities refused"   $CW "select * from atlas.entities"
refuse "calendar_worker insert entities refused"        $CW "insert into atlas.entities (slug, name, type) values ('x','x','event')"
refuse "calendar_worker update entities refused"        $CW "update atlas.entities set status='active'"
refuse "calendar_worker delete entities refused"        $CW "delete from atlas.entities"
refuse "calendar_worker read entity_items refused"      $CW "select count(*) from atlas.entity_items"
refuse "calendar_worker read entity_markets refused"    $CW "select count(*) from atlas.entity_markets"
refuse "calendar_worker create table in atlas refused"  $CW "create table atlas.calendar_evil (a int)"

echo "== service_role / atlas_analyst / anon / authenticated =="
for r in service_role atlas_analyst; do
  run "$r select event_releases" $r "select count(*) from atlas.event_releases"
  refuse "$r insert event_releases" $r "$INS $(row $E1 backpack '' "$r-x")"
  refuse "$r update event_releases" $r "update atlas.event_releases set actual=0"
  refuse "$r delete event_releases" $r "delete from atlas.event_releases"
done
for r in anon authenticated; do
  refuse "$r select event_releases" $r "select count(*) from atlas.event_releases"
done

echo "== final down after data restores the schema =="
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down after data (drops releases, table, role)" || bad "final down"
dump > "$TMP/after_final.sql"
diff -q "$TMP/before.sql" "$TMP/after_final.sql" >/dev/null && ok "schema identical to before up after the final down" || bad "schema differs after final down"
check "entities kept after final down" "select count(*) from atlas.entities" 2

echo "RESULT: $PASS passed, $REFUSED refused as expected, $FAILS failures"
[[ $FAILS -eq 0 ]]
