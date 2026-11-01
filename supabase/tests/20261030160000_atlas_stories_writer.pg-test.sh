#!/usr/bin/env bash
# #505 stories writer schema test on a THROWAWAY local Postgres 17. Never points at Supabase.
# Applies every atlas migration before 20261030160000, then up / down / down / up of it, then
# runs the story writer path as analyst_worker (must pass) and forbidden actions (must be refused).
# Usage: bash supabase/tests/20261030160000_atlas_stories_writer.pg-test.sh
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
TMP=$(mktemp -d /tmp/issue505pg.XXXX); PORT=$((50000 + RANDOM % 10000)); DB=db505
UP=$REPO/supabase/migrations/20261030160000_atlas_stories_writer.sql
DOWN=$REPO/supabase/rollbacks/20261030160000_atlas_stories_writer.down.sql
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
  [[ $b < 20261030160000 ]] || continue   # this migration is applied below; later ones are not part of this test
  if [[ $b == 20261025100200_atlas_tool_log.sql ]]; then
    "${PSQL[@]}" -c "create table atlas.tool_log (id bigint generated always as identity, logged_at timestamptz not null default now(), run_id text, tool text not null, input jsonb, output jsonb, duration_ms bigint, error text, primary key (logged_at, id)); alter table atlas.tool_log enable row level security;" >/dev/null || { echo "tool_log stand-in failed"; exit 1; }
    continue
  fi
  "${PSQL[@]}" -f "$f" >/dev/null || { echo "apply $b failed"; exit 1; }
done

STATE="select (select count(*) from information_schema.columns where table_schema='atlas' and table_name='stories' and column_name in ('shelf_id','status'))||' idx='||(select count(*) from pg_indexes where schemaname='atlas' and indexname='stories_shelf_open_idx')||' pol='||(select count(*) from pg_policies where schemaname='atlas' and tablename in ('stories','story_items') and 'analyst_worker'=any(roles))||' priv='||(select count(*) from information_schema.column_privileges where table_schema='atlas' and table_name in ('stories','story_items') and grantee='analyst_worker')"
echo "== up / down / down / up =="
"${PSQL[@]}" -f "$UP"   >/dev/null && ok "up applied"   || bad "up"
[[ $(q "$STATE") == "2 idx=1 pol=5 priv="* ]] && ok "up: columns, index, 5 policies ($(q "$STATE"))" || bad "up state: $(q "$STATE")"
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down applied" || bad "down"
[[ $(q "$STATE") == "0 idx=0 pol=0 priv=0" ]] && ok "down: columns, index, policies, grants gone" || bad "down state: $(q "$STATE")"
q "select count(*) from pg_policies where tablename in ('stories','story_items') and policyname='analyst_read'" | grep -qx 2 && ok "down: existing analyst_read policies kept" || bad "down removed analyst_read"
"${PSQL[@]}" -f "$DOWN" >/dev/null 2>&1 && ok "down rerun (idempotent)" || bad "down rerun"
"${PSQL[@]}" -f "$UP"   >/dev/null && ok "up again applied" || bad "up again"
[[ $(q "$STATE") == "2 idx=1 pol=5 priv="* ]] && ok "up again state" || bad "up again state: $(q "$STATE")"
q "select pg_get_constraintdef(oid) from pg_constraint where conname='stories_status_check'" | grep -q "'open'::text, 'closed'::text" && ok "status check is open/closed" || bad "status check"
q "select count(*) from pg_indexes where schemaname='atlas' and tablename='stories' and indexdef ilike '%unique%' and indexdef ilike '%shelf_id%'" | grep -qx 0 && ok "no unique one-open-per-entity index (row 6 out of scope)" || bad "unique index present"
q "select pg_get_indexdef('atlas.stories_shelf_open_idx'::regclass)" | grep -q "(shelf_id, created_at DESC) WHERE (status = 'open'::text)" && ok "open-story index shape" || bad "index shape"

# Guard: the up refuses a non-empty stories table.
"${PSQL[@]}" -f "$DOWN" >/dev/null
q "insert into atlas.stories (slug,title) values ('pre','pre')" >/dev/null
if "${PSQL[@]}" -f "$UP" >/dev/null 2>"$TMP/err"; then bad "guard: up accepted non-empty stories"; else grep -q "not empty" "$TMP/err" && ok "guard: up aborts on non-empty stories" || bad "guard odd: $(head -1 "$TMP/err")"; fi
q "delete from atlas.stories" >/dev/null
"${PSQL[@]}" -f "$UP" >/dev/null && ok "up after guard test" || bad "up after guard"

"${PSQL[@]}" >/dev/null <<'SQL'
insert into atlas.shelves (slug, name, type) values ('hyperliquid','Hyperliquid','protocol');
insert into atlas.items (item_key, title, main_shelf_id, angle)
  select 'k1','Hyperliquid lists perps', id, 'new_story' from atlas.shelves where slug='hyperliquid';
insert into atlas.items (item_key, title, main_shelf_id, angle)
  select 'k2','Hyperliquid volume record', id, 'existing_story' from atlas.shelves where slug='hyperliquid';
