#!/usr/bin/env bash
# #480/#537 entity review on decisions + drops test on a THROWAWAY local Postgres 17. Never points at Supabase.
# Applies every atlas migration before 20261031090000, fingerprints the objects, then
# up / up / down / down / up and checks the rollback restores the same fingerprint.
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
TMP=$(mktemp -d /tmp/issue537.XXXX); PORT=$((50000 + RANDOM % 10000)); DB=db537
UP=$REPO/supabase/migrations/20261031090000_atlas_entity_review_on_decisions.sql
DOWN=$REPO/supabase/rollbacks/20261031090000_atlas_entity_review_on_decisions.down.sql
trap '"$BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
"$BIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
"$BIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null
"$BIN/createdb" -h "$TMP" -p $PORT -U postgres "$DB"
PSQL=(psql -X -q -h "$TMP" -p $PORT -U postgres -d "$DB" -v ON_ERROR_STOP=1)
PASS=0; FAILS=0; REFUSED=0
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
    from information_schema.columns where table_schema='atlas' and table_name in ('decision_queue','dead_letter','entity_reviews','decisions')
  union all select 'idx '||indexdef from pg_indexes where schemaname='atlas' and tablename in ('decision_queue','dead_letter','entity_reviews','decisions')
  union all select 'con '||conrelid::regclass::text||' '||conname||' '||pg_get_constraintdef(oid) from pg_constraint where conrelid in (select oid from pg_class where relnamespace='atlas'::regnamespace and relname in ('decision_queue','dead_letter','entity_reviews','decisions'))
  union all select 'pol '||tablename||' '||policyname||' '||cmd||' '||array_to_string(roles,',')||' '||coalesce(qual,'')||' '||coalesce(with_check,'') from pg_policies where schemaname='atlas' and tablename in ('decision_queue','dead_letter','entity_reviews','decisions')
  union all select 'acl '||relname||' '||coalesce(relacl::text,'')||' '||relrowsecurity::text from pg_class where relnamespace='atlas'::regnamespace and relname in ('decision_queue','dead_letter','entity_reviews','decisions')
  union all select 'colacl '||attrelid::regclass::text||'.'||attname||' '||attacl::text from pg_attribute where attrelid in (select oid from pg_class where relnamespace='atlas'::regnamespace and relname in ('decision_queue','dead_letter','entity_reviews','decisions')) and attacl is not null
  union all select 'fn '||pg_get_functiondef(oid)||' '||coalesce(proacl::text,'') from pg_proc where pronamespace='atlas'::regnamespace and proname in ('queue_claim','queue_heartbeat','queue_complete','queue_fail','analyst_targets_valid')
) s"
OBJ="select (select count(*) from pg_class where relnamespace='atlas'::regnamespace and relname in ('decision_queue','dead_letter','entity_reviews') and relkind='r') + (select count(*) from pg_proc where pronamespace='atlas'::regnamespace and proname in ('queue_claim','queue_heartbeat','queue_complete','queue_fail'))"
NEWCOLS="select count(*) from information_schema.columns where table_schema='atlas' and table_name='decisions' and column_name like 'entity\_%'"
BEFORE=$(q "$FP")
[[ $(q "$OBJ") == 7 ]] && ok "before: 3 tables + 4 functions present" || bad "before objects: $(q "$OBJ")"

echo "== up / up / down / down / up =="
"${PSQL[@]}" -f "$UP"   >/dev/null && ok "up applied" || bad "up"
[[ $(q "$OBJ") == 0 ]] && ok "up: entity_reviews, queue tables and functions gone" || bad "up objects: $(q "$OBJ")"
"${PSQL[@]}" -f "$UP"   >/dev/null && ok "up rerun (idempotent)" || bad "up rerun"
[[ $(q "select count(*) from pg_tables where schemaname='atlas' and tablename in ('decisions','shelves','items','stories','story_items')") == 5 ]] && ok "decisions, shelves, items, stories, story_items kept" || bad "kept tables missing"
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down applied" || bad "down"
[[ $(q "$FP") == "$BEFORE" ]] && ok "down: fingerprint matches pre-migration" || bad "down fingerprint differs"
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down rerun (idempotent)" || bad "down rerun"
[[ $(q "$FP") == "$BEFORE" ]] && ok "down rerun: fingerprint still matches" || bad "down rerun fingerprint differs"
"${PSQL[@]}" -f "$UP"   >/dev/null && ok "up again applied" || bad "up again"

