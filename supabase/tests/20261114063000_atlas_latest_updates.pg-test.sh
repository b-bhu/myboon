#!/usr/bin/env bash
# #630 latest updates tables + latest_update_worker, on a THROWAWAY local Postgres 17. Never points at Supabase.
# Applies every atlas migration before 20261114063000, seeds a small fixture, then:
#   schema snapshot -> up -> down (snapshot must match) -> down again -> up -> up again,
# grants as latest_update_worker (insert/select pass; update/delete/foreign writes refused),
# constraint tests (partial unique, unique key, visibility default, checks, FKs), service_role and
# atlas_analyst reads, policy and grant listings.
# Needs server binaries (initdb, pg_ctl, postgres) in PG_BIN; psql, createdb and pg_dump come from PATH.
# Usage: PG_BIN=/path/to/pg17/bin bash supabase/tests/20261114063000_atlas_latest_updates.pg-test.sh
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
TMP=$(mktemp -d /tmp/issue630.XXXX); PORT=$((50000 + RANDOM % 10000)); DB=db630
V=20261114063000_atlas_latest_updates
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

# Fixture: 2 entities, 3 items, 3 signals, 3 origin links.
"${PSQL[@]}" >/dev/null <<'SQL'
insert into atlas.entities (id, slug, name, type) values
  ('00000000-0000-7000-8000-0000000000e1', 'e-one', 'Entity One', 'organization'),
  ('00000000-0000-7000-8000-0000000000e2', 'e-two', 'Entity Two', 'asset');
insert into atlas.entity_items (id, item_key, title, main_entity_id, occurred_at, signal_id) values
  ('00000000-0000-7000-8000-0000000000a1', 'k1', 'Item 1', '00000000-0000-7000-8000-0000000000e1', now() - interval '3 hours', null),
  ('00000000-0000-7000-8000-0000000000a2', 'k2', 'Item 2', '00000000-0000-7000-8000-0000000000e1', now() - interval '1 hour', null),
  ('00000000-0000-7000-8000-0000000000a3', 'k3', 'Item 3', '00000000-0000-7000-8000-0000000000e2', now() - interval '2 hours', null);
insert into atlas.signals (signal_id, schema_version, source, source_id, type, text, link, occurred_at, fetched_at) values
  ('s-1', 1, 'rss', '1', 'news', 'one', 'https://a.example/1', now(), now()),
  ('s-2', 1, 'rss', '2', 'news', 'two', 'https://a.example/2', now(), now()),
  ('s-3', 1, 'rss', '3', 'news', 'three', 'https://a.example/3', now(), now());
create table public.t630_probe (a int);
insert into atlas.item_signals (item_id, signal_id) values
  ('00000000-0000-7000-8000-0000000000a1', 's-1'),
  ('00000000-0000-7000-8000-0000000000a2', 's-2'),
  ('00000000-0000-7000-8000-0000000000a3', 's-3');
SQL
E1=00000000-0000-7000-8000-0000000000e1; E2=00000000-0000-7000-8000-0000000000e2
I1=00000000-0000-7000-8000-0000000000a1; I2=00000000-0000-7000-8000-0000000000a2; I3=00000000-0000-7000-8000-0000000000a3

ROLE="select count(*) from pg_roles where rolname='latest_update_worker'"
TABLES="select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='atlas' and c.relname in ('latest_update_runs','latest_updates','latest_update_items')"
INDEXES="select count(*) from pg_indexes where schemaname='atlas' and tablename like 'latest_update%'"
POL="select count(*) from pg_policies where policyname like 'latest_update_worker_%'"
POLALL="select count(*) from pg_policies where tablename like 'latest_update%' or policyname like 'latest_update_worker_%'"

echo "== schema before up =="
dump > "$TMP/before.sql"
echo "snapshot: $(wc -l < "$TMP/before.sql") lines (atlas schema-only dump + roles + role settings)"
check "before: no latest_update tables" "$TABLES" 0
check "before: no latest_update_worker role" "$ROLE" 0

