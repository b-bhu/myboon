#!/usr/bin/env bash
# #566 entity aliases, on a THROWAWAY local Postgres 17. Never points at Supabase.
# Applies every atlas migration before 20261103210000, seeds entities, then:
#   up -> backfill x2 -> acceptance -> backfill down -> down -> up -> up (rerun) -> backfill.
# Seed: a small inline fixture, or a realistic copy when SEED_JSON=<file> is set
# (JSON array of {id,slug,name,type,aliases,status}, e.g. a read-only export of atlas.entities).
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
TMP=$(mktemp -d /tmp/issue566.XXXX); PORT=$((50000 + RANDOM % 10000)); DB=db566
V=20261103210000_atlas_entity_aliases
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
backfill() { (cd "$BF" && "${PSQL[@]}" -t -A -f 566_entity_aliases.sql 2>&1 | tail -1); }

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

if [[ -n "${SEED_JSON:-}" ]]; then
  python3 - "$SEED_JSON" <<'PY' | "${PSQL[@]}" >/dev/null || { echo "seed failed"; exit 1; }
import json, sys
q = lambda v: "'" + v.replace("'", "''") + "'"
for r in json.load(open(sys.argv[1])):
    al = "array[" + ",".join(q(x) for x in r["aliases"]) + "]::text[]"
    print(f"insert into atlas.entities (id, slug, name, type, aliases, status) values "
          f"({q(r['id'])}, {q(r['slug'])}, {q(r['name'])}, {q(r['type'])}, {al}, {q(r['status'])});")
PY
else
  "${PSQL[@]}" >/dev/null <<'SQL'
insert into atlas.entities (id, slug, name, type, aliases, status) values
  ('01a17278-0000-7000-8000-000000000001','bitcoin','Bitcoin','asset','{Bitcoin,BTC,XBT,$BTC}','active'),
  ('01a17278-a6bb-7202-b51c-14db8ec1e602','solana','Solana','asset','{SOL}','active'),
  ('01a17278-0000-7000-8000-000000000003','binance','Binance','organization','{}','active'),
  ('01a17278-0000-7000-8000-000000000004','bnb','BNB','asset','{binance}','active'),
  ('01a17278-0000-7000-8000-000000000005','old-thing','Old Thing','asset','{}','retired'),
  ('01a17278-0000-7000-8000-000000000006','btc-dupe','Btc Dupe','asset','{btc}','active'),
  ('01a17278-0000-7000-8000-000000000007','ai-industry','AI Industry','topic','{}','active');
SQL
fi
ENT0=$(q "select md5(string_agg(id::text||type||array_to_string(aliases,','),'|' order by id)) from atlas.entities")
SCHEMA="select md5(string_agg(c.relname||':'||c.relkind,',' order by c.relname)) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='atlas'"
CONS="select md5(string_agg(conname,',' order by conname)) from pg_constraint where conrelid='atlas.entities'::regclass"
s0=$(q "$SCHEMA"); c0=$(q "$CONS")

