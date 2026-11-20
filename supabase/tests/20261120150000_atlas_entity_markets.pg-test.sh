#!/usr/bin/env bash
# #683 atlas.entity_markets + atlas.entities.markets_checked_at, on a THROWAWAY local Postgres 17.
# Never points at Supabase. Applies every atlas migration before 20261120150000, seeds a small
# fixture, then:
#   schema snapshot -> up -> down (snapshot must match) -> down again -> up -> up again,
# constraint tests (rank 1..3, unique (entity, rank) and (entity, symbol), symbol format, set_by,
# reason, pinned default, cascade), grants as entity_worker / service_role / atlas_analyst /
# anon / authenticated, and a final down after data that restores the snapshot.
# Needs server binaries (initdb, pg_ctl, postgres) in PG_BIN; psql, createdb and pg_dump come from PATH.
# Usage: PG_BIN=/path/to/pg17/bin bash supabase/tests/20261120150000_atlas_entity_markets.pg-test.sh
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
TMP=$(mktemp -d /tmp/issue683.XXXX); PORT=$((50000 + RANDOM % 10000)); DB=db683
V=20261120150000_atlas_entity_markets
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
  "${PSQL[@]}" -t -A -c "select grantee, table_name, column_name, privilege_type from information_schema.column_privileges where table_schema='atlas' and grantee in ('entity_worker','service_role','atlas_analyst','anon','authenticated') order by 1,2,3,4"; }

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

# Fixture: 3 entities (e3 is used for the cascade test).
"${PSQL[@]}" >/dev/null <<'SQL'
insert into atlas.entities (id, slug, name, type) values
  ('00000000-0000-7000-8000-0000000000e1', 'us-iran-conflict', 'US-Iran conflict', 'topic'),
  ('00000000-0000-7000-8000-0000000000e2', 'bitcoin', 'Bitcoin', 'asset'),
  ('00000000-0000-7000-8000-0000000000e3', 'e-three', 'Entity Three', 'organization');
SQL
E1=00000000-0000-7000-8000-0000000000e1; E2=00000000-0000-7000-8000-0000000000e2; E3=00000000-0000-7000-8000-0000000000e3

TABLE="select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='atlas' and c.relname='entity_markets'"
COL="select count(*) from information_schema.columns where table_schema='atlas' and table_name='entities' and column_name='markets_checked_at'"
POL="select count(*) from pg_policies where schemaname='atlas' and tablename='entity_markets'"
COLGRANTS="select count(*) from information_schema.column_privileges where table_schema='atlas' and table_name='entities' and column_name='markets_checked_at' and grantee='entity_worker'"

echo "== schema before up =="
dump > "$TMP/before.sql"
echo "snapshot: $(wc -l < "$TMP/before.sql") lines (atlas schema-only dump + column grants)"
check "before: no entity_markets table" "$TABLE" 0
check "before: no markets_checked_at column" "$COL" 0

echo "== up / down / down / up / up =="
"${PSQL[@]}" -f "$UP" >/dev/null && ok "up applied" || bad "up"
check "up: table exists" "$TABLE" 1
check "up: column exists" "$COL" 1
check "up: 6 policies on entity_markets" "$POL" 6
check "up: entity_worker select+update on markets_checked_at" "$COLGRANTS" 2
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down applied" || bad "down"
check "down: table gone" "$TABLE" 0
check "down: column gone" "$COL" 0
check "down: 0 policies on entity_markets" "$POL" 0
dump > "$TMP/after_down.sql"
if diff -u "$TMP/before.sql" "$TMP/after_down.sql" > "$TMP/diff.txt"; then ok "schema diff before up vs after down: identical ($(wc -l < "$TMP/before.sql") lines compared)"; else bad "schema differs after down"; head -40 "$TMP/diff.txt"; fi
check "down: fixture entities kept" "select count(*) from atlas.entities" 3
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down rerun (idempotent)" || bad "down rerun"
"${PSQL[@]}" -f "$UP" >/dev/null && ok "up again applied" || bad "up again"
dump > "$TMP/after_up2.sql"
"${PSQL[@]}" -f "$UP" >/dev/null && ok "up rerun (idempotent)" || bad "up rerun"
dump > "$TMP/after_up3.sql"
diff -q "$TMP/after_up2.sql" "$TMP/after_up3.sql" >/dev/null && ok "up rerun changes nothing" || bad "up rerun changed schema"

