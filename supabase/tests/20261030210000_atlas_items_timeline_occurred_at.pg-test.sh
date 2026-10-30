#!/usr/bin/env bash
# #391 items timeline occurred_at index test on a THROWAWAY local Postgres 17. Never points at Supabase.
# Applies every atlas migration before 20261030210000, then up / down / down / up / up of this one,
# checking both timeline index definitions via pg_indexes at every step (idempotence included), and
# plans the per-shelf timeline reads (new and restored index) with seqscan off.
# Usage: bash supabase/tests/20261030210000_atlas_items_timeline_occurred_at.pg-test.sh
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
TMP=$(mktemp -d /tmp/issue391pg.XXXX); PORT=$((50000 + RANDOM % 10000)); DB=db391
UP=$REPO/supabase/migrations/20261030210000_atlas_items_timeline_occurred_at.sql
DOWN=$REPO/supabase/rollbacks/20261030210000_atlas_items_timeline_occurred_at.down.sql
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
  [[ $b < 20261030210000 ]] || continue   # this migration is applied below; later ones are not part of this test
  if [[ $b == 20261025100200_atlas_tool_log.sql ]]; then
    "${PSQL[@]}" -c "create table atlas.tool_log (id bigint generated always as identity, logged_at timestamptz not null default now(), run_id text, tool text not null, input jsonb, output jsonb, duration_ms bigint, error text, primary key (logged_at, id)); alter table atlas.tool_log enable row level security;" >/dev/null || { echo "tool_log stand-in failed"; exit 1; }
    continue
  fi
  "${PSQL[@]}" -f "$f" >/dev/null || { echo "apply $b failed"; exit 1; }
done

# Which of the two timeline indexes exists after each step (they are never both present).
STATE="select 'new='||(select count(*) from pg_indexes where schemaname='atlas' and indexname='items_main_shelf_timeline_occurred_idx')||' old='||(select count(*) from pg_indexes where schemaname='atlas' and indexname='items_main_shelf_timeline_idx')"
echo "== up / down / down / up =="
"${PSQL[@]}" -f "$UP"   >/dev/null && ok "up applied"   || bad "up"
[[ $(q "$STATE") == "new=1 old=0" ]] && ok "up: occurred index in, write-time index out ($(q "$STATE"))" || bad "up state: $(q "$STATE")"
q "select pg_get_indexdef('atlas.items_main_shelf_timeline_occurred_idx'::regclass)" | grep -q "(main_shelf_id, occurred_at DESC NULLS LAST, created_at DESC, id DESC)" && ok "occurred index shape (pg_indexes via pg_get_indexdef)" || bad "occurred index shape: $(q "select pg_get_indexdef('atlas.items_main_shelf_timeline_occurred_idx'::regclass)")"
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down applied" || bad "down"
[[ $(q "$STATE") == "new=0 old=1" ]] && ok "down: old index back, occurred index gone" || bad "down state: $(q "$STATE")"
q "select pg_get_indexdef('atlas.items_main_shelf_timeline_idx'::regclass)" | grep -q "(main_shelf_id, created_at DESC, id DESC)" && ok "down: old index shape restored" || bad "old index shape"
"${PSQL[@]}" -f "$DOWN" >/dev/null 2>&1 && ok "down rerun (idempotent)" || bad "down rerun"
[[ $(q "$STATE") == "new=0 old=1" ]] && ok "down rerun: still old only" || bad "down rerun state: $(q "$STATE")"
"${PSQL[@]}" -f "$UP"   >/dev/null && ok "up again applied" || bad "up again"
"${PSQL[@]}" -f "$UP"   >/dev/null 2>&1 && ok "up rerun (idempotent)" || bad "up rerun"
[[ $(q "$STATE") == "new=1 old=0" ]] && ok "up rerun: still new only" || bad "up rerun state: $(q "$STATE")"

# Plan evidence: the two timeline reads each use the index that the state provides.
"${PSQL[@]}" >/dev/null <<'SQL'
insert into atlas.shelves (slug, name, type) values ('hyperliquid','Hyperliquid','protocol');
insert into atlas.items (item_key, title, main_shelf_id, angle) select 'k1', 'Hyperliquid lists perps',   id, 'new_story'      from atlas.shelves where slug = 'hyperliquid';
insert into atlas.items (item_key, title, main_shelf_id, angle) select 'k2', 'Hyperliquid volume record', id, 'existing_story' from atlas.shelves where slug = 'hyperliquid';
SQL
occurred_plan=$("${PSQL[@]}" -t -A -c "set enable_seqscan = off; explain (costs off) select i.id from atlas.items i where i.main_shelf_id = (select id from atlas.shelves where slug = 'hyperliquid') order by i.occurred_at desc nulls last, i.id desc limit 20")
echo "$occurred_plan" | head -3
grep -q "items_main_shelf_timeline_occurred_idx" <<< "$occurred_plan" && ok "timeline read (occurred_at desc nulls last) uses the new index" || bad "occurred plan: $occurred_plan"
"${PSQL[@]}" -f "$DOWN" >/dev/null
created_plan=$("${PSQL[@]}" -t -A -c "set enable_seqscan = off; explain (costs off) select i.id from atlas.items i where i.main_shelf_id = (select id from atlas.shelves where slug = 'hyperliquid') order by i.created_at desc, i.id desc limit 20")
grep -q "items_main_shelf_timeline_idx" <<< "$created_plan" && ok "timeline read after down (created_at desc) uses the restored index" || bad "created plan: $created_plan"
"${PSQL[@]}" -f "$UP" >/dev/null
[[ $(q "$STATE") == "new=1 old=0" ]] && ok "final state: occurred index only" || bad "final state: $(q "$STATE")"

echo "RESULT: $PASS passed, $FAILS failures"
[[ $FAILS -eq 0 ]]