"${PSQL[@]}" -f "$UP" >/dev/null && ok "up applied" || bad "up applied"
r1=$(backfill); echo "backfill run 1: alias_rows|merged_loser_rows|open_conflicts|merged_without_active_winner = $r1"
r2=$(backfill); echo "backfill run 2: $r2"
[[ -n "$r1" && "$r1" == "$r2" ]] && ok "backfill twice: same counts" || bad "backfill twice ($r1 vs $r2)"
check "entities untouched by up+backfill" "select md5(string_agg(id::text||type||array_to_string(aliases,','),'|' order by id)) from atlas.entities" "$ENT0"
check "norm_alias collapses case/punct/space" "select atlas.norm_alias('  \$BTC-  Hack!! ')" "btc hack"
check "no alias rows for non-active entities" "select count(*) from atlas.entity_aliases a join atlas.entities e on e.id=a.entity_id where e.status<>'active' and not exists (select 1 from atlas.entity_alias_merge_source m where m.alias=a.alias)" "0"
check "every conflict names a different holder" "select count(*) from atlas.entity_alias_conflicts where wanted_entity_id=holder_entity_id" "0"
check "merged loser 'solana-mobile' resolves to solana (winner type asset)" "select string_agg(slug,',') from atlas.entity_candidates('asset', array['solana mobile'])" "solana"
check "retired-only name (hard-deleted 'tim-cook') returns nothing" "select count(*) from atlas.entity_candidates('person', array['tim-cook'])" "0"
if [[ -n "${SEED_JSON:-}" ]]; then
  check "merged loser 'binance-heist' resolves to binance" "select string_agg(slug,',') from atlas.entity_candidates('organization', array['Binance Heist'])" "binance"
  check "merged loser 'he-yi' resolves to binance" "select string_agg(slug,',') from atlas.entity_candidates('organization', array['he yi'])" "binance"
  echo "seed: $(q "select count(*) filter (where status='active')||' active, '||count(*) filter (where status='retired')||' retired, '||(select count(*) from atlas.entities e, unnest(e.aliases) a where e.status='active')||' active array aliases' from atlas.entities")"
  echo "conflicts by source: $(q "select coalesce(string_agg(source||'='||n,', '),'none') from (select source,count(*) n from atlas.entity_alias_conflicts group by 1) s")"
  echo "conflict detail: $(q "select string_agg(c.type||' '||quote_literal(c.alias)||' wanted '||w.slug||' held by '||h.slug,'; ') from atlas.entity_alias_conflicts c join atlas.entities w on w.id=c.wanted_entity_id join atlas.entities h on h.id=c.holder_entity_id")"
  echo "merged-loser rows owned by winner, new (not an active name/alias): $(q "select count(*) from atlas.entity_aliases a join atlas.entity_alias_merge_source m on m.alias=a.alias")"
  check "bitcoin acceptance on prod copy" "select string_agg(distinct slug,',') from atlas.entity_candidates('asset', array['btc','Bitcoin '])" "bitcoin"
  check "typed miss: He Yi as person -> nothing" "select count(*) from atlas.entity_candidates('person', array['He Yi'])" "0"
  check "fallback: He Yi (person guess) resolves to binance" "select string_agg(slug||'/'||type,',') from atlas.entity_candidates_any(array['He Yi'])" "binance/organization"
  check "typed miss: Animoca Brands as organization -> nothing" "select count(*) from atlas.entity_candidates('organization', array['Animoca Brands'])" "0"
  check "fallback: Animoca Brands (organization guess) resolves to tokenization-rwa" "select string_agg(slug||'/'||type,',') from atlas.entity_candidates_any(array['Animoca Brands'])" "tokenization-rwa/topic"
  check "fallback: Trezor, BTCPay Server, Solana Mobile, Prediction Markets resolve" "select string_agg(slug,',' order by matched_alias) from atlas.entity_candidates_any(array['BTCPay Server','Prediction Markets','Solana Mobile','Trezor'])" "bitcoin,polymarket,solana,bitcoin"
  check "fallback: retired-only name returns nothing" "select count(*) from atlas.entity_candidates_any(array['tim-cook'])" "0"
  check "USD₮ conflict resolved as no-op" "select count(*) from atlas.entity_alias_conflicts where resolved_at is null" "0"
  check "every merged loser has an active winner" "select count(*) from atlas.entity_alias_merge_source m where not exists (select 1 from atlas.entities w where w.status='active' and w.id=coalesce(m.winner_id,(select id from atlas.entities where slug=m.winner_slug)))" "0"