echo "== shape =="
check "existing entities read markets_checked_at null" "select count(*)||'/'||count(*) filter (where markets_checked_at is null) from atlas.entities" "3/3"
check "markets_checked_at is timestamptz, nullable, no default" "select data_type||','||is_nullable||','||coalesce(column_default,'none') from information_schema.columns where table_schema='atlas' and table_name='entities' and column_name='markets_checked_at'" "timestamp with time zone,YES,none"
check "columns exactly" "select string_agg(column_name||':'||data_type||':'||is_nullable, ' ' order by ordinal_position) from information_schema.columns where table_schema='atlas' and table_name='entity_markets'" "id:uuid:NO entity_id:uuid:NO rank:smallint:NO symbol:text:NO set_by:text:NO pinned:boolean:NO reason:text:YES set_at:timestamp with time zone:NO"
check "id default atlas.uuidv7()" "select column_default from information_schema.columns where table_schema='atlas' and table_name='entity_markets' and column_name='id'" "atlas.uuidv7()"
check "unique (entity_id, rank)" "select pg_get_constraintdef(oid) from pg_constraint where conname='entity_markets_entity_rank_key'" "UNIQUE (entity_id, rank)"
check "unique (entity_id, symbol)" "select pg_get_constraintdef(oid) from pg_constraint where conname='entity_markets_entity_symbol_key'" "UNIQUE (entity_id, symbol)"
check "fk to entities on delete cascade" "select string_agg(confdeltype::text, ',') from pg_constraint where conrelid='atlas.entity_markets'::regclass and contype='f'" "c"
check "index entity_markets_symbol_idx on (symbol)" "select count(*) from pg_indexes where indexname='entity_markets_symbol_idx' and indexdef like '%(symbol)'" 1
check "RLS on, not forced" "select relrowsecurity::text||relforcerowsecurity::text from pg_class where oid='atlas.entity_markets'::regclass" "truefalse"
check "no triggers on entity_markets" "select count(*) from pg_trigger where tgrelid='atlas.entity_markets'::regclass and not tgisinternal" 0

echo "== policies (name, cmd, roles) =="
"${PSQL[@]}" -t -A -F ' | ' -c "select policyname, cmd, roles::text from pg_policies where schemaname='atlas' and tablename='entity_markets' order by policyname"
check "policies exactly" "select string_agg(policyname||':'||cmd||':'||roles::text, ' ' order by policyname) from pg_policies where schemaname='atlas' and tablename='entity_markets'" "analyst_read:SELECT:{atlas_analyst} entity_worker_delete:DELETE:{entity_worker} entity_worker_insert:INSERT:{entity_worker} entity_worker_select:SELECT:{entity_worker} entity_worker_update:UPDATE:{entity_worker} service_role_select:SELECT:{service_role}"

echo "== grants =="
check "table grants on entity_markets exactly" "select string_agg(grantee||':'||p, ' ' order by grantee) from (select grantee, string_agg(privilege_type, ',' order by privilege_type) p from information_schema.role_table_grants where table_schema='atlas' and table_name='entity_markets' and grantee <> 'postgres' group by grantee) s" "atlas_analyst:SELECT entity_worker:DELETE,INSERT,SELECT,UPDATE service_role:SELECT"
check "entity_worker column grants on markets_checked_at" "select string_agg(privilege_type, ',' order by privilege_type) from information_schema.column_privileges where table_schema='atlas' and table_name='entities' and column_name='markets_checked_at' and grantee='entity_worker'" "SELECT,UPDATE"
check "entity_worker still has no update on entities.summary" "select has_column_privilege('entity_worker','atlas.entities','summary','update')::text" false
check "anon / authenticated: no access" "select has_table_privilege('anon','atlas.entity_markets','select')::text||has_table_privilege('authenticated','atlas.entity_markets','select')::text" falsefalse

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
INS="insert into atlas.entity_markets (entity_id, rank, symbol, set_by, reason) values"

