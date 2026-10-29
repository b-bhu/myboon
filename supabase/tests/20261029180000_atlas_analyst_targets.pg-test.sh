#!/usr/bin/env bash
# #503 (D36) acceptance test on a THROWAWAY local Postgres 17. Never points at Supabase.
# 1. applies every atlas migration before #503 and shows the acceptance scenarios FAIL,
# 2. applies #503, runs the scenarios (as service_role), 3. down, checks the old shape
# and that data survived, 4. up again and reruns the scenarios.
# Usage: bash supabase/tests/20261029180000_atlas_analyst_targets.pg-test.sh
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
TMP=$(mktemp -d /tmp/issue503pg.XXXX); PORT=55503; DB=db503
UP=$REPO/supabase/migrations/20261029180000_atlas_analyst_targets.sql
DOWN=$REPO/supabase/rollbacks/20261029180000_atlas_analyst_targets.down.sql
trap '"$BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
"$BIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
"$BIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null
"$BIN/createdb" -h "$TMP" -p $PORT -U postgres "$DB"
PSQL=(psql -X -q -h "$TMP" -p $PORT -U postgres -d "$DB" -v ON_ERROR_STOP=1)
FAILS=0
ok()   { echo "PASS $1"; }
bad()  { echo "FAIL $1"; FAILS=$((FAILS+1)); }