echo "== shape after up =="
[[ $(q "$NEWCOLS and is_nullable='YES' and column_default is null") == 5 ]] && ok "5 entity_* columns, nullable, no defaults" || bad "new cols: $(q "$NEWCOLS")"
[[ $(q "select convalidated from pg_constraint where conname='decisions_entity_alias_target_id_fkey'") == t ]] && ok "alias target FK validated" || bad "FK not validated"
[[ $(q "select count(*) from pg_indexes where schemaname='atlas' and indexname in ('decisions_entity_alias_target_id_idx','decisions_entity_unreviewed_idx')") == 2 ]] && ok "FK index + partial unreviewed index" || bad "indexes"
[[ $(q "select count(*) from pg_index i join pg_class c on c.oid=i.indexrelid where c.relname like 'decisions_entity_%' and not i.indisvalid") == 0 ]] && ok "indexes valid" || bad "invalid index"
[[ $(q "select count(*) from pg_policies where 'entity_worker' = any(roles) and tablename='decisions' and policyname='entity_worker_update' and cmd='UPDATE' and qual='true' and with_check='true'") == 1 ]] && ok "entity_worker_update policy" || bad "update policy"
[[ $(q "select has_function_privilege('entity_worker','atlas.analyst_targets_valid(jsonb)','execute')::text") == true ]] && ok "entity_worker execute analyst_targets_valid" || bad "execute grant"
[[ $(q "select count(*) from information_schema.table_privileges where grantee='entity_worker' and table_schema='atlas' and table_name='decisions'") == 0 ]] && ok "no table-wide grants on decisions" || bad "table-wide grants"

"${PSQL[@]}" >/dev/null <<'SQL'
insert into atlas.shelves (slug, name, type) values ('kalshi', 'Kalshi', 'organization');
insert into atlas.signals (signal_id, schema_version, source, source_id, type, text, link, occurred_at)
  values ('s-1', 1, 'x', '1', 'news', 't', null, now());
insert into atlas.decisions (schema_version, signal_id, analyst_version, decision_type, summary, decision, reason, targets, decided_by)
  values (1, 's-1', 'analyst-504-v1', 'file', 's', 'keep', 'r', '[]'::jsonb, 'jev');
SQL
AS="set role entity_worker;"
refuse() {
  if "${PSQL[@]}" -c "begin; $AS $2; rollback;" >/dev/null 2>"$TMP/err"; then bad "$1 (accepted)"
  elif grep -qE "permission denied|row-level security" "$TMP/err"; then echo "REFUSED $1"; REFUSED=$((REFUSED+1))
  else bad "$1 failed oddly: $(head -1 "$TMP/err")"; fi
}
echo "== entity_worker on decisions =="
UPD="update atlas.decisions set entity_outcome='alias', entity_alias_target_id=(select id from atlas.shelves where slug='kalshi'), entity_reviewed_at=now(), entity_model_name='m', entity_reason='r' where signal_id='s-1' and entity_reviewed_at is null"
out=$("${PSQL[@]}" -t -A -c "begin; $AS $UPD returning entity_outcome; rollback;" 2>&1)
[[ $out == alias ]] && ok "UPDATE of entity_* columns as entity_worker (rolled back)" || bad "entity update: $out"
[[ $(q "select count(*) from atlas.decisions where entity_outcome is not null") == 0 ]] && ok "rolled back: no entity values left" || bad "update leaked"
"${PSQL[@]}" -t -A -c "begin; $AS select id, signal_id, entity_outcome, entity_reviewed_at from atlas.decisions; rollback;" >/dev/null 2>&1 && ok "select granted columns" || bad "select granted columns"
refuse "insert into decisions" "insert into atlas.decisions (schema_version, signal_id, analyst_version, decision_type, summary, decision, reason, targets, decided_by) values (1,'s-1','v2','file','s','keep','r','[]','x')"
refuse "update non-entity column" "update atlas.decisions set decision='drop' where signal_id='s-1'"
refuse "select entity_reason (not granted)" "select entity_reason from atlas.decisions"
refuse "delete from decisions" "delete from atlas.decisions"

echo "== history trigger =="
"${PSQL[@]}" -c "$UPD" >/dev/null
h=$(q "select changed ?& array['entity_outcome','entity_alias_target_id','entity_reviewed_at','entity_model_name','entity_reason'] from atlas.history where table_name='decisions' and op='UPDATE' order by id desc limit 1")
[[ $h == t ]] && ok "decisions_history logs UPDATE with all 5 entity_* columns" || bad "history: $h"

echo "== $PASS passed, $REFUSED refused, $FAILS failures =="
[[ $FAILS == 0 ]]
