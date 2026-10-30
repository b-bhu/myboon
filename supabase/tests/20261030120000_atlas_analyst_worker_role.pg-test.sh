#!/usr/bin/env bash
# #512 analyst_worker role test on a THROWAWAY local Postgres 17. Never points at Supabase.
# Applies every atlas migration, then up / down / up of 20261030120000, then runs the
# analyst path as analyst_worker (must pass) and the forbidden actions (must be refused).
# Usage: bash supabase/tests/20261030120000_atlas_analyst_worker_role.pg-test.sh
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
TMP=$(mktemp -d /tmp/issue512pg.XXXX); PORT=$((50000 + RANDOM % 10000)); DB=db512
UP=$REPO/supabase/migrations/20261030120000_atlas_analyst_worker_role.sql
DOWN=$REPO/supabase/rollbacks/20261030120000_atlas_analyst_worker_role.down.sql
trap '"$BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
"$BIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
"$BIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null
"$BIN/createdb" -h "$TMP" -p $PORT -U postgres "$DB"
PSQL=(psql -X -q -h "$TMP" -p $PORT -U postgres -d "$DB" -v ON_ERROR_STOP=1)
PASS=0; REFUSED=0; FAILS=0
ok()  { echo "PASS $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL $1"; FAILS=$((FAILS+1)); }

