#!/usr/bin/env bash
# #571 task 2 em handoff, on a THROWAWAY local Postgres 17. Never points at Supabase.
# Applies every atlas migration before 20261105150000, seeds a small fixture, then:
#   up -> up (rerun) -> backfill x2 -> acceptance -> guarded downs -> down -> up -> backfill.
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
TMP=$(mktemp -d /tmp/issue571.XXXX); PORT=$((50000 + RANDOM % 10000)); DB=db571
V=20261105150000_atlas_em_handoff
UP=$REPO/supabase/migrations/$V.sql
DOWN=$REPO/supabase/rollbacks/$V.down.sql
BF=$REPO/supabase/backfills
trap '"$BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
"$BIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
"$BIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null
"$BIN/createdb" -h "$TMP" -p $PORT -U postgres "$DB"
PSQL=(psql -X -q -h "$TMP" -p $PORT -U postgres -d "$DB" -v ON_ERROR_STOP=1)
PASS=0; FAILS=0
ok()  { echo "PASS $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL $1"; FAILS=$((FAILS+1)); }
q()   { "${PSQL[@]}" -t -A -c "$1" 2>/dev/null || echo "QUERY-ERROR"; }
check() { local got; got=$(q "$2"); [[ "$got" == "$3" ]] && ok "$1" || bad "$1 (got '$got', want '$3')"; }
rejects() { "${PSQL[@]}" -c "$2" >/dev/null 2>&1 && bad "$1 (was accepted)" || ok "$1"; }
backfill() { (cd "$BF" && "${PSQL[@]}" -t -A -f 571_em_handoff.sql 2>&1 | tail -1); }