"${PSQL[@]}" -c "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;" >/dev/null
for f in $(ls "$REPO"/supabase/migrations/*_atlas*.sql | sort); do
  b=$(basename "$f")
  [[ $b == 20261025100200_atlas_tool_log.sql ]] && continue   # needs pg_cron
  [[ $b == 20261029180000_* ]] && continue
  "${PSQL[@]}" -f "$f" >/dev/null || { echo "apply $b failed"; exit 1; }
done
# tool_log stand-in (same shape, no pg_cron) so the #503 grant/revoke is exercised.
"${PSQL[@]}" -c "create table atlas.tool_log (id bigint generated always as identity, logged_at timestamptz not null default now(), run_id text, tool text not null, input jsonb, output jsonb, duration_ms bigint, error text, primary key (logged_at, id)) partition by range (logged_at); create table atlas.tool_log_d partition of atlas.tool_log default; grant usage on schema atlas to service_role;" >/dev/null

# Seed: real-shaped scout signals and three existing shelves (spike v5 worked example),
# plus one pre-#503 one-target decision row that must migrate to a 1-element targets.
"${PSQL[@]}" >/dev/null <<'SQL'
insert into atlas.shelves (slug, name, type) values
  ('trade-xyz','trade(xyz)','protocol'),
  ('intercontinental-exchange-ice','Intercontinental Exchange (ICE)','organization'),
  ('hyperliquid','Hyperliquid','protocol');
insert into atlas.signals (signal_id, schema_version, source, source_id, type, text, link) values
  ('test-standuquesne-2115777839622689036',1,'x','2115777839622689036','post','Invested in trade(xyz); partnering with ICE to bring 24/7 Hyperliquid perps to the US','https://x.com/standuquesne/status/2115777839622689036'),
  ('sig-ignore',1,'x','1','post','gm',null),
  ('sig-unclear',1,'x','2','post','?',null),
  ('sig-new',1,'news','3','news','ADGM publishes a new framework',null),
  ('sig-legacy',1,'x','4','post','legacy',null);
insert into atlas.decisions (schema_version, signal_id, analyst_version, action, reason, shelves)
values (1,'sig-legacy','v0','keep','old one-target row','[{"slug":"hyperliquid"}]');
SQL

# Each scenario prints PASS/FAIL; errors inside a scenario count as FAIL.
scenarios() {
  local tag=$1
  run() { # name, sql (as service_role, in a rolled-back-or-committed tx)
    if "${PSQL[@]}" -c "$2" >/dev/null 2>"$TMP/err"; then ok "$tag $1"; else bad "$tag $1 ($(head -1 "$TMP/err"))"; fi
  }
  rej() { # name, sql expected to be rejected
    "${PSQL[@]}" -c "$2" >/dev/null 2>"$TMP/err"; local why; why=$(grep -o 'violates check constraint "[a-z_]*"\|needs status [a-z]*' "$TMP/err" | head -1)
    if [[ -n $why ]]; then ok "$tag $1 ($why)"; else bad "$tag $1 (not rejected by a #503 rule: $(head -1 "$TMP/err"))"; fi
  }
  "${PSQL[@]}" -c "delete from atlas.item_signals; delete from atlas.items; delete from atlas.decisions where signal_id <> 'sig-legacy'; delete from atlas.shelves where slug='adgm'; update atlas.signals set status='received', claim_token=null, claim_expires_at=null, parked_reason=null where signal_id <> 'sig-legacy'" >/dev/null 2>&1
  local KEEP='{"schema_version":1,"signal_id":"test-standuquesne-2115777839622689036","analyst_version":"analyst-v5","summary":"Druckenmiller invests in trade(xyz), which partners with ICE","decision":"keep","reason":"traders care","targets":[{"entity":"trade-xyz","kind":"existing","type":"protocol","angle":"new_story","note":"An investor posted his stake."},{"entity":"intercontinental-exchange-ice","kind":"existing","type":"organization","angle":"new_story","note":"Per an investor post, ICE partners with trade(xyz)."},{"entity":"hyperliquid","kind":"existing","type":"protocol","angle":"existing_story","note":"Talk of Hyperliquid perps for US users."}]}'
  # Claim via a token then finish; filing = the entity manager's inserts, rerun-safe.
  local FINISH="set role service_role; update atlas.signals set claim_token='00000000-0000-0000-0000-000000000001', claim_expires_at=now()+interval '5 min' where signal_id=:'sid';"
  local FILE="insert into atlas.items (item_key, title, main_shelf_id, signal_id, angle, note)
     select d.signal_id||':'||(t->>'entity'), d.summary, s.id, d.signal_id, t->>'angle', t->>'note'
       from atlas.decisions d cross join jsonb_array_elements(d.targets) t join atlas.shelves s on s.slug = t->>'entity'
      where d.signal_id = 'test-standuquesne-2115777839622689036'
     on conflict (item_key) do nothing;
     insert into atlas.item_signals (item_id, signal_id) select id, signal_id from atlas.items where signal_id='test-standuquesne-2115777839622689036' on conflict do nothing;"
  for i in 1 2; do  # second pass = same signal filed twice
    run "keep-3-targets finish pass $i" "reset role; update atlas.signals set claim_token='00000000-0000-0000-0000-000000000001', claim_expires_at=now()+interval '5 min' where signal_id='test-standuquesne-2115777839622689036'; set role service_role; select atlas.signal_finish('test-standuquesne-2115777839622689036','00000000-0000-0000-0000-000000000001','analysed',null,'$KEEP'::jsonb); $FILE"
  done
  run "keep: 1 decision, 3 items on 3 shelves, 3 item_signals" "do \$\$ begin if (select count(*) from atlas.decisions where signal_id='test-standuquesne-2115777839622689036')<>1 or (select count(distinct main_shelf_id) from atlas.items where signal_id='test-standuquesne-2115777839622689036')<>3 or (select count(*) from atlas.items where signal_id='test-standuquesne-2115777839622689036')<>3 or (select count(*) from atlas.item_signals where signal_id='test-standuquesne-2115777839622689036')<>3 then raise exception 'counts wrong'; end if; end \$\$"
  run "ignore -> analysed, empty targets, no items" "update atlas.signals set claim_token='00000000-0000-0000-0000-000000000002', claim_expires_at=now()+interval '5 min' where signal_id='sig-ignore'; set role service_role; select atlas.signal_finish('sig-ignore','00000000-0000-0000-0000-000000000002','analysed',null,'{\"schema_version\":1,\"signal_id\":\"sig-ignore\",\"analyst_version\":\"analyst-v5\",\"summary\":\"gm\",\"decision\":\"ignore\",\"reason\":\"noise\",\"targets\":[]}'::jsonb); reset role; do \$\$ begin if (select targets from atlas.decisions where signal_id='sig-ignore')<>'[]' or (select status from atlas.signals where signal_id='sig-ignore')<>'analysed' or exists(select 1 from atlas.items where signal_id='sig-ignore') then raise exception 'ignore wrong'; end if; end \$\$"
  run "unclear -> parked" "update atlas.signals set claim_token='00000000-0000-0000-0000-000000000003', claim_expires_at=now()+interval '5 min' where signal_id='sig-unclear'; set role service_role; select atlas.signal_finish('sig-unclear','00000000-0000-0000-0000-000000000003','parked','decision tool unreachable','{\"schema_version\":1,\"signal_id\":\"sig-unclear\",\"analyst_version\":\"analyst-v5\",\"decision\":\"unclear\",\"reason\":\"timeout\",\"targets\":[]}'::jsonb); reset role; do \$\$ begin if (select status from atlas.signals where signal_id='sig-unclear')<>'parked' then raise exception 'not parked'; end if; end \$\$"
  local T='{"entity":"a","kind":"existing","type":"protocol","angle":"new_story","note":"n"}'
  rej "4 targets rejected" "insert into atlas.decisions (schema_version,signal_id,analyst_version,decision,targets) values (1,'sig-new','x','keep','[$T,${T/\"a\"/\"b\"},${T/\"a\"/\"c\"},${T/\"a\"/\"d\"}]')"
  rej "duplicate slug rejected" "insert into atlas.decisions (schema_version,signal_id,analyst_version,decision,targets) values (1,'sig-new','x','keep','[$T,$T]')"
  rej "bad angle rejected" "insert into atlas.decisions (schema_version,signal_id,analyst_version,decision,targets) values (1,'sig-new','x','keep','[${T/new_story/big_story}]')"
  rej "bad kind rejected" "insert into atlas.decisions (schema_version,signal_id,analyst_version,decision,targets) values (1,'sig-new','x','keep','[${T/existing/maybe}]')"
  rej "targets on ignore rejected" "insert into atlas.decisions (schema_version,signal_id,analyst_version,decision,targets) values (1,'sig-new','x','ignore','[$T]')"
  rej "bad item angle rejected" "insert into atlas.items (item_key,title,main_shelf_id,angle) select 'k','t',id,'big_story' from atlas.shelves limit 1"
  rej "unclear finished as analysed rejected" "update atlas.signals set claim_token='00000000-0000-0000-0000-000000000004', claim_expires_at=now()+interval '5 min' where signal_id='sig-new'; select atlas.signal_finish('sig-new','00000000-0000-0000-0000-000000000004','analysed',null,'{\"schema_version\":1,\"signal_id\":\"sig-new\",\"analyst_version\":\"v\",\"decision\":\"unclear\",\"targets\":[]}'::jsonb)"
  run "kind:new -> proposed shelf holds the item" "set role service_role; insert into atlas.shelves (slug,name,type,status) values ('adgm','Abu Dhabi Global Market (ADGM)','place','proposed'); insert into atlas.items (item_key,title,main_shelf_id,signal_id,angle,note) select 'sig-new:adgm','ADGM framework',id,'sig-new','new_story','their announcement' from atlas.shelves where slug='adgm';"
  run "legacy decision migrated to 1-element targets" "do \$\$ begin if (select decision||jsonb_array_length(targets)||(targets->0->>'entity') from atlas.decisions where signal_id='sig-legacy') <> 'keep1hyperliquid' then raise exception 'legacy wrong'; end if; end \$\$"
  run "service_role can insert into tool_log" "set role service_role; insert into atlas.tool_log (tool) values ('jev');"
  # leave the proposed shelf out so the rollback can run
  "${PSQL[@]}" -c "delete from atlas.items where signal_id='sig-new'; delete from atlas.shelves where slug='adgm'" >/dev/null 2>&1
}

echo "== before #503 (expected: scenarios FAIL) =="
FAILS=0; scenarios before; echo "before: $FAILS failing (expected > 0)"; BEFORE=$FAILS
"${PSQL[@]}" -c "delete from atlas.item_signals; delete from atlas.items; delete from atlas.decisions where signal_id <> 'sig-legacy'; update atlas.signals set status='received', claim_token=null, claim_expires_at=null, parked_reason=null" >/dev/null
FAILS=0
echo "== up ==";   "${PSQL[@]}" -f "$UP" >/dev/null && ok "up applied" || bad "up"
scenarios up1
echo "== EXPLAIN shelf timeline =="
"${PSQL[@]}" -c "set enable_seqscan=off; explain select id,title,angle,note,created_at from atlas.items where main_shelf_id=(select id from atlas.shelves where slug='hyperliquid') and status='active' order by created_at desc, id desc limit 20"
echo "== down blocked while a signal has several items =="
"${PSQL[@]}" -f "$DOWN" >/dev/null 2>"$TMP/err" && bad "down should refuse" || { grep -q "rollback blocked" "$TMP/err" && ok "down refused: $(grep -o 'rollback blocked[^;]*' "$TMP/err")" || bad "down failed oddly: $(head -1 "$TMP/err")"; }
"${PSQL[@]}" -c "delete from atlas.item_signals" >/dev/null
echo "== down =="
"${PSQL[@]}" -c "select count(*) as items_before_down from atlas.items" -t | xargs echo items before down:
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down applied" || bad "down"
"${PSQL[@]}" -t -c "select count(*) from atlas.items" | xargs echo items after down:
"${PSQL[@]}" -t -c "select count(*) from information_schema.columns where table_schema='atlas' and ((table_name='decisions' and column_name in ('summary','decision','targets')) or (table_name='items' and column_name in ('signal_id','angle','note')))" | grep -q '^ *0$' && ok "down: new columns gone" || bad "down: columns remain"
"${PSQL[@]}" -t -c "select action from atlas.decisions where signal_id='test-standuquesne-2115777839622689036'" | grep -q keep && ok "down: action refilled, decision row intact" || bad "down: action"
"${PSQL[@]}" -t -c "select has_table_privilege('service_role','atlas.tool_log','insert')" | grep -q f && ok "down: tool_log insert revoked" || bad "down: tool_log"
"${PSQL[@]}" -t -c "select prosrc like '%targets%' from pg_proc where proname='signal_finish'" | grep -q f && ok "down: old signal_finish restored" || bad "down: signal_finish"
echo "== up again =="
"${PSQL[@]}" -f "$UP" >/dev/null && ok "up again applied" || bad "up again"
scenarios up2
echo "RESULT: $FAILS failures after migration (before-migration failing scenarios: $BEFORE)"
[[ $FAILS -eq 0 ]]
