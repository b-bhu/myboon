#!/usr/bin/env bash
# #582 web_reader_worker + signals body test on a THROWAWAY local Postgres 17. Never points at Supabase.
# Applies every atlas migration before 20261105180000, then up / down / down / up of this one,
# runs the web reader pick and write as
# web_reader_worker (must pass), and the forbidden actions (must be refused).
# Usage: bash supabase/tests/20261105180000_atlas_web_reader_body.pg-test.sh
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
TMP=$(mktemp -d /tmp/issue582wr.XXXX); PORT=$((50000 + RANDOM % 10000)); DB=db582wr
UP=$REPO/supabase/migrations/20261105180000_atlas_web_reader_body.sql
DOWN=$REPO/supabase/rollbacks/20261105180000_atlas_web_reader_body.down.sql
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
  [[ $b < 20261105180000 ]] || continue
  [[ $b == 20261031200000_atlas_tool_log_14_ahead.sql ]] && continue  # needs pg_cron
  if [[ $b == 20261025100200_atlas_tool_log.sql ]]; then
    "${PSQL[@]}" -c "create table atlas.tool_log (id bigint generated always as identity, logged_at timestamptz not null default now(), run_id text, tool text not null, input jsonb, output jsonb, duration_ms bigint, error text, primary key (logged_at, id)); alter table atlas.tool_log enable row level security;" >/dev/null || { echo "tool_log stand-in failed"; exit 1; }
    continue
  fi
  "${PSQL[@]}" -f "$f" >/dev/null 2>&1 || { echo "apply $b failed"; exit 1; }
done

ROLE="select count(*) from pg_roles where rolname='web_reader_worker'"
POL="select count(*) from pg_policies where 'web_reader_worker' = any(roles)"
COLS="select count(*) from information_schema.columns where table_schema='atlas' and table_name='signals' and column_name in ('body','body_status','body_fetched_at')"
IDX="select count(*) from pg_indexes where schemaname='atlas' and indexname='signals_body_pick_idx'"
# Seed before the up so the up runs on a table with rows (no backfill expected).
"${PSQL[@]}" >/dev/null <<'SQL'
insert into atlas.signals (signal_id, schema_version, source, source_id, type, text, link, occurred_at, fetched_at)
  values ('n-1', 1, 'rss', '1', 'news', 'old with link',  'https://a.example/1', now(), now() - interval '2 hours'),
         ('n-2', 1, 'rss', '2', 'news', 'new with link',  'https://a.example/2', now(), now() - interval '1 hour'),
         ('n-3', 1, 'rss', '3', 'news', 'no link',        null,                  now(), now()),
         ('n-4', 1, 'rss', '4', 'news', 'already done',   'https://a.example/4', now(), now());
SQL

echo "== up / down / down / up =="
"${PSQL[@]}" -f "$UP"   >/dev/null && ok "up applied" || bad "up"
[[ $(q "$POL") == 2 ]] && ok "up: 2 policies" || bad "up policies: $(q "$POL")"
[[ $(q "$COLS") == 3 ]] && ok "up: 3 body columns" || bad "up cols: $(q "$COLS")"
[[ $(q "select count(*) from atlas.signals where body_status is not null or body is not null or body_fetched_at is not null") == 0 ]] && ok "no backfill: existing rows stay null" || bad "backfill happened"
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down applied" || bad "down"
[[ $(q "$ROLE") == 0 ]] && ok "down: role gone" || bad "down: role remains"
[[ $(q "$POL") == 0 ]] && ok "down: policies gone" || bad "down: policies remain"
[[ $(q "$COLS") == 0 ]] && ok "down: columns gone" || bad "down: columns remain"
[[ $(q "$IDX") == 0 ]] && ok "down: index gone" || bad "down: index remains"
[[ $(q "select count(*) from atlas.signals") == 4 ]] && ok "down: signal rows kept" || bad "down lost rows"
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down rerun (idempotent)" || bad "down rerun"
"${PSQL[@]}" -f "$UP"   >/dev/null && ok "up again applied" || bad "up again"
"${PSQL[@]}" -f "$UP"   >/dev/null && ok "up rerun (idempotent)" || bad "up rerun"
[[ $(q "$POL") == 2 ]] && ok "up rerun: still 2 policies" || bad "up rerun policies: $(q "$POL")"
[[ $(q "select count(*) from pg_constraint where conrelid='atlas.signals'::regclass and conname in ('signals_body_length_check','signals_body_status_check')") == 2 ]] && ok "up rerun: 2 checks, not duplicated" || bad "checks"
[[ $(q "$IDX") == 1 ]] && ok "pick index exists" || bad "pick index missing"
[[ $(q "select indexdef like '%(fetched_at DESC, signal_id)%' and indexdef like '%body_status IS NULL%' and indexdef like '%link IS NOT NULL%' from pg_indexes where indexname='signals_body_pick_idx'") == t ]] && ok "pick index shape (fetched_at desc, signal_id) partial" || bad "index shape"
[[ $(q "select rolconnlimit from pg_roles where rolname='web_reader_worker'") == 5 ]] && ok "connection limit 5" || bad "connlimit"
[[ $(q "select array_to_string(array(select unnest(setconfig) order by 1), ',') from pg_db_role_setting where setrole='web_reader_worker'::regrole and setdatabase=0") == "lock_timeout=5s,statement_timeout=60s" ]] && ok "role timeouts set" || bad "role timeouts"
[[ $(q "select rolcanlogin::text||rolinherit::text||rolbypassrls::text||rolsuper::text from pg_roles where rolname='web_reader_worker'") == "falsefalsefalsefalse" ]] \
  && ok "role is nologin noinherit, no bypassrls, not super" || bad "role attrs"