"${PSQL[@]}" -c "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;" >/dev/null
for f in $(ls "$REPO"/supabase/migrations/*_atlas*.sql | sort); do
  b=$(basename "$f")
  [[ $b == 20261030120000_* ]] && continue   # applied below (up/down/up)
  [[ $b > 20261030120000 ]] && continue      # later migrations are not part of this test
  if [[ $b == 20261025100200_atlas_tool_log.sql ]]; then
    # tool_log stand-in (same shape, no pg_cron); RLS on parent and partition, like tool_log_maintain.
    "${PSQL[@]}" -c "create table atlas.tool_log (id bigint generated always as identity, logged_at timestamptz not null default now(), run_id text, tool text not null, input jsonb, output jsonb, duration_ms bigint, error text, primary key (logged_at, id)) partition by range (logged_at); alter table atlas.tool_log enable row level security; create policy analyst_read on atlas.tool_log for select to atlas_analyst using (true); create table atlas.tool_log_d partition of atlas.tool_log default; alter table atlas.tool_log_d enable row level security;" >/dev/null || { echo "tool_log stand-in failed"; exit 1; }
    continue
  fi
  "${PSQL[@]}" -f "$f" >/dev/null || { echo "apply $b failed"; exit 1; }
done
"${PSQL[@]}" -c "create table public.probe (id int); insert into public.probe values (1);" >/dev/null

echo "== up / down / up =="
"${PSQL[@]}" -f "$UP"   >/dev/null && ok "up applied"        || bad "up"
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down applied"      || bad "down"
"${PSQL[@]}" -t -c "select count(*) from pg_roles where rolname='analyst_worker'" | grep -q '^ *0$' && ok "down: role gone" || bad "down: role remains"
"${PSQL[@]}" -t -c "select count(*) from pg_policies where 'analyst_worker' = any(roles)" | grep -q '^ *0$' && ok "down: policies gone" || bad "down: policies remain"
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down rerun (idempotent)" || bad "down rerun"
"${PSQL[@]}" -f "$UP"   >/dev/null && ok "up again applied"  || bad "up again"
"${PSQL[@]}" -t -c "select rolcanlogin, rolinherit, rolbypassrls from pg_roles where rolname='analyst_worker'" | grep -q 'f *| f *| f' && ok "role is nologin noinherit, no bypassrls" || bad "role attrs"

# Seed as postgres: one active shelf and one received signal.
"${PSQL[@]}" >/dev/null <<'SQL'
insert into atlas.shelves (slug, name, type) values ('hyperliquid','Hyperliquid','protocol');
insert into atlas.signals (signal_id, schema_version, source, source_id, type, text, link, occurred_at)
values ('sig-512',1,'x','512','post','Hyperliquid lists new perps','https://x.com/a/status/512', now() - interval '1 hour');
SQL

AS="set role analyst_worker;"
run() { # name, sql (run as analyst_worker in one transaction); stdout -> $TMP/out
  if "${PSQL[@]}" -t -A -c "begin; $AS $2; commit;" >"$TMP/out" 2>"$TMP/err"; then ok "$1"; else bad "$1: $(head -1 "$TMP/err")"; fi
}
refuse() { # name, sql; must fail with permission denied / RLS violation
  if "${PSQL[@]}" -c "begin; $AS $2; commit;" >/dev/null 2>"$TMP/err"; then bad "$1 (accepted)"
  elif grep -qE "permission denied|row-level security" "$TMP/err"; then echo "REFUSED $1 ($(grep -oE 'ERROR: +.*' "$TMP/err" | head -1))"; REFUSED=$((REFUSED+1))
  else bad "$1 failed oddly: $(head -1 "$TMP/err")"; fi
}

echo "== analyst path as analyst_worker (must succeed) =="
run "signal_claim" "select signal_id||'|'||claim_token from atlas.signal_claim('5 minutes'::interval, 'test-worker', 5)"
CLAIM=$(grep sig-512 "$TMP/out"); TOKEN=${CLAIM#*|}
[[ -n $TOKEN && $CLAIM == sig-512* ]] && ok "claimed sig-512" || bad "claim returned: $CLAIM"
run "signal reads (process.ts / d36-worker)" "select signal_id, source, text, excerpt, link from atlas.signals where signal_id='sig-512'"
run "entity search on shelves" "select slug, name, type, aliases from atlas.shelves where status='active'"
# The PgDecisionSink transaction, verbatim shape: decision insert returning, advisory lock,
# active shelf lookup, proposed shelf lookup + insert returning id, item inserts from signals.
run "PgDecisionSink save (decision + lock + shelf + items)" "
  insert into atlas.decisions (schema_version, signal_id, analyst_version, decision_type, summary, decision, reason, targets)
  values (1,'sig-512','d36-test','file','Hyperliquid lists perps','keep','r',
          '[{\"entity\":\"hyperliquid\",\"kind\":\"existing\",\"angle\":\"plain_update\",\"type\":\"protocol\",\"note\":\"n1\"},{\"entity\":\"new-venue\",\"kind\":\"new\",\"angle\":\"new_story\",\"type\":\"organization\",\"note\":\"n2\"}]'::jsonb)
  on conflict (signal_id) do nothing returning signal_id;
  select pg_advisory_xact_lock(hashtext('atlas.shelf:' || 'hyperliquid'));
  select pg_advisory_xact_lock(hashtext('atlas.shelf:' || 'new-venue'));
  select id, status from atlas.shelves where slug = 'new-venue';
  insert into atlas.shelves (slug, name, type, status) values ('new-venue','new-venue','organization','proposed') returning id;
  insert into atlas.items (item_key, title, summary, main_shelf_id, signal_id, angle, note, occurred_at)
    select 'sig-512:hyperliquid','Hyperliquid lists perps','n1',(select id from atlas.shelves where slug='hyperliquid' and status='active'),'sig-512','plain_update','n1', s.occurred_at
      from atlas.signals s where s.signal_id='sig-512' on conflict do nothing;
  insert into atlas.items (item_key, title, summary, main_shelf_id, signal_id, angle, note, occurred_at)
    select 'sig-512:new-venue','Hyperliquid lists perps','n2',(select id from atlas.shelves where slug='new-venue'),'sig-512','new_story','n2', s.occurred_at
      from atlas.signals s where s.signal_id='sig-512' on conflict do nothing"
run "insert into tool_log (partitioned parent)" "insert into atlas.tool_log (run_id, tool, input, output, duration_ms) values ('run-1','search_shelves','{}','{}',12)"
run "signal_finish" "select atlas.signal_finish('sig-512','$TOKEN'::uuid,'analysed',null,null)"
grep -q '^t$' "$TMP/out" && ok "signal_finish returned true" || bad "signal_finish returned $(cat "$TMP/out")"
"${PSQL[@]}" -t -A -c "select (select status from atlas.signals where signal_id='sig-512')||' items='||(select count(*) from atlas.items where signal_id='sig-512')||' decisions='||(select count(*) from atlas.decisions where signal_id='sig-512')||' tool_log='||(select count(*) from atlas.tool_log)||' proposed='||(select count(*) from atlas.shelves where status='proposed')" | tee "$TMP/state"
grep -q '^analysed items=2 decisions=1 tool_log=1 proposed=1$' "$TMP/state" && ok "end state as expected" || bad "end state"
# signal_finish with a decision row, and signal_fail, on a second signal.
"${PSQL[@]}" -c "insert into atlas.signals (signal_id, schema_version, source, source_id, type, text) values ('sig-512b',1,'x','513','post','gm'), ('sig-512c',1,'x','514','post','?')" >/dev/null
run "claim 2" "select claim_token from atlas.signal_claim('5 minutes'::interval,'w',5)"; T2=$(head -1 "$TMP/out")
run "signal_finish with decision jsonb" "select atlas.signal_finish((select signal_id from atlas.signals where claim_token='$T2'::uuid),'$T2'::uuid,'analysed',null,jsonb_build_object('schema_version',1,'signal_id',(select signal_id from atlas.signals where claim_token='$T2'::uuid),'analyst_version','d36-test','decision','ignore','summary','gm','reason','noise'))"
run "claim 3" "select claim_token from atlas.signal_claim('5 minutes'::interval,'w',5)"; T3=$(head -1 "$TMP/out")
run "signal_fail" "select atlas.signal_fail((select signal_id from atlas.signals where claim_token='$T3'::uuid),'$T3'::uuid,'boom','30 seconds'::interval,5)"
grep -q '^retry$' "$TMP/out" && ok "signal_fail returned retry" || bad "signal_fail returned $(cat "$TMP/out")"

echo "== forbidden as analyst_worker (must be refused) =="
refuse "insert into signals" "insert into atlas.signals (signal_id, schema_version, source, source_id, type) values ('x',1,'x','x','post')"
refuse "delete from signals"   "delete from atlas.signals"
refuse "delete from decisions" "delete from atlas.decisions"
refuse "delete from items"     "delete from atlas.items"
refuse "delete from shelves"   "delete from atlas.shelves"
refuse "update items"          "update atlas.items set title='x'"
refuse "update shelves (activate a proposed shelf)" "update atlas.shelves set status='active'"
refuse "update decisions"      "update atlas.decisions set reason='x'"
refuse "select atlas.stories"  "select count(*) from atlas.stories"
refuse "select atlas.story_items" "select count(*) from atlas.story_items"
refuse "insert atlas.stories"  "insert into atlas.stories (slug,title) values ('s','s')"
refuse "select atlas.history"  "select count(*) from atlas.history"
refuse "select atlas.tool_log" "select count(*) from atlas.tool_log"
refuse "select signals.raw_hash (ungranted column)" "select raw_hash from atlas.signals"
refuse "update signals.text (ungranted column)" "update atlas.signals set text='x'"
refuse "select public.probe"   "select * from public.probe"
refuse "insert public.probe"   "insert into public.probe values (2)"
refuse "create table in public" "create table public.evil (id int)"
refuse "create table in atlas" "create table atlas.evil (id int)"
refuse "queue_claim (not granted)" "select * from atlas.queue_claim('q')"

echo "RESULT: $PASS passed, $REFUSED refused as required, $FAILS failures"
[[ $FAILS -eq 0 ]]
