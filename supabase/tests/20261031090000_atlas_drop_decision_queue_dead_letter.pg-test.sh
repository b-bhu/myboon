#!/usr/bin/env bash
# #537 drop decision_queue / dead_letter test on a THROWAWAY local Postgres 17. Never points at Supabase.
# Applies every atlas migration before 20261031090000, fingerprints the objects, then
# up / up / down / down / up and checks the rollback restores the same fingerprint.
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
TMP=$(mktemp -d /tmp/issue537.XXXX); PORT=$((50000 + RANDOM % 10000)); DB=db537
UP=$REPO/supabase/migrations/20261031090000_atlas_drop_decision_queue_dead_letter.sql
DOWN=$REPO/supabase/rollbacks/20261031090000_atlas_drop_decision_queue_dead_letter.down.sql
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
  [[ $b < 20261031090000 ]] || continue
  if [[ $b == 20261025100200_atlas_tool_log.sql ]]; then
    "${PSQL[@]}" -c "create table atlas.tool_log (id bigint generated always as identity, logged_at timestamptz not null default now(), run_id text, tool text not null, input jsonb, output jsonb, duration_ms bigint, error text, primary key (logged_at, id)); alter table atlas.tool_log enable row level security;" >/dev/null || { echo "tool_log stand-in failed"; exit 1; }
    continue
  fi
  "${PSQL[@]}" -f "$f" >/dev/null || { echo "apply $b failed"; exit 1; }
done

FP="select md5(string_agg(x, E'\n' order by x)) from (
  select 'col '||table_name||'.'||column_name||' '||udt_name||' '||is_nullable||' '||coalesce(column_default,'')||' '||coalesce(identity_generation,'') x
    from information_schema.columns where table_schema='atlas' and table_name in ('decision_queue','dead_letter')
  union all select 'idx '||indexdef from pg_indexes where schemaname='atlas' and tablename in ('decision_queue','dead_letter')
  union all select 'con '||conname||' '||pg_get_constraintdef(oid) from pg_constraint where conrelid in (select oid from pg_class where relnamespace='atlas'::regnamespace and relname in ('decision_queue','dead_letter'))
  union all select 'pol '||tablename||' '||policyname||' '||cmd||' '||array_to_string(roles,',')||' '||coalesce(qual,'') from pg_policies where schemaname='atlas' and tablename in ('decision_queue','dead_letter')
  union all select 'acl '||relname||' '||relacl::text||' '||relrowsecurity::text from pg_class where relnamespace='atlas'::regnamespace and relname in ('decision_queue','dead_letter')
  union all select 'fn '||pg_get_functiondef(oid)||' '||coalesce(proacl::text,'') from pg_proc where pronamespace='atlas'::regnamespace and proname in ('queue_claim','queue_heartbeat','queue_complete','queue_fail')
) s"
OBJ="select (select count(*) from pg_class where relnamespace='atlas'::regnamespace and relname in ('decision_queue','dead_letter') and relkind='r') + (select count(*) from pg_proc where pronamespace='atlas'::regnamespace and proname in ('queue_claim','queue_heartbeat','queue_complete','queue_fail'))"
BEFORE=$(q "$FP")
[[ $(q "$OBJ") == 6 ]] && ok "before: 2 tables + 4 functions present" || bad "before objects: $(q "$OBJ")"

"${PSQL[@]}" -f "$UP"   >/dev/null && ok "up applied" || bad "up"
[[ $(q "$OBJ") == 0 ]] && ok "up: tables and functions gone" || bad "up objects: $(q "$OBJ")"
"${PSQL[@]}" -f "$UP"   >/dev/null && ok "up rerun (idempotent)" || bad "up rerun"
[[ $(q "select count(*) from pg_tables where schemaname='atlas' and tablename in ('decisions','entity_reviews','stories','story_items')") == 4 ]] && ok "decisions, entity_reviews, stories, story_items untouched" || bad "kept tables missing"
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down applied" || bad "down"
[[ $(q "$FP") == "$BEFORE" ]] && ok "down: fingerprint matches pre-migration" || bad "down fingerprint differs"
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down rerun (idempotent)" || bad "down rerun"
[[ $(q "$FP") == "$BEFORE" ]] && ok "down rerun: fingerprint still matches" || bad "down rerun fingerprint differs"
"${PSQL[@]}" -f "$UP"   >/dev/null && ok "up again applied" || bad "up again"
[[ $(q "$OBJ") == 0 ]] && ok "up again: gone" || bad "up again objects"

echo "== $PASS passed, $FAILS failures =="
[[ $FAILS == 0 ]]