[[ $(q "select has_column_privilege('analyst_worker','atlas.signals','body','select')") == f ]] && ok "analyst_worker has no body grant" || bad "analyst_worker got body"

q "update atlas.signals set body_status='ok', body='done', body_fetched_at=now() where signal_id='n-4'" >/dev/null

AS="set role web_reader_worker;"
run() { if "${PSQL[@]}" -t -A -c "begin; $AS $2; commit;" >"$TMP/out" 2>"$TMP/err"; then ok "$1"; else bad "$1: $(head -1 "$TMP/err")"; fi; }
refuse() {
  if "${PSQL[@]}" -c "begin; $AS $2; commit;" >/dev/null 2>"$TMP/err"; then bad "$1 (accepted)"
  elif grep -qE "permission denied|row-level security" "$TMP/err"; then echo "REFUSED $1"; REFUSED=$((REFUSED+1))
  else bad "$1 failed oddly: $(head -1 "$TMP/err")"; fi
}
check_refuse() {
  if "${PSQL[@]}" -c "begin; $AS $2; commit;" >/dev/null 2>"$TMP/err"; then bad "$1 (accepted)"
  elif grep -q "violates check constraint" "$TMP/err"; then echo "REFUSED $1"; REFUSED=$((REFUSED+1))
  else bad "$1 failed oddly: $(head -1 "$TMP/err")"; fi
}

echo "== web reader path as web_reader_worker =="
run "pick read (skip locked, newest first)" "select signal_id, type, source, link, text, excerpt, fetched_at from atlas.signals where body_status is null and link is not null and type = 'news' order by fetched_at desc, signal_id limit 10 for update skip locked"
[[ $(tr '\n' ' ' < "$TMP/out" | grep -oE 'n-[0-9]' | tr '\n' ' ') == "n-2 n-1 " ]] && ok "pick returns n-2, n-1 (no link-less, no done rows)" || bad "pick rows: $(cat "$TMP/out")"
run "read body fields" "select body, body_status, body_fetched_at from atlas.signals where signal_id='n-4'"
run "mark pending" "update atlas.signals set body_status='pending' where signal_id='n-1'"
run "write ok body" "update atlas.signals set body=repeat('x',4000), body_status='ok', body_fetched_at=now() where signal_id='n-2'"
run "mark unavailable" "update atlas.signals set body=null, body_status='unavailable', body_fetched_at=now() where signal_id='n-1'"
[[ $(q "select body_status||':'||char_length(body) from atlas.signals where signal_id='n-2'") == "ok:4000" ]] && ok "ok body stored" || bad "ok body"
# Second worker skips the row the first one locked.
"${PSQL[@]}" -c "update atlas.signals set body_status=null where signal_id='n-1'" >/dev/null
( "${PSQL[@]}" -c "begin; $AS select signal_id from atlas.signals where signal_id='n-1' and body_status is null and link is not null for update; select pg_sleep(3); commit;" >/dev/null 2>&1 & )
sleep 1
got=$("${PSQL[@]}" -t -A -c "begin; $AS select signal_id from atlas.signals where body_status is null and link is not null order by fetched_at desc for update skip locked; commit;" 2>&1)
[[ -z $got ]] && ok "concurrent pick skips locked row" || bad "skip locked got: $got"
sleep 3

echo "== refusals =="
refuse "signals insert"           "insert into atlas.signals (signal_id, schema_version, source, source_id, type) values ('z',1,'x','z','news')"
refuse "signals delete"           "delete from atlas.signals"
refuse "signals.text update"      "update atlas.signals set text='x' where signal_id='n-1'"
refuse "signals.link update"      "update atlas.signals set link='x' where signal_id='n-1'"
refuse "signals.status update"    "update atlas.signals set status='parked' where signal_id='n-1'"
refuse "signals.claim update"     "update atlas.signals set claim_token=gen_random_uuid(), claimed_by='x' where signal_id='n-1'"
refuse "signals.numbers read"     "select numbers from atlas.signals"
refuse "signals.claim read"       "select claim_token from atlas.signals"
refuse "decisions read"           "select id from atlas.decisions"
refuse "entity_items read"        "select id from atlas.entity_items"
refuse "entities read"            "select id from atlas.entities"
refuse "history read"             "select count(*) from atlas.history"
refuse "signal_claim call"        "select atlas.signal_claim('300 seconds','x',1)"
check_refuse "body over 4000 chars" "update atlas.signals set body=repeat('x',4001) where signal_id='n-3'"
check_refuse "invalid body_status"  "update atlas.signals set body_status='paywalled' where signal_id='n-3'"

echo "RESULT: $PASS passed, $REFUSED refused as expected, $FAILS failures"
[[ $FAILS -eq 0 ]]