SQL

AS="set role analyst_worker;"
run() { if "${PSQL[@]}" -t -A -c "begin; $AS $2; commit;" >"$TMP/out" 2>"$TMP/err"; then ok "$1"; else bad "$1: $(head -1 "$TMP/err")"; fi; }
refuse() {
  if "${PSQL[@]}" -c "begin; $AS $2; commit;" >/dev/null 2>"$TMP/err"; then bad "$1 (accepted)"
  elif grep -qE "permission denied|row-level security|must be owner" "$TMP/err"; then echo "REFUSED $1 ($(grep -oE 'ERROR: +.*' "$TMP/err" | head -1))"; REFUSED=$((REFUSED+1))
  else bad "$1 failed oddly: $(head -1 "$TMP/err")"; fi
}

echo "== story writer path as analyst_worker (must succeed) =="
run "create story (insert returning id) + link item" "
  select pg_advisory_xact_lock(hashtext('atlas.shelf:' || 'hyperliquid'));
  with s as (insert into atlas.stories (shelf_id, slug, title)
             select id, 'hyperliquid-0001', 'Hyperliquid lists perps' from atlas.shelves where slug='hyperliquid' returning id)
  insert into atlas.story_items (story_id, item_id, position)
    select s.id, i.id, 1 from s, atlas.items i where i.item_key='k1'"
run "latest open story for the entity" "
  select st.id from atlas.stories st join atlas.shelves sh on sh.id=st.shelf_id
  where sh.slug='hyperliquid' and st.status='open' order by st.created_at desc limit 1"
SID=$(head -1 "$TMP/out"); [[ -n $SID ]] && ok "found open story" || bad "no open story"
run "extend: link second item, update text" "
  insert into atlas.story_items (story_id, item_id, position) select '$SID', id, 2 from atlas.items where item_key='k2';
  update atlas.stories set title='Hyperliquid: perps and record volume', summary='filled', updated_at=now() where id='$SID'"
run "new items: items without a story_items row" "select count(*) from atlas.items i where i.angle in ('new_story','existing_story') and not exists (select 1 from atlas.story_items si where si.item_id=i.id)"
grep -qx 0 "$TMP/out" && ok "no unlinked items left" || bad "unlinked: $(cat "$TMP/out")"
[[ $(q "select status||'|'||summary||'|'||(select count(*) from atlas.story_items where story_id=s.id) from atlas.stories s where id='$SID'") == "open|filled|2" ]] && ok "end state open|filled|2" || bad "end state"
q "select count(*) from atlas.history where table_name in ('stories','story_items')" | grep -qvx 0 && ok "history trigger wrote rows" || bad "no history rows"

echo "== forbidden as analyst_worker (must be refused) =="
refuse "update stories.status (row 7 out of scope)" "update atlas.stories set status='closed'"
refuse "update stories.shelf_id"   "update atlas.stories set shelf_id=shelf_id"
refuse "update stories.slug"       "update atlas.stories set slug='x'"
refuse "insert stories.id (ungranted column)" "insert into atlas.stories (id, shelf_id, slug, title) select gen_random_uuid(), id, 'x', 'x' from atlas.shelves limit 1"
refuse "insert stories.created_at" "insert into atlas.stories (shelf_id, slug, title, created_at) select id, 'y', 'y', now() from atlas.shelves limit 1"
refuse "delete from stories"       "delete from atlas.stories"
refuse "truncate stories"          "truncate atlas.stories"
refuse "update story_items"        "update atlas.story_items set position=9"
refuse "delete from story_items"   "delete from atlas.story_items"
refuse "insert story_items.created_at" "insert into atlas.story_items (story_id, item_id, created_at) select '$SID', id, now() from atlas.items where item_key='k1'"
refuse "select atlas.history"      "select count(*) from atlas.history"
refuse "alter table stories"       "alter table atlas.stories add column x int"

echo "== forward: apply every later atlas migration (incl. #541 rename) =="
# Assertions above are pinned to this migration's point in history (pre-#541 names).
# This section checks the same objects under their current names after all migrations.
for f in $(ls "$REPO"/supabase/migrations/*_atlas*.sql | sort); do
  b=$(basename "$f"); [[ $b > 20261030160000_~ ]] || continue
  "${PSQL[@]}" -f "$f" >/dev/null || { bad "apply $b"; continue; }
done
q "select count(*) from information_schema.columns where table_schema='atlas' and table_name='stories' and column_name in ('entity_id','status')" | grep -qx 2 && ok "after all: stories.entity_id + status" || bad "after all: stories columns"
q "select pg_get_indexdef('atlas.stories_entity_open_idx'::regclass)" | grep -q "(entity_id, created_at DESC) WHERE (status = 'open'::text)" && ok "after all: stories_entity_open_idx shape" || bad "after all: index"
q "select count(*) from atlas.stories where id='$SID'" | grep -qx 1 && ok "after all: story row survives rename" || bad "after all: story row"

echo "RESULT: $PASS passed, $REFUSED refused as required, $FAILS failures"
[[ $FAILS -eq 0 ]]
