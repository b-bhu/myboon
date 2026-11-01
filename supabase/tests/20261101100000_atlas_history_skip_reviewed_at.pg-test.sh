#!/usr/bin/env bash
# #543 history skip for review stamps, on a THROWAWAY local Postgres 17. Never points at Supabase.
# Applies every atlas migration before 20261101100000 (tool_log stand-in, as packages/atlas-schema
# does), seeds an entity and a decision, then up / checks / down / checks / up / up.
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
TMP=$(mktemp -d /tmp/issue543.XXXX); PORT=$((50000 + RANDOM % 10000)); DB=db543
V=20261101100000_atlas_history_skip_reviewed_at
UP=$REPO/supabase/migrations/$V.sql
DOWN=$REPO/supabase/rollbacks/$V.down.sql
trap '"$BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
"$BIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
"$BIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null
"$BIN/createdb" -h "$TMP" -p $PORT -U postgres "$DB"
PSQL=(psql -X -q -h "$TMP" -p $PORT -U postgres -d "$DB" -v ON_ERROR_STOP=1)
PASS=0; FAILS=0
ok()  { echo "PASS $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL $1"; FAILS=$((FAILS+1)); }
q()   { "${PSQL[@]}" -t -A -c "$1" || echo "QUERY-ERROR"; }
check() { local got; got=$(q "$2"); [[ "$got" == "$3" ]] && ok "$1" || bad "$1 (got '$got', want '$3')"; }

"${PSQL[@]}" -c "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;" >/dev/null
for f in $(ls "$REPO"/supabase/migrations/*_atlas*.sql | sort); do
  b=$(basename "$f")
  [[ $b < $V ]] || continue
  [[ $b == 20261031200000_atlas_tool_log_14_ahead.sql ]] && continue
  if [[ $b == 20261025100200_atlas_tool_log.sql ]]; then
    "${PSQL[@]}" -c "create table atlas.tool_log (id bigint generated always as identity, logged_at timestamptz not null default now(), run_id text, tool text not null, input jsonb, output jsonb, duration_ms bigint, error text, primary key (logged_at, id)); alter table atlas.tool_log enable row level security;" >/dev/null || { echo "tool_log stand-in failed"; exit 1; }
    continue
  fi
  "${PSQL[@]}" -f "$f" >/dev/null || { echo "apply $b failed"; exit 1; }
done

"${PSQL[@]}" >/dev/null <<'SQL'
insert into atlas.entities (slug, name, type) values ('kalshi', 'Kalshi', 'organization');
insert into atlas.signals (signal_id, schema_version, source, source_id, type, text, occurred_at)
  values ('s-1', 1, 'x', '1', 'news', 't', now());
insert into atlas.decisions (schema_version, signal_id, analyst_version, action) values (1, 's-1', 'v1', 'keep');
SQL

FN="select md5(pg_get_functiondef('atlas.write_history()'::regprocedure)||coalesce((select proacl::text from pg_proc where oid='atlas.write_history()'::regprocedure),'')||(select proowner::regrole::text from pg_proc where oid='atlas.write_history()'::regprocedure))"
TRG="select md5(string_agg(pg_get_triggerdef(oid), E'\n' order by tgname)) from pg_trigger where not tgisinternal and tgrelid::regclass::text like 'atlas.%'"
H="select count(*) from atlas.history"
fn0=$(q "$FN"); trg0=$(q "$TRG")

# Each case: run the statement, report how many history rows it added.
added() { local b a; b=$(q "$H"); "${PSQL[@]}" -c "$1" >/dev/null || { echo "QUERY-ERROR"; return; }; a=$(q "$H"); echo $((a-b)); }

cases() { # $1 = label, $2 = expected rows for a reviewed-at-only update
  local p=$1
  [[ $(added "update atlas.entities set entity_reviewed_at = clock_timestamp() where slug='kalshi'") == "$2" ]] && ok "$p entities: reviewed_at only -> $2 row(s)" || bad "$p entities: reviewed_at only"
  [[ $(added "update atlas.decisions set entity_reviewed_at = clock_timestamp()") == "$2" ]] && ok "$p decisions: reviewed_at only -> $2 row(s)" || bad "$p decisions: reviewed_at only"
  [[ $(added "update atlas.entities set summary = 'S-$p-'||clock_timestamp() where slug='kalshi'") == 1 ]] && ok "$p entities: real field -> 1 row" || bad "$p entities: real field"
  [[ $(added "update atlas.entities set summary = 'T-$p-'||clock_timestamp(), entity_reviewed_at = clock_timestamp() where slug='kalshi'") == 1 ]] && ok "$p entities: reviewed_at + real field -> 1 row" || bad "$p entities: reviewed_at + real field"
  check "$p   ...that row keeps entity_reviewed_at in changed" "select (changed ? 'entity_reviewed_at' and changed ? 'summary')::text from atlas.history order by id desc limit 1" "true"
  [[ $(added "update atlas.decisions set entity_reason = 'r-$p', entity_reviewed_at = clock_timestamp()") == 1 ]] && ok "$p decisions: reviewed_at + entity_reason -> 1 row" || bad "$p decisions: reviewed_at + entity_reason"
  [[ $(added "update atlas.entities set name = name where slug='kalshi'") == 0 ]] && ok "$p entities: no-op update -> 0 rows (unchanged behaviour)" || bad "$p entities: no-op update"
  [[ $(added "insert into atlas.entities (slug, name, type) values ('tmp-$p', 'Tmp', 'topic')") == 1 ]] && ok "$p insert -> 1 row" || bad "$p insert"
  check "$p   ...insert row has full record" "select (op='INSERT' and changed ? 'entity_reviewed_at' and changed ? 'slug')::text from atlas.history order by id desc limit 1" "true"
  [[ $(added "delete from atlas.entities where slug='tmp-$p'") == 1 ]] && ok "$p delete -> 1 row" || bad "$p delete"
  check "$p   ...delete row has full record" "select (op='DELETE' and changed->>'slug'='tmp-$p')::text from atlas.history order by id desc limit 1" "true"
}

cases before 1
"${PSQL[@]}" -f "$UP" >/dev/null && ok "up applied" || bad "up applied"
cases up1 0
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down applied" || bad "down applied"
[[ $(q "$FN") == "$fn0" ]] && ok "down: function body, ACL and owner identical to pre-migration" || bad "down: function fingerprint"
[[ $(q "$TRG") == "$trg0" ]] && ok "down: trigger bindings unchanged" || bad "down: triggers"
cases down 1
"${PSQL[@]}" -f "$UP" >/dev/null && ok "up again applied" || bad "up again"
fn1=$(q "$FN")
"${PSQL[@]}" -f "$UP" >/dev/null && [[ $(q "$FN") == "$fn1" ]] && ok "rerun: idempotent" || bad "rerun"
[[ $(q "$TRG") == "$trg0" ]] && ok "up: trigger bindings unchanged" || bad "up: triggers"
cases up2 0
echo "passed=$PASS failed=$FAILS"
[[ $FAILS -eq 0 ]] && echo PASS || { echo FAIL; exit 1; }
