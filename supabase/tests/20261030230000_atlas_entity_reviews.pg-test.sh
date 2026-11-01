#!/usr/bin/env bash
# #480 entity_reviews migration test on a THROWAWAY local Postgres 17. Never points at Supabase.
# Applies every atlas migration before 20261030230000, then up / down / down / up of this one (the
# up file is one transaction, so a rerun is not valid by design and is not tested). Verifies the
# table + RLS + exactly the service_role grants the job needs (select + insert on entity_reviews,
# update (label) on entity_reviews, update (status, aliases) on atlas.shelves, update
# (main_shelf_id) on atlas.items, select (id) on atlas.decisions over the pre-existing column
# grants) and that analyst_worker has nothing on entity_reviews or those update columns; then runs
# the alias transaction as service_role (items.main_shelf_id move with the unique-index duplicate
# skip, aliases append, retire, entity_reviews insert) and proves the analyst_worker shelf update
# is still refused.
# Usage: bash supabase/tests/20261030230000_atlas_entity_reviews.pg-test.sh
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
TMP=$(mktemp -d /tmp/issue480pg.XXXX); PORT=$((50000 + RANDOM % 10000)); DB=db480
UP=$REPO/supabase/migrations/20261030230000_atlas_entity_reviews.sql
DOWN=$REPO/supabase/rollbacks/20261030230000_atlas_entity_reviews.down.sql
trap '"$BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
"$BIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
"$BIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null
"$BIN/createdb" -h "$TMP" -p $PORT -U postgres "$DB"
PSQL=(psql -X -q -h "$TMP" -p $PORT -U postgres -d "$DB" -v ON_ERROR_STOP=1)
PASS=0; FAILS=0
ok()  { echo "PASS $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL $1"; FAILS=$((FAILS+1)); }
q()   { "${PSQL[@]}" -t -A -c "$1"; }

