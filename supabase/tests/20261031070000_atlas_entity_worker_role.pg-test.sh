#!/usr/bin/env bash
# #480 entity_worker role test on a THROWAWAY local Postgres 17. Never points at Supabase.
# Applies every atlas migration before 20261031070000, then up / down / down / up of this one,
# runs the entity manager's real queries (packages/analyst/src/entity-manager.ts) as
# entity_worker (must pass), and the forbidden actions (must be refused).
# Usage: bash supabase/tests/20261031070000_atlas_entity_worker_role.pg-test.sh
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
TMP=$(mktemp -d /tmp/issue480ew.XXXX); PORT=$((50000 + RANDOM % 10000)); DB=db480ew
UP=$REPO/supabase/migrations/20261031070000_atlas_entity_worker_role.sql
DOWN=$REPO/supabase/rollbacks/20261031070000_atlas_entity_worker_role.down.sql
trap '"$BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
"$BIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
"$BIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null
"$BIN/createdb" -h "$TMP" -p $PORT -U postgres "$DB"
PSQL=(psql -X -q -h "$TMP" -p $PORT -U postgres -d "$DB" -v ON_ERROR_STOP=1)
PASS=0; REFUSED=0; FAILS=0
ok()  { echo "PASS $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL $1"; FAILS=$((FAILS+1)); }
q()   { "${PSQL[@]}" -t -A -c "$1"; }