else
  check "bitcoin candidates: btc + 'Bitcoin ' -> only bitcoin" "select string_agg(distinct slug,',') from atlas.entity_candidates('asset', array['btc','Bitcoin '])" "bitcoin"
  check "btc clash recorded for btc-dupe" "select count(*) from atlas.entity_alias_conflicts c join atlas.entities e on e.id=c.wanted_entity_id where e.slug='btc-dupe' and c.norm_alias='btc'" "1"
  check "same alias, other type is allowed (binance org vs bnb asset)" "select count(*) from atlas.entity_aliases where norm_alias='binance'" "2"
  check "fallback finds across types (SOL from organization guess)" "select string_agg(slug,',') from atlas.entity_candidates_any(array['sol'])" "solana"
  check "fallback skips retired" "select count(*) from atlas.entity_candidates_any(array['Old Thing'])" "0"
  check "anon/public cannot execute lookups" "select has_function_privilege('anon','atlas.entity_candidates(text,text[])','execute')::text||has_function_privilege('anon','atlas.entity_candidates_any(text[])','execute')::text" "falsefalse"
  check "retired entity's alias not returned" "select count(*) from atlas.entity_candidates('asset', array['Old Thing'])" "0"
  q "insert into atlas.entity_aliases (entity_id,type,alias) values ('01a17278-0000-7000-8000-000000000006','asset',' Btc ')" | grep -q QUERY-ERROR && ok "same normalized alias for a 2nd entity fails on unique" || bad "unique (type,norm_alias)"
  q "insert into atlas.entity_aliases (entity_id,type,alias) values ('01a17278-0000-7000-8000-000000000006','topic','x')" | grep -q QUERY-ERROR && ok "alias type must match entity type (composite FK)" || bad "composite FK"
  "${PSQL[@]}" -c "update atlas.entities set type='topic' where slug='btc-dupe'" >/dev/null
  check "type change cascades to aliases" "select string_agg(distinct a.type,',') from atlas.entity_aliases a join atlas.entities e on e.id=a.entity_id where e.slug='btc-dupe'" "topic"
  "${PSQL[@]}" -c "update atlas.entities set type='asset' where slug='btc-dupe'" >/dev/null
  check "merge rule: move_entity_aliases moves dupe's aliases to bitcoin" "select atlas.move_entity_aliases('01a17278-0000-7000-8000-000000000006','01a17278-0000-7000-8000-000000000001')" "1"
  check "  ...loser has no aliases left" "select count(*) from atlas.entity_aliases where entity_id='01a17278-0000-7000-8000-000000000006'" "0"
  check "  ...old name now resolves to winner" "select string_agg(slug,',') from atlas.entity_candidates('asset', array['btc dupe'])" "bitcoin"
fi
PLAN=$("${PSQL[@]}" -t -A -c "set enable_seqscan=off; explain select entity_id from atlas.entity_aliases where type='asset' and norm_alias = any(array[atlas.norm_alias('btc'), atlas.norm_alias('Bitcoin ')])")
echo "$PLAN"; grep -q entity_aliases_type_norm_key <<<"$PLAN" && ok "candidate query uses (type,norm_alias) index" || bad "plan"
DEL=$(q "select entity_id from atlas.entity_aliases order by created_at limit 1")
"${PSQL[@]}" -c "delete from atlas.entities where id='$DEL'" >/dev/null
check "entity deletion cascades to its aliases" "select count(*) from atlas.entity_aliases where entity_id='$DEL'" "0"

(cd "$BF" && "${PSQL[@]}" -f 566_entity_aliases.down.sql >/dev/null 2>&1) && bad "backfill down ran without opt-in" || ok "backfill down refuses without opt-in"
(cd "$BF" && PGOPTIONS="-c myboon.allow_alias_wipe=pre-cutover" "${PSQL[@]}" -f 566_entity_aliases.down.sql >/dev/null) && check "backfill down empties alias table" "select count(*) from atlas.entity_aliases" "0" || bad "backfill down"
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down applied" || bad "down applied"
check "down: atlas relations identical to pre-migration" "$SCHEMA" "$s0"
check "down: entities constraints identical" "$CONS" "$c0"
check "down: norm_alias gone" "select to_regprocedure('atlas.norm_alias(text)') is null" "t"
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down rerun: no-op" || bad "down rerun"
"${PSQL[@]}" -f "$UP" >/dev/null && ok "up again" || bad "up again"
"${PSQL[@]}" -f "$UP" >/dev/null && ok "up rerun: no-op" || bad "up rerun"
r3=$(backfill); echo "backfill after up/down/up: $r3"; [[ -n "$r3" ]] && ok "backfill after re-up" || bad "backfill after re-up"
echo "passed=$PASS failed=$FAILS"
[[ $FAILS -eq 0 ]] && echo PASS || { echo FAIL; exit 1; }