"${PSQL[@]}" -c "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;" >/dev/null
for f in $(ls "$REPO"/supabase/migrations/*_atlas*.sql | sort); do
  b=$(basename "$f")
  [[ $b < 20261030230000 ]] || continue   # this migration is applied below; later ones are not part of this test
  if [[ $b == 20261025100200_atlas_tool_log.sql ]]; then
    "${PSQL[@]}" -c "create table atlas.tool_log (id bigint generated always as identity, logged_at timestamptz not null default now(), run_id text, tool text not null, input jsonb, output jsonb, duration_ms bigint, error text, primary key (logged_at, id)); alter table atlas.tool_log enable row level security;" >/dev/null || { echo "tool_log stand-in failed"; exit 1; }
    continue
  fi
  "${PSQL[@]}" -f "$f" >/dev/null || { echo "apply $b failed"; exit 1; }
done
[[ -f $UP   ]] || { echo "FAIL missing $UP (implementation not written yet)"; echo "RESULT: $PASS passed, $((FAILS+1)) failures"; exit 1; }
[[ -f $DOWN ]] || { echo "FAIL missing $DOWN (implementation not written yet)"; echo "RESULT: $PASS passed, $((FAILS+1)) failures"; exit 1; }

# Whether the table exists (grants are meaningless without it).
EXISTS="select to_regclass('atlas.entity_reviews') is not null"
RLS_ON="select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'atlas' and c.relname = 'entity_reviews'"

echo "== up / down / down / up =="
"${PSQL[@]}" -f "$UP" >/dev/null   && ok "up applied"     || bad "up"
[[ $(q "$EXISTS") == "t" ]] && ok "up: atlas.entity_reviews exists" || bad "up state: table missing"
[[ $(q "$RLS_ON") == "t" ]] && ok "up: RLS enabled on entity_reviews" || bad "up: RLS off"
[[ $(q "select has_table_privilege('service_role','atlas.entity_reviews','select')::text || has_table_privilege('service_role','atlas.entity_reviews','insert')::text
        || (not has_table_privilege('service_role','atlas.entity_reviews','update'))::text || (not has_table_privilege('service_role','atlas.entity_reviews','delete'))::text") == "truetruetruetrue" ]] \
  && ok "service_role: select + insert on entity_reviews, no table-level update/delete" || bad "service_role entity_reviews table grants wrong"
[[ $(q "select has_column_privilege('service_role','atlas.entity_reviews','label','update')::text || (not has_column_privilege('service_role','atlas.entity_reviews','shelf_id','update'))::text") == "truetrue" ]] \
  && ok "service_role: update (label) only on entity_reviews" || bad "service_role entity_reviews column update wrong"
[[ $(q "select has_column_privilege('service_role','atlas.shelves','status','update')::text || has_column_privilege('service_role','atlas.shelves','aliases','update')::text
        || (not has_column_privilege('service_role','atlas.shelves','name','update'))::text || (not has_column_privilege('service_role','atlas.shelves','type','update'))::text") == "truetruetruetrue" ]] \
  && ok "service_role: update (status, aliases) on shelves, nothing else" || bad "service_role shelves update wrong"
[[ $(q "select has_column_privilege('service_role','atlas.items','main_shelf_id','update')::text || (not has_column_privilege('service_role','atlas.items','title','update'))::text") == "truetrue" ]] \
  && ok "service_role: update (main_shelf_id) on items only" || bad "service_role items update wrong"
[[ $(q "select has_column_privilege('service_role','atlas.decisions','id','select')::text || has_column_privilege('service_role','atlas.decisions','signal_id','select')::text") == "truetrue" ]] \
  && ok "service_role: select (id, signal_id) on decisions" || bad "service_role decisions select wrong"
[[ $(q "select (not has_table_privilege('analyst_worker','atlas.entity_reviews','select'))::text || (not has_table_privilege('analyst_worker','atlas.entity_reviews','insert'))::text
        || (not has_column_privilege('analyst_worker','atlas.shelves','status','update'))::text || (not has_column_privilege('analyst_worker','atlas.items','main_shelf_id','update'))::text") == "truetruetruetrue" ]] \
  && ok "analyst_worker: nothing on entity_reviews, no shelf/item update grants" || bad "analyst_worker grants present"

"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down applied"    || bad "down"
[[ $(q "$EXISTS") == "f" ]] && ok "down: table gone (grants went with it)" || bad "down state: table still there"
[[ $(q "select has_column_privilege('service_role','atlas.decisions','id','select')::text || has_column_privilege('service_role','atlas.decisions','signal_id','select')::text") == "falsetrue" ]] \
  && ok "down: our decisions (id) select revoked, the pre-existing (signal_id) grant kept" || bad "down decisions grants wrong"
[[ $(q "select (not has_column_privilege('service_role','atlas.shelves','status','update'))::text || (not has_column_privilege('service_role','atlas.items','main_shelf_id','update'))::text") == "truetrue" ]] \
  && ok "down: shelves/items update grants revoked" || bad "down column grants wrong"
"${PSQL[@]}" -f "$DOWN" >/dev/null 2>&1 && ok "down rerun (idempotent)" || bad "down rerun"
"${PSQL[@]}" -f "$UP"   >/dev/null && ok "up again applied" || bad "up again"
[[ $(q "$EXISTS") == "t" ]] && ok "final state: table present with grants" || bad "final state: table missing"

# The alias transaction the job runs per decision, as service_role (GRANT-level proof).
"${PSQL[@]}" >/dev/null <<'SQL'
insert into atlas.shelves (slug, name, type) values ('kalshi', 'Kalshi', 'organization');
insert into atlas.shelves (slug, name, type, status) values ('kalshi-inc', 'Kalshi Inc', 'organization', 'proposed');
insert into atlas.signals (signal_id, schema_version, source, source_id, type, text, link, occurred_at)
  values ('s-1', 1, 'tokens_xyz', 'src-1', 'news', 'text', null, now()),
         ('s-2', 1, 'tokens_xyz', 'src-2', 'news', 'text', null, now());
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
"${PSQL[@]}" -c "set role service_role;
update atlas.items i
   set main_shelf_id = (select id from atlas.shelves where slug = 'kalshi')
 where main_shelf_id = (select id from atlas.shelves where slug = 'kalshi-inc')
   and not exists (select 1 from atlas.items i2
                    where i2.signal_id = i.signal_id
                      and i2.main_shelf_id = (select id from atlas.shelves where slug = 'kalshi'));" >/dev/null \
  && ok "service_role: items.main_shelf_id move (update (main_shelf_id) is enough)" || bad "service_role items move refused"
"${PSQL[@]}" -c "set role service_role;
update atlas.shelves set aliases = array_append(aliases, 'kalshi-inc') where slug = 'kalshi';" >/dev/null \
  && ok "service_role: shelves.aliases append" || bad "service_role aliases append refused"
"${PSQL[@]}" -c "set role service_role;
update atlas.shelves set status = 'retired' where slug = 'kalshi-inc';" >/dev/null \
  && ok "service_role: shelf retire" || bad "service_role retire refused"
"${PSQL[@]}" -c "set role service_role;
insert into atlas.entity_reviews (shelf_id, signal_id, decision_id, outcome, alias_target_id, applied, decided_by, model_name, reason)
select (select id from atlas.shelves where slug = 'kalshi-inc'), d.signal_id, d.id, 'alias',
       (select id from atlas.shelves where slug = 'kalshi'), true, 'entity-manager', 'glm-5.3-flash', 'r'
  from atlas.decisions d
 where d.signal_id = 's-2';" >/dev/null \
  && ok "service_role: entity_reviews insert with linked decision row" || bad "service_role entity_reviews insert failed"
[[ $(q "select count(*) from atlas.items where signal_id = 's-2' and main_shelf_id = (select id from atlas.shelves where slug = 'kalshi')") == "1" ]] \
  && ok "the non-duplicate item moved to X" || bad "item did not move"
[[ $(q "select count(*) from atlas.items i2 where i2.signal_id = 's-1' and i2.main_shelf_id = (select id from atlas.shelves where slug = 'kalshi-inc')") == "1" ]] \
  && ok "the duplicate item stayed on P (unique index respected)" || bad "duplicate handling wrong"
[[ $(q "select aliases = array['kalshi-inc'] and status = 'active' from atlas.shelves where slug = 'kalshi'") == "t" ]] \
  && ok "X.aliases gained the proposed slug, X still active" || bad "X aliases/status wrong"
[[ $(q "select status = 'retired' from atlas.shelves where slug = 'kalshi-inc'") == "t" ]] \
  && ok "P retired" || bad "P not retired"
[[ $(q "select count(*) from atlas.entity_reviews e join atlas.decisions d on d.id = e.decision_id where e.outcome = 'alias' and e.applied") == "1" ]] \
  && ok "one entity_reviews row with the decision linked" || bad "entity_reviews row wrong"

# The refusals: analyst_worker still cannot touch shelves or read entity_reviews (GRANT level).
if "${PSQL[@]}" -c "set role analyst_worker; update atlas.shelves set status = 'retired' where slug = 'kalshi';" >/dev/null 2>&1; then
  bad "analyst_worker could update a shelf"
else ok "analyst_worker: shelf update still refused"; fi
if "${PSQL[@]}" -c "set role analyst_worker; select count(*) from atlas.entity_reviews;" >/dev/null 2>&1; then
  bad "analyst_worker could read entity_reviews"
else ok "analyst_worker: no entity_reviews access"; fi
if "${PSQL[@]}" -c "set role service_role; update atlas.shelves set name = 'x' where slug = 'kalshi';" >/dev/null 2>&1; then
  bad "service_role could update shelves.name (over-grant)"
else ok "service_role: shelves.name update still refused (column scope holds)"; fi

echo "RESULT: $PASS passed, $FAILS failures"
[[ $FAILS -eq 0 ]]