echo "== up / down / down / up / up =="
"${PSQL[@]}" -f "$UP" >/dev/null && ok "up applied" || bad "up"
check "up: 3 tables" "$TABLES" 3
check "up: role exists" "$ROLE" 1
echo "up: $(q "$INDEXES") indexes (incl. 3 pkeys + 1 unique key), $(q "$POLALL") policies"
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down applied" || bad "down"
check "down: 0 tables" "$TABLES" 0
check "down: 0 indexes" "$INDEXES" 0
check "down: role gone" "$ROLE" 0
check "down: 0 policies" "$POLALL" 0
dump > "$TMP/after_down.sql"
if diff -u "$TMP/before.sql" "$TMP/after_down.sql" > "$TMP/diff.txt"; then ok "schema diff before up vs after down: identical ($(wc -l < "$TMP/before.sql") lines compared)"; else bad "schema differs after down"; head -40 "$TMP/diff.txt"; fi
check "down: fixture rows kept (entities, items, signals, links)" "select (select count(*) from atlas.entities)||','||(select count(*) from atlas.entity_items)||','||(select count(*) from atlas.signals)||','||(select count(*) from atlas.item_signals)" "2,3,3,3"
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down rerun (idempotent)" || bad "down rerun"
"${PSQL[@]}" -f "$UP" >/dev/null && ok "up again applied" || bad "up again"
dump > "$TMP/after_up2.sql"
"${PSQL[@]}" -f "$UP" >/dev/null && ok "up rerun (idempotent)" || bad "up rerun"
dump > "$TMP/after_up3.sql"
diff -q "$TMP/after_up2.sql" "$TMP/after_up3.sql" >/dev/null && ok "up rerun changes nothing" || bad "up rerun changed schema"
check "up rerun: still 3 tables, 1 role" "select ($TABLES)||','||($ROLE)" "3,1"

echo "== role attributes =="
check "role is nologin noinherit, no bypassrls, not super" "select rolcanlogin::text||rolinherit::text||rolbypassrls::text||rolsuper::text from pg_roles where rolname='latest_update_worker'" falsefalsefalsefalse
check "connection limit 5" "select rolconnlimit from pg_roles where rolname='latest_update_worker'" 5
check "role timeouts set" "select array_to_string(array(select unnest(setconfig) order by 1), ',') from pg_db_role_setting where setrole='latest_update_worker'::regrole and setdatabase=0" "lock_timeout=5s,statement_timeout=60s"
check "RLS on, not forced, on all 3 tables" "select string_agg(relrowsecurity::text||relforcerowsecurity::text, ',') from pg_class where oid in ('atlas.latest_update_runs'::regclass,'atlas.latest_updates'::regclass,'atlas.latest_update_items'::regclass)" "truefalse,truefalse,truefalse"

echo "== indexes and constraints present (shape) =="
check "runs index (entity_id, created_at desc)" "select count(*) from pg_indexes where indexname='latest_update_runs_entity_created_idx' and indexdef like '%(entity_id, created_at DESC)%'" 1
check "runs partial unique (entity_id, newest_entity_item_id) where decision <> 'error'" "select count(*) from pg_indexes where indexname='latest_update_runs_final_decision_uidx' and indexdef like 'CREATE UNIQUE INDEX%(entity_id, newest_entity_item_id)%' and indexdef like '%decision <> ''error''%'" 1
check "updates index (entity_id, published_at desc)" "select count(*) from pg_indexes where indexname='latest_updates_entity_published_idx' and indexdef like '%(entity_id, published_at DESC)%'" 1
check "updates unique (entity_id, newest_entity_item_id)" "select pg_get_constraintdef(oid) from pg_constraint where conname='latest_updates_entity_newest_key'" "UNIQUE (entity_id, newest_entity_item_id)"
check "items pk (latest_update_id, entity_item_id)" "select pg_get_constraintdef(oid) from pg_constraint where conname='latest_update_items_pkey'" "PRIMARY KEY (latest_update_id, entity_item_id)"
check "items index on entity_item_id" "select count(*) from pg_indexes where indexname='latest_update_items_entity_item_idx'" 1
check "items fk to update: cascade; fk to item: restrict" "select string_agg(confdeltype::text, ',' order by conname) from pg_constraint where conrelid='atlas.latest_update_items'::regclass and contype='f'" "r,c"
check "newest_entity_item_id not null on runs and updates" "select count(*) from information_schema.columns where table_schema='atlas' and table_name in ('latest_update_runs','latest_updates') and column_name='newest_entity_item_id' and is_nullable='NO'" 2
check "ids default atlas.uuidv7()" "select count(*) from information_schema.columns where table_schema='atlas' and table_name like 'latest_update%' and column_name='id' and column_default='atlas.uuidv7()'" 2