"${PSQL[@]}" -c "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;" >/dev/null
for f in $(ls "$REPO"/supabase/migrations/*_atlas*.sql | sort); do
  b=$(basename "$f")
  [[ $b < 20261031070000 ]] || continue
  if [[ $b == 20261025100200_atlas_tool_log.sql ]]; then
    "${PSQL[@]}" -c "create table atlas.tool_log (id bigint generated always as identity, logged_at timestamptz not null default now(), run_id text, tool text not null, input jsonb, output jsonb, duration_ms bigint, error text, primary key (logged_at, id)); alter table atlas.tool_log enable row level security;" >/dev/null || { echo "tool_log stand-in failed"; exit 1; }
    continue
  fi
  "${PSQL[@]}" -f "$f" >/dev/null || { echo "apply $b failed"; exit 1; }
done

ROLE="select count(*) from pg_roles where rolname='entity_worker'"
POL="select count(*) from pg_policies where 'entity_worker' = any(roles)"
echo "== up / down / down / up =="
"${PSQL[@]}" -f "$UP"   >/dev/null && ok "up applied" || bad "up"
[[ $(q "$POL") == 7 ]] && ok "up: 7 policies" || bad "up policies: $(q "$POL")"
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down applied" || bad "down"
[[ $(q "$ROLE") == 0 ]] && ok "down: role gone" || bad "down: role remains"
[[ $(q "$POL") == 0 ]] && ok "down: policies gone" || bad "down: policies remain"
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down rerun (idempotent)" || bad "down rerun"
"${PSQL[@]}" -f "$UP"   >/dev/null && ok "up again applied" || bad "up again"
"${PSQL[@]}" -f "$UP"   >/dev/null && ok "up rerun (idempotent)" || bad "up rerun"
[[ $(q "$POL") == 7 ]] && ok "up rerun: still 7 policies" || bad "up rerun policies: $(q "$POL")"
[[ $(q "select rolconnlimit from pg_roles where rolname='entity_worker'") == 5 ]] && ok "connection limit 5" || bad "connlimit"
[[ $(q "select array_to_string(array(select unnest(setconfig) order by 1), ',') from pg_db_role_setting where setrole='entity_worker'::regrole and setdatabase=0") == "lock_timeout=5s,statement_timeout=60s" ]] && ok "role timeouts set" || bad "role timeouts"
[[ $(q "select rolcanlogin::text||rolinherit::text||rolbypassrls::text||rolsuper::text from pg_roles where rolname='entity_worker'") == "falsefalsefalsefalse" ]] \
  && ok "role is nologin noinherit, no bypassrls, not super" || bad "role attrs"

"${PSQL[@]}" >/dev/null <<'SQL'
insert into atlas.shelves (slug, name, type) values ('kalshi', 'Kalshi', 'organization');
insert into atlas.shelves (slug, name, type, status) values ('kalshi-inc', 'Kalshi Inc', 'organization', 'proposed'),
                                                            ('junkco', 'Junk Co', 'organization', 'proposed');
insert into atlas.signals (signal_id, schema_version, source, source_id, type, text, link, occurred_at)
  values ('s-1', 1, 'x', '1', 'news', 't', null, now()), ('s-2', 1, 'x', '2', 'news', 't', null, now());
insert into atlas.items (item_key, title, main_shelf_id, signal_id, angle, note)
  select 'k-x-s1', 'dup on X', id, 's-1', 'new_story', 'n' from atlas.shelves where slug = 'kalshi';
insert into atlas.items (item_key, title, main_shelf_id, signal_id, angle, note)
  select 'k-p-s1', 'dup on P', id, 's-1', 'new_story', 'n' from atlas.shelves where slug = 'kalshi-inc';
insert into atlas.items (item_key, title, main_shelf_id, signal_id, angle, note)
  select 'k-p-s2', 'moves to X', id, 's-2', 'new_story', 'n' from atlas.shelves where slug = 'kalshi-inc';
insert into atlas.decisions (schema_version, signal_id, analyst_version, decision_type, summary, decision, reason, targets, decided_by)
  values (1, 's-1', 'analyst-504-v1', 'file', 's', 'keep', 'r', '[]'::jsonb, 'jev'),
         (1, 's-2', 'analyst-504-v1', 'file', 's', 'keep', 'r', '[]'::jsonb, 'jev');
SQL

AS="set role entity_worker;"
run() { if "${PSQL[@]}" -t -A -c "begin; $AS $2; commit;" >"$TMP/out" 2>"$TMP/err"; then ok "$1"; else bad "$1: $(head -1 "$TMP/err")"; fi; }
refuse() {
  if "${PSQL[@]}" -c "begin; $AS $2; commit;" >/dev/null 2>"$TMP/err"; then bad "$1 (accepted)"
  elif grep -qE "permission denied|row-level security" "$TMP/err"; then echo "REFUSED $1"; REFUSED=$((REFUSED+1))
  else bad "$1 failed oddly: $(head -1 "$TMP/err")"; fi
}

echo "== entity manager path as entity_worker =="
run "list proposed shelves" "select id, slug, name, type from atlas.shelves where status = 'proposed' order by slug"
[[ $(wc -l < "$TMP/out") -ge 2 ]] && ok "proposed shelves visible through RLS" || bad "proposed rows: $(cat "$TMP/out")"
run "list active shelves" "select slug, name, type, aliases from atlas.shelves where status = 'active'"
run "shelf items read" "select signal_id, title, note from atlas.items where main_shelf_id = (select id from atlas.shelves where slug='kalshi-inc') order by created_at desc, id desc"
run "token-rule read" "with latest as (select outcome, reviewed_at from atlas.entity_reviews where shelf_id = (select id from atlas.shelves where slug='kalshi-inc') order by reviewed_at desc, id desc limit 1) select outcome, exists (select 1 from atlas.items i where i.main_shelf_id = (select id from atlas.shelves where slug='kalshi-inc') and i.created_at > latest.reviewed_at) from latest"
run "new verdict review insert (unapplied)" "insert into atlas.entity_reviews (shelf_id, signal_id, decision_id, outcome, alias_target_id, applied, decided_by, model_name, reason) select (select id from atlas.shelves where slug='junkco'), 's-1', (select d.id from atlas.decisions d where d.signal_id='s-1' order by d.id desc limit 1), 'new', null, false, 'entity-manager', 'glm-5.3-flash', 'r'"
run "alias transaction (locks, move, alias, retire, review)" "
select pg_advisory_xact_lock(hashtext('atlas.shelf:' || 'kalshi'));
select pg_advisory_xact_lock(hashtext('atlas.shelf:' || 'kalshi-inc'));
select id from atlas.shelves where slug = 'kalshi-inc' and status = 'proposed' for update;
select distinct signal_id from atlas.items where main_shelf_id = (select id from atlas.shelves where slug='kalshi-inc') and signal_id is not null;
select id from atlas.shelves where slug = 'kalshi' and status = 'active' for update;
update atlas.items i set main_shelf_id = (select id from atlas.shelves where slug='kalshi')
 where i.main_shelf_id = (select id from atlas.shelves where slug='kalshi-inc')
   and not exists (select 1 from atlas.items i2 where i2.signal_id = i.signal_id and i2.main_shelf_id = (select id from atlas.shelves where slug='kalshi'));
update atlas.shelves set aliases = array_append(aliases, 'kalshi-inc') where id = (select id from atlas.shelves where slug='kalshi') and not ('kalshi-inc' = any(aliases));
update atlas.shelves set status = 'retired' where id = (select id from atlas.shelves where slug='kalshi-inc');
insert into atlas.entity_reviews (shelf_id, signal_id, decision_id, outcome, alias_target_id, applied, decided_by, model_name, reason)
 select (select id from atlas.shelves where slug='kalshi-inc'), sid, (select d.id from atlas.decisions d where d.signal_id = sid order by d.id desc limit 1),
        'alias', (select id from atlas.shelves where slug='kalshi'), true, 'entity-manager', 'glm-5.3-flash', 'r'
   from unnest(array['s-1','s-2']::text[]) sid"
run "reject transaction (retire only)" "select id from atlas.shelves where slug = 'junkco' and status = 'proposed' for update; update atlas.shelves set status = 'retired' where slug = 'junkco'"
[[ $(q "select count(*) from atlas.items where signal_id='s-2' and main_shelf_id=(select id from atlas.shelves where slug='kalshi')") == 1 ]] && ok "non-duplicate item moved" || bad "item not moved"
[[ $(q "select aliases = array['kalshi-inc'] from atlas.shelves where slug='kalshi'") == t ]] && ok "alias appended" || bad "alias"
[[ $(q "select count(*) from atlas.shelves where status='retired'") == 2 ]] && ok "both proposed shelves retired" || bad "retire"
[[ $(q "select count(*) from atlas.entity_reviews") == 3 ]] && ok "3 review rows" || bad "reviews: $(q "select count(*) from atlas.entity_reviews")"
[[ $(q "select count(*) from atlas.history where table_name in ('items','shelves') and op='UPDATE'") -ge 3 ]] && ok "history triggers wrote rows (definer)" || bad "history rows missing"

echo "== refusals =="
refuse "shelves.name update"     "update atlas.shelves set name = 'x' where slug = 'kalshi'"
refuse "shelves insert"          "insert into atlas.shelves (slug, name, type) values ('z','Z','organization')"
refuse "shelves delete"          "delete from atlas.shelves where slug = 'kalshi'"
refuse "items.title update"      "update atlas.items set title = 'x'"
refuse "items insert"            "insert into atlas.items (item_key, title, main_shelf_id, angle) select 'kz','t',id,'new_story' from atlas.shelves where slug='kalshi'"
refuse "items delete"            "delete from atlas.items"
refuse "decisions summary read"  "select summary from atlas.decisions"
refuse "decisions insert"        "insert into atlas.decisions (schema_version, signal_id, analyst_version, decision_type, summary, decision, reason, targets, decided_by) values (1,'s-1','v','file','s','keep','r','[]','x')"
refuse "entity_reviews update"   "update atlas.entity_reviews set label = 'right'"
refuse "entity_reviews delete"   "delete from atlas.entity_reviews"
refuse "signals read"            "select signal_id from atlas.signals"
refuse "history read"            "select count(*) from atlas.history"
refuse "signal_claim call"       "select atlas.signal_claim('300 seconds','x',1)"

echo "RESULT: $PASS passed, $REFUSED refused as expected, $FAILS failures"
[[ $FAILS -eq 0 ]]