echo "== constraint tests (as postgres) =="
"${PSQL[@]}" -c "$INS ('$E1',1,'xyz:CL','model','Oil moves on the conflict'), ('$E1',2,'BTC','model',null), ('$E1',3,'kPEPE','manual','ok')" >/dev/null && ok "ranks 1-3 with xyz:CL, BTC, kPEPE accepted" || bad "ranks 1-3"
check "pinned defaults to false, set_at filled" "select bool_and(not pinned)::text||','||bool_and(set_at is not null)::text from atlas.entity_markets" "true,true"
cons "rank 0 rejected"                         "$INS ('$E2',0,'BTC','model',null)" "entity_markets_rank_check"
cons "rank 4 rejected (no 4th market)"         "$INS ('$E1',4,'ETH','model',null)" "entity_markets_rank_check"
cons "second rank 1 for same entity rejected"  "$INS ('$E1',1,'ETH','model',null)" "entity_markets_entity_rank_key"
"${PSQL[@]}" -c "delete from atlas.entity_markets where entity_id='$E1' and rank=3" >/dev/null
cons "same symbol twice for one entity rejected" "$INS ('$E1',3,'BTC','model',null)" "entity_markets_entity_symbol_key"
"${PSQL[@]}" -c "$INS ('$E2',1,'BTC','model',null)" >/dev/null && ok "same symbol on a different entity accepted" || bad "BTC on e2"
cons "symbol 'xyz:' rejected"     "$INS ('$E2',2,'xyz:','model',null)"     "entity_markets_symbol_check"
cons "symbol 'BTC-PERP' rejected" "$INS ('$E2',2,'BTC-PERP','model',null)" "entity_markets_symbol_check"
cons "symbol 'cl oil' rejected"   "$INS ('$E2',2,'cl oil','model',null)"   "entity_markets_symbol_check"
cons "symbol over 24 chars rejected" "$INS ('$E2',2,'ABCDEFGHIJKLMNOPQRSTUVWXY','model',null)" "entity_markets_symbol_check"
cons "set_by 'llm' rejected"      "$INS ('$E2',2,'ETH','llm',null)"        "entity_markets_set_by_check"
cons "reason with a newline rejected" "$INS ('$E2',2,'ETH','model',E'line one\nline two')" "entity_markets_reason_check"
cons "reason over 200 chars rejected" "$INS ('$E2',2,'ETH','model',repeat('a',201))" "entity_markets_reason_check"
cons "empty reason rejected"          "$INS ('$E2',2,'ETH','model','')" "entity_markets_reason_check"
"${PSQL[@]}" -c "$INS ('$E2',2,'ETH','model',repeat('a',200))" >/dev/null && ok "reason of exactly 200 chars accepted" || bad "200-char reason"
cons "missing set_by rejected" "insert into atlas.entity_markets (entity_id, rank, symbol) values ('$E2',3,'SOL')" "null value in column \"set_by\""
cons "unknown entity rejected (fk)" "$INS ('00000000-0000-7000-8000-0000000000ff',1,'BTC','model',null)" "entity_markets_entity_id_fkey"
"${PSQL[@]}" -c "$INS ('$E3',1,'SOL','manual',null), ('$E3',2,'ETH','manual',null)" >/dev/null && ok "two links for e3" || bad "e3 links"
"${PSQL[@]}" -c "delete from atlas.entities where id='$E3'" >/dev/null && ok "deleting entity e3 works" || bad "delete e3: $(q "delete from atlas.entities where id='$E3'")"
check "cascade removed e3's links" "select count(*) from atlas.entity_markets where entity_id='$E3'" 0

echo "== entity_worker =="
EW=entity_worker
run "entity_worker select entity_markets"   $EW "select entity_id, rank, symbol, pinned from atlas.entity_markets order by entity_id, rank"
check "entity_worker sees all 4 rows (RLS policy)" "begin; set role $EW; select count(*) from atlas.entity_markets; commit" 4
run "entity_worker insert (id from uuidv7)" $EW "$INS ('$E1',3,'xyz:GOLD','model','Gold as a haven')"
run "entity_worker update (pin + rank swap)" $EW "update atlas.entity_markets set pinned=true, set_by='manual', set_at=now() where entity_id='$E1' and rank=1"
run "entity_worker delete" $EW "delete from atlas.entity_markets where entity_id='$E1' and rank=3"
run "entity_worker update entities.markets_checked_at" $EW "update atlas.entities set markets_checked_at=now() where id='$E2'"
run "entity_worker read entities.markets_checked_at" $EW "select id, markets_checked_at from atlas.entities"
check "markets_checked_at set on e2 only" "select string_agg(slug, ',') from atlas.entities where markets_checked_at is not null" "bitcoin"
check "known side effect: entities_history wrote one UPDATE row for e2 (changed = markets_checked_at only)" "select count(*)||','||string_agg((select string_agg(k, ',') from jsonb_object_keys(changed) k), ';') from atlas.history where table_name='entities' and op='UPDATE' and row_pk->>'id'='$E2'" "1,markets_checked_at"
refuse "entity_worker update entities.summary still refused" $EW "update atlas.entities set summary='x' where id='$E2'"
refuse "entity_worker truncate entity_markets" $EW "truncate atlas.entity_markets"

echo "== service_role / atlas_analyst / anon / authenticated =="
for r in service_role atlas_analyst; do
  run "$r select entity_markets" $r "select count(*) from atlas.entity_markets"
  refuse "$r insert entity_markets" $r "$INS ('$E2',3,'SOL','model',null)"
  refuse "$r update entity_markets" $r "update atlas.entity_markets set pinned=true"
  refuse "$r delete entity_markets" $r "delete from atlas.entity_markets"
done
for r in anon authenticated; do
  refuse "$r select entity_markets" $r "select count(*) from atlas.entity_markets"
done

echo "== final down after data restores the schema =="
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down after data (drops links + column)" || bad "final down"
dump > "$TMP/after_final.sql"
diff -q "$TMP/before.sql" "$TMP/after_final.sql" >/dev/null && ok "schema identical to before up after the final down" || bad "schema differs after final down"
check "entities kept after final down" "select count(*) from atlas.entities" 2

echo "RESULT: $PASS passed, $REFUSED refused as expected, $FAILS failures"
[[ $FAILS -eq 0 ]]