echo "== policies (table, name, cmd, roles) =="
"${PSQL[@]}" -t -A -F ' | ' -c "select tablename, policyname, cmd, roles::text from pg_policies where policyname like 'latest_update_worker_%' or (tablename like 'latest_update%' and policyname in ('analyst_read','service_role_select')) order by tablename, policyname"
check "policy count: 4 inputs + 6 worker on new + 3 analyst_read + 2 service_role" "$POLALL" 15

echo "== grants (information_schema.role_table_grants, role latest_update_worker) =="
"${PSQL[@]}" -t -A -F ' | ' -c "select table_name, string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where grantee='latest_update_worker' and table_schema='atlas' group by table_name order by table_name"
check "worker has only select+insert on new tables, select on 4 inputs, nothing else" "select string_agg(table_name||':'||p, ' ' order by table_name) from (select table_name, string_agg(privilege_type, ',' order by privilege_type) p from information_schema.role_table_grants where grantee='latest_update_worker' and table_schema='atlas' group by table_name) s" "entities:SELECT entity_items:SELECT item_signals:SELECT latest_update_items:INSERT,SELECT latest_update_runs:INSERT,SELECT latest_updates:INSERT,SELECT signals:SELECT"
check "worker has no column-level grants" "select count(*) from information_schema.column_privileges where grantee='latest_update_worker' and table_schema='atlas' and table_name not in (select table_name from information_schema.role_table_grants where grantee='latest_update_worker' and table_schema='atlas')" 0
check "schema usage + uuidv7 execute" "select has_schema_privilege('latest_update_worker','atlas','usage')::text||has_function_privilege('latest_update_worker','atlas.uuidv7()','execute')::text" truetrue
check "service_role: select on updates+items only" "select has_table_privilege('service_role','atlas.latest_updates','select')::text||has_table_privilege('service_role','atlas.latest_update_items','select')::text||has_table_privilege('service_role','atlas.latest_update_runs','select')::text||has_table_privilege('service_role','atlas.latest_updates','insert')::text" truetruefalsefalse
check "anon / authenticated: no access" "select has_table_privilege('anon','atlas.latest_updates','select')::text||has_table_privilege('authenticated','atlas.latest_updates','select')::text||has_table_privilege('anon','atlas.latest_update_runs','select')::text" falsefalsefalse
check "atlas_analyst: select on all 3" "select has_table_privilege('atlas_analyst','atlas.latest_update_runs','select')::text||has_table_privilege('atlas_analyst','atlas.latest_updates','select')::text||has_table_privilege('atlas_analyst','atlas.latest_update_items','select')::text" truetruetrue

AS="set role latest_update_worker;"
run() { if "${PSQL[@]}" -t -A -c "begin; $AS $2; commit;" >"$TMP/out" 2>"$TMP/err"; then ok "$1"; else bad "$1: $(head -1 "$TMP/err")"; fi; }
refuse() {
  if "${PSQL[@]}" -c "begin; $AS $2; commit;" >/dev/null 2>"$TMP/err"; then bad "$1 (accepted)"
  elif grep -qE "permission denied|row-level security" "$TMP/err"; then echo "REFUSED $1: $(head -1 "$TMP/err")"; REFUSED=$((REFUSED+1))
  else bad "$1 failed oddly: $(head -1 "$TMP/err")"; fi
}
# Refused by a constraint (as postgres, so grants are not what stops it).
cons() {
  if "${PSQL[@]}" -c "$2" >/dev/null 2>"$TMP/err"; then bad "$1 (accepted)"
  elif grep -q "$3" "$TMP/err"; then echo "REFUSED $1: $(head -1 "$TMP/err")"; REFUSED=$((REFUSED+1))
  else bad "$1 failed oddly: $(head -1 "$TMP/err")"; fi
}