"${PSQL[@]}" -c "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;" >/dev/null
for f in $(ls "$REPO"/supabase/migrations/*_atlas*.sql | sort); do
  b=$(basename "$f")
  [[ $b < $V ]] || continue
  [[ $b == 20261031200000_atlas_tool_log_14_ahead.sql ]] && continue
  if [[ $b == 20261025100200_atlas_tool_log.sql ]]; then
    "${PSQL[@]}" -c "create table atlas.tool_log (id bigint generated always as identity, logged_at timestamptz not null default now(), run_id text, tool text not null, input jsonb, output jsonb, duration_ms bigint, error text, primary key (logged_at, id)); alter table atlas.tool_log enable row level security;" >/dev/null || { echo "tool_log stand-in failed"; exit 1; }
    continue
  fi
  "${PSQL[@]}" -f "$f" >/dev/null 2>&1 || { echo "apply $b failed"; exit 1; }
done

"${PSQL[@]}" >/dev/null <<'SQL'
insert into atlas.entities (id, slug, name, type) values
  ('01a17278-0000-7000-8000-000000000001','bitcoin','Bitcoin','asset'),
  ('01a17278-0000-7000-8000-000000000002','binance','Binance','organization');
insert into atlas.signals (signal_id, schema_version, source, source_id, type, raw_ids) values
  ('s1',1,'news','1','news','{"image":"https://img.example/1.jpg"}'),
  ('s2',1,'news','2','news','{"image":"http://img.example/2.jpg"}'),
  ('s3',1,'news','3','news','{}'),
  ('s4',1,'news','4','news','{}'),
  ('s5',1,'news','5','news','{}');
insert into atlas.entity_items (id, item_key, title, main_entity_id, signal_id) values
  ('01a17278-0000-7000-8000-0000000000a1','k1','One','01a17278-0000-7000-8000-000000000001','s1'),
  ('01a17278-0000-7000-8000-0000000000a2','k2','Two','01a17278-0000-7000-8000-000000000001','s2'),
  ('01a17278-0000-7000-8000-0000000000a3','k3','Three','01a17278-0000-7000-8000-000000000002','s3'),
  ('01a17278-0000-7000-8000-0000000000a4','k4','Four','01a17278-0000-7000-8000-000000000002',null);
insert into atlas.decisions (schema_version, signal_id, analyst_version, decision, reason)
  values (1,'s1','legacy','keep','before #571');
SQL

"${PSQL[@]}" -f "$UP" >/dev/null 2>&1 && ok "up applied" || bad "up applied"
"${PSQL[@]}" -f "$UP" >/dev/null 2>&1 && ok "up rerun is a no-op" || bad "up rerun"
check "legacy decision: handoff {} v1, em_status null" "select handoff::text||'|'||handoff_version||'|'||coalesce(em_status,'null') from atlas.decisions where signal_id='s1'" "{}|1|null"

r1=$(backfill); echo "backfill run 1: origin_rows|items_with_signal|items_with_image = $r1"
r2=$(backfill); echo "backfill run 2: $r2"
[[ "$r1" == "3|3|1" ]] && ok "backfill counts 3|3|1 (http image skipped)" || bad "backfill counts ($r1)"
[[ "$r1" == "$r2" ]] && ok "backfill twice: same counts" || bad "backfill twice ($r1 vs $r2)"
check "image_url copied only from https" "select image_url from atlas.entity_items where image_url is not null" "https://img.example/1.jpg"

rejects "handoff must be a json object" "insert into atlas.decisions (schema_version, signal_id, analyst_version, decision, handoff) values (1,'s5','v','ignore','[]')"
rejects "pending needs a non-empty handoff" "insert into atlas.decisions (schema_version, signal_id, analyst_version, decision, em_status) values (1,'s5','v','keep','pending')"
rejects "unknown em_status rejected" "insert into atlas.decisions (schema_version, signal_id, analyst_version, decision, em_status, handoff) values (1,'s5','v','keep','bogus','{\"a\":1}')"
rejects "image_url must be https" "update atlas.entity_items set image_url='http://x/y.png' where item_key='k3'"

# analyst_worker writes handoffs (insert path, like PgHandoffSink) and reads the 8 signal columns
"${PSQL[@]}" >/dev/null 2>&1 <<'SQL' && ok "analyst_worker inserts pending/none handoffs" || bad "analyst_worker inserts handoffs"
set role analyst_worker;
insert into atlas.decisions (schema_version, signal_id, analyst_version, decision, reason, handoff, handoff_version, em_status) values
  (1,'s2','v','keep','r','{"schema_version":1,"entity":null}',1,'pending'),
  (1,'s3','v','keep','r','{"schema_version":1,"entity":{"slug":"binance"}}',1,'pending'),
  (1,'s4','v','ignore','r','{}',1,'none');
SQL
check "analyst_worker reads SignalMetadata columns" "set role analyst_worker; select count(*) from (select schema_version, type, priority, fetched_at, numbers, raw_ids, unusual_score, raw_hash from atlas.signals) s" "5"
rejects "analyst_worker cannot write em claim columns" "set role analyst_worker; insert into atlas.decisions (schema_version, signal_id, analyst_version, decision, em_attempts) values (1,'s5','v','ignore',2)"
rejects "analyst_worker cannot run em_claim" "set role analyst_worker; select * from atlas.em_claim('a')"
rejects "anon cannot run em_claim" "set role anon; select * from atlas.em_claim('a')"
check "em_* functions: no public execute" "select count(*) from pg_proc p where p.pronamespace='atlas'::regnamespace and p.proname like 'em\_%' and has_function_privilege('public', p.oid, 'execute')" "0"

# claim queue as entity_worker
EW="set role entity_worker;"
c1=$(q "$EW select signal_id||'|'||claim_token||'|'||attempts from atlas.em_claim('w1')")
c2=$(q "$EW select signal_id||'|'||claim_token||'|'||attempts from atlas.em_claim('w2')")
c3=$(q "$EW select count(*) from atlas.em_claim('w3')")
[[ ${c1%%|*} == s2 && ${c2%%|*} == s3 ]] && ok "claims oldest pending first, each row once" || bad "claim order ($c1 / $c2)"
[[ "$c3" == "0" ]] && ok "nothing left to claim ('none' and legacy rows never claimed)" || bad "third claim ($c3)"
T1=$(cut -d'|' -f2 <<<"$c1"); T2=$(cut -d'|' -f2 <<<"$c2")
D1=$(q "select id from atlas.decisions where signal_id='s2'"); D2=$(q "select id from atlas.decisions where signal_id='s3'")
check "claimed row has token, expiry ~5 min, attempts 1" "select em_status||'|'||em_attempts||'|'||(em_claim_expires_at - now() between interval '4 min' and interval '5 min') from atlas.decisions where id='$D1'" "claimed|1|true"
check "finish with wrong token -> false" "$EW select atlas.em_finish('$D1', atlas.uuidv7(), 'story')" "f"
rejects "finish duplicate without duplicate_of" "$EW select atlas.em_finish('$D1', '$T1', 'duplicate')"
rejects "finish story with duplicate_of" "$EW select atlas.em_finish('$D1', '$T1', 'story', '01a17278-0000-7000-8000-0000000000a1')"
rejects "finish bad outcome" "$EW select atlas.em_finish('$D1', '$T1', 'pending')"
rejects "duplicate_of must reference an entity item" "$EW select atlas.em_finish('$D1', '$T1', 'duplicate', '01a17278-0000-7000-8000-0000000000ff')"
check "finish duplicate with a real item -> true" "$EW select atlas.em_finish('$D1', '$T1', 'duplicate', '01a17278-0000-7000-8000-0000000000a1')" "t"
check "duplicate row: status, duplicate_of, done_at, claim cleared" "select em_status||'|'||em_duplicate_of||'|'||(em_done_at is not null)||'|'||(em_claim_token is null) from atlas.decisions where id='$D1'" "duplicate|01a17278-0000-7000-8000-0000000000a1|true|true"
check "second finish with the same token -> false" "$EW select atlas.em_finish('$D1', '$T1', 'story')" "f"

check "em_fail attempt 1 -> retry" "$EW select atlas.em_fail('$D2', '$T2', 'boom', interval '0')" "retry"
check "retry row is pending with last_error" "select em_status||'|'||em_last_error from atlas.decisions where id='$D2'" "pending|boom"
c=$(q "$EW select claim_token from atlas.em_claim('w1')"); "${PSQL[@]}" -c "update atlas.decisions set em_claim_expires_at = now() - interval '1 s' where id='$D2'" >/dev/null
check "finish after lease expiry -> false" "$EW select atlas.em_finish('$D2', '$c', 'story')" "f"
c=$(q "$EW select claim_token||'|'||attempts from atlas.em_claim('w2')")
[[ ${c##*|} == 3 ]] && ok "expired lease is reclaimed (attempt 3)" || bad "reclaim ($c)"
check "em_fail at max attempts -> failed" "$EW select atlas.em_fail('$D2', '${c%%|*}', 'boom3')" "failed"
check "failed row: done_at set, claim cleared" "select em_status||'|'||(em_done_at is not null)||'|'||(em_claim_token is null) from atlas.decisions where id='$D2'" "failed|true|true"
"${PSQL[@]}" -c "update atlas.decisions set em_status='claimed', em_attempts=3, em_claim_token=atlas.uuidv7(), em_claim_expires_at=now()-interval '1 s', em_done_at=null where id='$D2'" >/dev/null
check "expired lease at max attempts: em_claim marks failed, claims nothing" "$EW select count(*) from atlas.em_claim('w1')" "0"
check "...and the row is failed" "select em_status from atlas.decisions where id='$D2'" "failed"

# entity_context + item_signals as entity_worker
check "entity_worker inserts entity_context" "$EW insert into atlas.entity_context (entity_id, signal_id, decision_id, reason, sentiment) values ('01a17278-0000-7000-8000-000000000002','s3','$D2','parked: minor update','neutral') returning 1" "1"
rejects "entity_context unique (entity, signal)" "$EW insert into atlas.entity_context (entity_id, signal_id, decision_id, reason) values ('01a17278-0000-7000-8000-000000000002','s3','$D2','again')"
check "entity_context on conflict do nothing (idempotent rerun)" "$EW insert into atlas.entity_context (entity_id, signal_id, decision_id, reason) values ('01a17278-0000-7000-8000-000000000002','s3','$D2','again') on conflict (entity_id, signal_id) do nothing; select count(*) from atlas.entity_context" "1"
rejects "entity_context reason required" "$EW insert into atlas.entity_context (entity_id, signal_id, decision_id, reason) values ('01a17278-0000-7000-8000-000000000001','s3','$D2',null)"
check "entity_context writes history" "select count(*) from atlas.history where table_name='entity_context'" "1"
check "entity_worker inserts item_signals origin" "$EW insert into atlas.item_signals (item_id, signal_id) values ('01a17278-0000-7000-8000-0000000000a4','s4') returning role" "origin"
rejects "item_signals role only origin" "insert into atlas.item_signals (item_id, signal_id, role) values ('01a17278-0000-7000-8000-0000000000a4','s5','update')"
check "entity_worker updates image_url" "$EW update atlas.entity_items set image_url='https://x/4.png' where id='01a17278-0000-7000-8000-0000000000a4' returning 1" "1"
rejects "entity_worker cannot delete entity_context" "$EW delete from atlas.entity_context"

# guarded rollbacks
rejects "backfill down refuses without guard" "\\i $BF/571_em_handoff.down.sql"
rejects "migration down refuses without guard" "\\i $DOWN"
PGOPTIONS="-c myboon.allow_571_wipe=pre-cutover" "${PSQL[@]}" -f "$BF/571_em_handoff.down.sql" >/dev/null 2>&1 && ok "backfill down with guard" || bad "backfill down with guard"
check "backfill down emptied origin rows" "select count(*) from atlas.item_signals" "0"
PGOPTIONS="-c myboon.allow_571_wipe=pre-cutover" "${PSQL[@]}" -f "$DOWN" >/dev/null 2>&1 && ok "down with guard" || bad "down with guard"
check "down removed columns, table, functions" "select (select count(*) from information_schema.columns where table_schema='atlas' and ((table_name='decisions' and (column_name like 'em\_%' or column_name like 'handoff%')) or (table_name='entity_items' and column_name='image_url') or (table_name='item_signals' and column_name='role')))||'|'||(to_regclass('atlas.entity_context') is null)||'|'||(select count(*) from pg_proc where proname like 'em\_%')" "0|true|0"
check "down revoked the 8 signal column grants" "select has_column_privilege('analyst_worker','atlas.signals','raw_hash','select')" "f"
PGOPTIONS="-c myboon.allow_571_wipe=pre-cutover" "${PSQL[@]}" -f "$DOWN" >/dev/null 2>&1 && ok "down rerun is a no-op" || bad "down rerun"
"${PSQL[@]}" -f "$UP" >/dev/null 2>&1 && ok "up again after down" || bad "up again after down"
r3=$(backfill); [[ "$r3" == "3|3|1" ]] && ok "backfill after re-up: 3|3|1 (origin links and image re-copied)" || bad "backfill after re-up ($r3)"

echo "== $PASS passed, $FAILS failed"
[[ $FAILS -eq 0 ]]