echo "== worker path as latest_update_worker =="
run "read the four input tables" "select count(*) from atlas.entities; select count(*) from atlas.entity_items; select count(*) from atlas.item_signals; select count(*) from atlas.signals"
run "snapshot-style join read" "select e.slug, ei.item_key, s.signal_id from atlas.entities e join atlas.entity_items ei on ei.main_entity_id=e.id join atlas.item_signals isg on isg.item_id=ei.id join atlas.signals s on s.signal_id=isg.signal_id order by ei.occurred_at desc"
run "insert run (published) returning id" "insert into atlas.latest_update_runs (entity_id, newest_entity_item_id, decision, reason, attempt) values ('$E1','$I2','published','ok',1) returning id"
RUN1=$(head -1 "$TMP/out" | tr -d ' ')
run "insert latest_update with run_id (visibility omitted)" "insert into atlas.latest_updates (id, entity_id, headline, what_happened, how_we_got_here, what_to_watch, claims, newest_entity_item_id, editor_version, model, run_id) values ('00000000-0000-7000-8000-0000000000b1','$E1','h','w','how','watch','[{\"text\":\"c\"}]','$I2','v1','glm-5.3-flash','$RUN1')"
run "insert latest_update_items (2 rows)" "insert into atlas.latest_update_items (latest_update_id, entity_item_id) values ('00000000-0000-7000-8000-0000000000b1','$I1'), ('00000000-0000-7000-8000-0000000000b1','$I2')"
run "select the three new tables" "select count(*) from atlas.latest_update_runs; select count(*) from atlas.latest_updates; select count(*) from atlas.latest_update_items"
check "new rows visible: 1 run, 1 update, 2 items" "select (select count(*) from atlas.latest_update_runs)||','||(select count(*) from atlas.latest_updates)||','||(select count(*) from atlas.latest_update_items)" "1,1,2"
check "uuid defaults filled by atlas.uuidv7()" "select count(*) from atlas.latest_update_runs where id is not null" 1

echo "== worker refusals =="
refuse "latest_updates update"        "update atlas.latest_updates set visibility='live'"
refuse "latest_updates delete"        "delete from atlas.latest_updates"
refuse "latest_update_runs update"    "update atlas.latest_update_runs set decision='hold'"
refuse "latest_update_runs delete"    "delete from atlas.latest_update_runs"
refuse "latest_update_items update"   "update atlas.latest_update_items set entity_item_id=entity_item_id"
refuse "latest_update_items delete"   "delete from atlas.latest_update_items"
refuse "truncate latest_updates"      "truncate atlas.latest_updates"
refuse "entities insert"              "insert into atlas.entities (slug, name, type) values ('x','x','asset')"
refuse "entities update"              "update atlas.entities set name='x'"
refuse "entity_items insert"          "insert into atlas.entity_items (item_key, title, main_entity_id) values ('kx','x','$E1')"
refuse "entity_items update"          "update atlas.entity_items set title='x'"
refuse "entity_items delete"          "delete from atlas.entity_items"
refuse "item_signals insert"          "insert into atlas.item_signals (item_id, signal_id) values ('$I1','s-2')"
refuse "signals update"               "update atlas.signals set text='x'"
refuse "signals insert"               "insert into atlas.signals (signal_id, schema_version, source, source_id, type) values ('z',1,'x','z','news')"
refuse "decisions read"               "select id from atlas.decisions"
refuse "entity_context insert"        "insert into atlas.entity_context (entity_id) values ('$E1')"
refuse "stories read"                 "select id from atlas.stories"
refuse "history read"                 "select count(*) from atlas.history"
refuse "entity_aliases read"          "select count(*) from atlas.entity_aliases"
refuse "public schema table read (other schema)"     "select count(*) from public.t630_probe"
refuse "create table in atlas"        "create table atlas.latest_update_evil (a int)"
echo "also: no RLS bypass"
check "worker is not bypassrls" "select rolbypassrls::text from pg_roles where rolname='latest_update_worker'" false

echo "== constraint tests =="
"${PSQL[@]}" -c "insert into atlas.latest_update_runs (entity_id, newest_entity_item_id, decision, attempt) values ('$E2','$I3','hold',1)" >/dev/null && ok "hold run for (e2, i3) accepted" || bad "hold run"
cons "second non-error (skip) for same pair rejected by partial unique" "insert into atlas.latest_update_runs (entity_id, newest_entity_item_id, decision, attempt) values ('$E2','$I3','skip',1)" "latest_update_runs_final_decision_uidx"
cons "second published for same pair rejected" "insert into atlas.latest_update_runs (entity_id, newest_entity_item_id, decision, attempt) values ('$E1','$I2','published',1)" "latest_update_runs_final_decision_uidx"
"${PSQL[@]}" -c "insert into atlas.latest_update_runs (entity_id, newest_entity_item_id, decision, attempt) values ('$E2','$I3','error',1), ('$E2','$I3','error',2)" >/dev/null && ok "two error rows for the same pair accepted" || bad "error rows"
cons "non-error after errors still rejected (hold already exists)" "insert into atlas.latest_update_runs (entity_id, newest_entity_item_id, decision, attempt) values ('$E2','$I3','published',3)" "latest_update_runs_final_decision_uidx"
"${PSQL[@]}" -c "insert into atlas.latest_update_runs (entity_id, newest_entity_item_id, decision, attempt) values ('$E1','$I1','error',1), ('$E1','$I1','error',2), ('$E1','$I1','skip',3)" >/dev/null && ok "errors then one final skip accepted (retry path), different newest item allowed" || bad "retry path"
cons "bad decision value rejected" "insert into atlas.latest_update_runs (entity_id, newest_entity_item_id, decision, attempt) values ('$E1','$I2','maybe',1)" "latest_update_runs_decision_check"
cons "run without newest_entity_item_id rejected" "insert into atlas.latest_update_runs (entity_id, decision, attempt) values ('$E1','hold',1)" "null value in column \"newest_entity_item_id\""
cons "run without attempt rejected" "insert into atlas.latest_update_runs (entity_id, newest_entity_item_id, decision) values ('$E1','$I2','error')" "null value in column \"attempt\""
check "check_failures defaults to []" "select check_failures::text from atlas.latest_update_runs limit 1" "[]"
check "visibility defaults to dark" "select visibility from atlas.latest_updates where id='00000000-0000-7000-8000-0000000000b1'" dark
cons "second latest_updates row for same (entity, newest item) rejected" "insert into atlas.latest_updates (entity_id, headline, what_happened, how_we_got_here, what_to_watch, newest_entity_item_id, editor_version, model, run_id) values ('$E1','h','w','h','w','$I2','v1','m','$RUN1')" "latest_updates_entity_newest_key"
cons "visibility 'secret' rejected" "insert into atlas.latest_updates (entity_id, headline, what_happened, how_we_got_here, what_to_watch, newest_entity_item_id, editor_version, model, run_id, visibility) values ('$E2','h','w','h','w','$I3','v1','m','$RUN1','secret')" "latest_updates_visibility_check"
"${PSQL[@]}" -c "insert into atlas.latest_updates (entity_id, headline, what_happened, how_we_got_here, what_to_watch, newest_entity_item_id, editor_version, model, run_id, visibility) values ('$E2','h','w','h','w','$I3','v1','m','$RUN1','live')" >/dev/null && ok "visibility 'live' accepted at insert" || bad "live insert"
cons "claims must be a jsonb array" "insert into atlas.latest_updates (entity_id, headline, what_happened, how_we_got_here, what_to_watch, claims, newest_entity_item_id, editor_version, model, run_id) values ('$E2','h','w','h','w','{}','$I1','v1','m','$RUN1')" "latest_updates_claims_array_check"
cons "update without run_id rejected" "insert into atlas.latest_updates (entity_id, headline, what_happened, how_we_got_here, what_to_watch, newest_entity_item_id, editor_version, model) values ('$E2','h','w','h','w','$I1','v1','m')" "null value in column \"run_id\""
cons "duplicate item link rejected (pk)" "insert into atlas.latest_update_items (latest_update_id, entity_item_id) values ('00000000-0000-7000-8000-0000000000b1','$I1')" "latest_update_items_pkey"
"${PSQL[@]}" -c "insert into atlas.entities (id, slug, name, type) values ('00000000-0000-7000-8000-0000000000e3','e-three','Entity Three','topic'); insert into atlas.latest_update_runs (entity_id, newest_entity_item_id, decision, attempt) values ('00000000-0000-7000-8000-0000000000e3','$I3','hold',1)" >/dev/null && ok "fixture: run pointing at entity e3 (which has no items)" || bad "e3 fixture"
cons "entity referenced by a run cannot be deleted (restrict)" "delete from atlas.entities where id='00000000-0000-7000-8000-0000000000e3'" "latest_update_runs_entity_id_fkey"
"${PSQL[@]}" -c "insert into atlas.entity_items (id, item_key, title, main_entity_id) values ('00000000-0000-7000-8000-0000000000a4','k4','Item 4','$E2'); insert into atlas.latest_update_items (latest_update_id, entity_item_id) values ('00000000-0000-7000-8000-0000000000b1','00000000-0000-7000-8000-0000000000a4')" >/dev/null && ok "fixture: item i4 linked only through latest_update_items" || bad "i4 fixture"
cons "item linked by a latest update cannot be deleted (restrict)" "delete from atlas.entity_items where id='00000000-0000-7000-8000-0000000000a4'" "latest_update_items_entity_item_id_fkey"
cons "item used as newest item cannot be deleted (restrict)" "delete from atlas.entity_items where id='$I2'" "newest_entity_item_id_fkey"
"${PSQL[@]}" -c "delete from atlas.latest_updates where id='00000000-0000-7000-8000-0000000000b1'" >/dev/null && ok "deleting an update (owner) works" || bad "delete update"
check "update delete cascaded to its 3 item links (i1, i2, i4)" "select count(*) from atlas.latest_update_items" 0

echo "== service_role and atlas_analyst reads =="
for t in latest_updates latest_update_items; do
  "${PSQL[@]}" -c "begin; set role service_role; select count(*) from atlas.$t; commit;" >/dev/null 2>&1 && ok "service_role reads $t" || bad "service_role read $t"
done
"${PSQL[@]}" -c "begin; set role service_role; insert into atlas.latest_updates (entity_id) values ('$E1'); commit;" >/dev/null 2>"$TMP/err" && bad "service_role insert accepted" || { grep -q "permission denied" "$TMP/err" && echo "REFUSED service_role insert on latest_updates" && REFUSED=$((REFUSED+1)) || bad "service_role insert failed oddly"; }
"${PSQL[@]}" -c "begin; set role service_role; select count(*) from atlas.latest_update_runs; commit;" >/dev/null 2>"$TMP/err" && bad "service_role read runs accepted" || { grep -q "permission denied" "$TMP/err" && echo "REFUSED service_role read on latest_update_runs (not granted, per #630)" && REFUSED=$((REFUSED+1)) || bad "service_role runs oddly"; }
for t in latest_update_runs latest_updates latest_update_items; do
  "${PSQL[@]}" -c "begin; set role atlas_analyst; select count(*) from atlas.$t; commit;" >/dev/null 2>&1 && ok "atlas_analyst reads $t" || bad "atlas_analyst read $t"
done
"${PSQL[@]}" -c "begin; set role authenticated; select count(*) from atlas.latest_updates; commit;" >/dev/null 2>&1 && bad "authenticated read accepted" || { echo "REFUSED authenticated read on latest_updates"; REFUSED=$((REFUSED+1)); }
"${PSQL[@]}" -c "begin; set role anon; select count(*) from atlas.latest_updates; commit;" >/dev/null 2>&1 && bad "anon read accepted" || { echo "REFUSED anon read on latest_updates"; REFUSED=$((REFUSED+1)); }

echo "== final down leaves the schema as before =="
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down after data (drops rows, tables, role)" || bad "final down"
dump > "$TMP/after_final.sql"
diff -q "$TMP/before.sql" "$TMP/after_final.sql" >/dev/null && ok "schema identical to before up after the final down" || bad "schema differs after final down"

echo "RESULT: $PASS passed, $REFUSED refused as expected, $FAILS failures"
[[ $FAILS -eq 0 ]]
