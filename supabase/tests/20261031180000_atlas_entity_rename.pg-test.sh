#!/usr/bin/env bash
# #541 entity table rename + item_shelves drop, on a THROWAWAY local Postgres 17. Never points at Supabase.
# Applies every atlas migration before 20261031180000, seeds rows,
# fingerprints names + privileges, then up / up / down / down / up and checks names, privileges,
# row counts, the item_shelves backup/restore, and that the rollback restores the exact pre-migration fingerprint.
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
TMP=$(mktemp -d /tmp/issue541.XXXX); PORT=$((50000 + RANDOM % 10000)); DB=db541
UP=$REPO/supabase/migrations/20261031180000_atlas_entity_rename.sql
DOWN=$REPO/supabase/rollbacks/20261031180000_atlas_entity_rename.down.sql
trap '"$BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
"$BIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
"$BIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null
"$BIN/createdb" -h "$TMP" -p $PORT -U postgres "$DB"
PSQL=(psql -X -q -h "$TMP" -p $PORT -U postgres -d "$DB" -v ON_ERROR_STOP=1)
PASS=0; FAILS=0
ok()  { echo "PASS $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL $1"; FAILS=$((FAILS+1)); }
q()   { "${PSQL[@]}" -t -A -c "$1" || echo "QUERY-ERROR"; }

"${PSQL[@]}" -c "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;" >/dev/null
for f in $(ls "$REPO"/supabase/migrations/*_atlas*.sql | sort); do
  b=$(basename "$f")
  [[ $b < 20261031180000 ]] || continue
  if [[ $b == 20261025100200_atlas_tool_log.sql ]]; then
    "${PSQL[@]}" -c "create table atlas.tool_log (id bigint generated always as identity, logged_at timestamptz not null default now(), run_id text, tool text not null, input jsonb, output jsonb, duration_ms bigint, error text, primary key (logged_at, id)); alter table atlas.tool_log enable row level security;" >/dev/null || { echo "tool_log stand-in failed"; exit 1; }
    continue
  fi
  "${PSQL[@]}" -f "$f" >/dev/null || { echo "apply $b failed"; exit 1; }
done

"${PSQL[@]}" >/dev/null <<'SQL'
insert into atlas.shelves (slug, name, type) values ('kalshi', 'Kalshi', 'organization'), ('sec', 'SEC', 'organization');
insert into atlas.signals (signal_id, schema_version, source, source_id, type, text, link, occurred_at)
  values ('s-1', 1, 'x', '1', 'news', 't', null, now());
insert into atlas.items (item_key, title, summary, angle, signal_id, main_shelf_id)
  select 'k-1', 'T', 'S', 'plain_update', 's-1', id from atlas.shelves where slug = 'kalshi';
insert into atlas.item_shelves (item_id, shelf_id, role)
  select i.id, s.id, 'also_affects' from atlas.items i, atlas.shelves s where s.slug = 'sec';
SQL

# Name-sensitive fingerprint of every object on the touched tables (must match after down).
TABS="'shelves','items','item_shelves','stories','entities','entity_items','decisions'"
FP="select md5(string_agg(x, E'\n' order by x)) from (
  select 'col '||table_name||'.'||column_name||' '||udt_name||' '||is_nullable||' '||coalesce(column_default,'') x
    from information_schema.columns where table_schema='atlas' and table_name in ($TABS)
  union all select 'idx '||indexdef from pg_indexes where schemaname='atlas' and tablename in ($TABS)
  union all select 'con '||conrelid::regclass::text||' '||conname||' '||pg_get_constraintdef(oid) from pg_constraint where connamespace='atlas'::regnamespace
  union all select 'pol '||tablename||' '||policyname||' '||cmd||' '||array_to_string(roles,',')||' '||coalesce(qual,'')||' '||coalesce(with_check,'') from pg_policies where schemaname='atlas'
  union all select 'acl '||relname||' '||coalesce(relacl::text,'')||' '||relrowsecurity::text from pg_class where relnamespace='atlas'::regnamespace and relname <> 'item_shelves_bak_541'
  union all select 'colacl '||attrelid::regclass::text||'.'||attname||' '||attacl::text from pg_attribute where attacl is not null and attrelid in (select oid from pg_class where relnamespace='atlas'::regnamespace)
  union all select 'trg '||pg_get_triggerdef(oid) from pg_trigger where not tgisinternal
  union all select 'fn '||pg_get_functiondef(oid)||' '||coalesce(proacl::text,'')||' '||proowner::regrole::text from pg_proc where pronamespace='atlas'::regnamespace
) s"
# Name-blind privilege fingerprint keyed by OID + attnum (must match after up: grants follow the OID).
PRIV="select md5(string_agg(x, E'\n' order by x)) from (
  select 'acl '||oid||' '||coalesce(relacl::text,'')||relrowsecurity::text x from pg_class where relnamespace='atlas'::regnamespace and relkind='r' and relname not in ('item_shelves','item_shelves_bak_541')
  union all select 'colacl '||attrelid||'.'||attnum||' '||attacl::text from pg_attribute where attacl is not null and attrelid in (select oid from pg_class where relnamespace='atlas'::regnamespace)
  union all select 'pol '||polrelid||' '||polname||' '||polcmd::text||' '||polroles::text from pg_policy where polrelid <> coalesce(to_regclass('atlas.item_shelves'),0)
) s"
COUNTS="select (select count(*) from atlas.%s)||'/'||(select count(*) from atlas.%s)"
OLDCNT=$(q "$(printf "$COUNTS" shelves items)")
LINKS=$(q "select count(*) from atlas.item_shelves")
BEFORE=$(q "$FP"); PBEFORE=$(q "$PRIV")
SFACL=$(q "select proacl::text from pg_proc where oid='atlas.signal_finish(text,uuid,text,text,jsonb)'::regprocedure")
[[ $OLDCNT/$LINKS == 2/1/1 ]] && ok "seeded 2/1/1 rows" || bad "seed counts $OLDCNT/$LINKS"

NEWNAMES="select count(*) from pg_class where relnamespace='atlas'::regnamespace and relname in ('entities','entity_items')"
OLDLEFT="select (select count(*) from pg_class where relnamespace='atlas'::regnamespace and (relname like 'shelves%' or relname like 'items%' or (relname like 'item_shelves%' and relname <> 'item_shelves_bak_541') or relname like '%shelf%'))
  + (select count(*) from pg_constraint where connamespace='atlas'::regnamespace and (conname like 'shelves%' or conname like 'items%' or conname like 'item_shelves%' or conname like '%shelf%'))
  + (select count(*) from pg_trigger where tgname like 'shelves%' or tgname like 'items%' or tgname like 'item_shelves%')
  + (select count(*) from information_schema.columns where table_schema='atlas' and table_name <> 'item_shelves_bak_541' and column_name like '%shelf%')"

echo "== up / up / down / down / up =="
"${PSQL[@]}" -f "$UP"   >/dev/null && ok "up applied" || bad "up"
[[ $(q "$NEWNAMES") == 2 ]] && ok "up: entities, entity_items exist" || bad "new names"
[[ $(q "$OLDLEFT") == 0 ]] && ok "up: no relation/constraint/trigger/column keeps an old name" || bad "old names left: $(q "$OLDLEFT")"
[[ $(q "select to_regclass('atlas.item_shelves') is null") == t ]] && ok "up: item_shelves dropped" || bad "item_shelves still there"
[[ $(q "select count(*) from atlas.item_shelves_bak_541") == "$LINKS" ]] && ok "up: item_shelves backed up ($LINKS rows)" || bad "backup rows"
[[ $(q "select has_table_privilege('atlas_analyst','atlas.item_shelves_bak_541','select')::text||has_table_privilege('service_role','atlas.item_shelves_bak_541','select')::text") == falsefalse ]] && ok "up: backup has no grants" || bad "backup grants"
"${PSQL[@]}" -f "$UP"   >/dev/null && ok "up rerun (idempotent)" || bad "up rerun"
[[ $(q "$PRIV") == "$PBEFORE" ]] && ok "up: grants, column grants, policies identical by OID" || bad "privileges changed"
[[ $(q "$(printf "$COUNTS" entities entity_items)") == "$OLDCNT" ]] && ok "up: row counts unchanged" || bad "row counts"
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down applied" || bad "down"
[[ $(q "$FP") == "$BEFORE" ]] && ok "down: fingerprint matches pre-migration" || bad "down fingerprint differs"
[[ $(q "select count(*) from atlas.item_shelves") == "$LINKS" ]] && ok "down: item_shelves rows restored" || bad "links rows"
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down rerun (idempotent)" || bad "down rerun"
[[ $(q "$FP") == "$BEFORE" ]] && ok "down rerun: fingerprint still matches" || bad "down rerun fingerprint differs"
[[ $(q "$(printf "$COUNTS" shelves items)")/$(q "select count(*) from atlas.item_shelves") == "$OLDCNT/$LINKS" ]] && ok "down: row counts unchanged (incl. item_shelves)" || bad "down counts"
"${PSQL[@]}" -f "$UP"   >/dev/null && ok "up again applied" || bad "up again"

SHELF="select string_agg(x, '; ') from (
  select 'rel '||relname x from pg_class where relnamespace='atlas'::regnamespace and relname ~* 'shel[fv]' and relname <> 'item_shelves_bak_541'
  union all select 'col '||c.relname||'.'||attname from pg_attribute a join pg_class c on c.oid=a.attrelid where c.relnamespace='atlas'::regnamespace and c.relname <> 'item_shelves_bak_541' and c.relkind <> 'i' and a.attnum>0 and not attisdropped and attname ~* 'shel[fv]'
  union all select 'con '||conname from pg_constraint where connamespace='atlas'::regnamespace and (conname ~* 'shel[fv]' or pg_get_constraintdef(oid) ~* 'shel[fv]')
  union all select 'trg '||tgname from pg_trigger where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace='atlas'::regnamespace) and pg_get_triggerdef(oid) ~* 'shel[fv]'
  union all select 'pol '||policyname from pg_policies where schemaname='atlas' and (policyname||coalesce(qual,'')||coalesce(with_check,'')) ~* 'shel[fv]'
  union all select 'fn '||proname from pg_proc where pronamespace='atlas'::regnamespace and (proname ~* 'shel[fv]' or prosrc ~* 'shel[fv]')
  union all select 'cmt '||objoid from pg_description where description ~* 'shel[fv]' and (classoid <> 'pg_class'::regclass or objoid in (select oid from pg_class where relnamespace='atlas'::regnamespace))
  union all select 'view '||viewname from pg_views where schemaname='atlas' and definition ~* 'shel[fv]'
) s"
[[ -z $(q "$SHELF") ]] && ok "up: zero 'shelf'/'shelves' in atlas names, defs, function bodies, policies, comments" || bad "shelf left: $(q "$SHELF")"
[[ $(q "select proacl::text from pg_proc where oid='atlas.signal_finish(text,uuid,text,text,jsonb)'::regprocedure") == "$SFACL" ]] && ok "signal_finish: same signature and EXECUTE grants" || bad "signal_finish grants"
"${PSQL[@]}" >/dev/null <<'SQL'
insert into atlas.signals (signal_id, schema_version, source, source_id, type, text, link, occurred_at, status, claim_token, claim_expires_at)
  values ('s-2', 1, 'x', '2', 'news', 't', null, now(), 'received', '00000000-0000-4000-8000-000000000002', now() + interval '5 minutes');
SQL
out=$("${PSQL[@]}" -t -A -c "set role analyst_worker; select atlas.signal_finish('s-2', '00000000-0000-4000-8000-000000000002', 'analysed', null, jsonb_build_object('schema_version',1,'signal_id','s-2','analyst_version','v541','summary','s','decision','keep','reason','r','decided_by','jev','decision_type','file','entities','[\"kalshi\"]'::jsonb,'targets','[]'::jsonb))" 2>&1)
[[ $out == t ]] && ok "signal_finish as analyst_worker accepts payload key 'entities'" || bad "signal_finish: $out"
[[ $(q "select entities::text from atlas.decisions where signal_id='s-2'") == '["kalshi"]' ]] && ok "payload 'entities' lands in decisions.entities" || bad "decisions.entities: $(q "select entities::text from atlas.decisions where signal_id='s-2'")"

echo "== behaviour after up =="
AS="set role entity_worker;"
out=$("${PSQL[@]}" -t -A -c "begin; $AS update atlas.entities set entity_reviewed_at=now() where slug='kalshi' returning 1; rollback;" 2>&1)
[[ $out == 1 ]] && ok "entity_worker stamps entities.entity_reviewed_at" || bad "entity_worker update: $out"
out=$("${PSQL[@]}" -t -A -c "begin; set role entity_worker; update atlas.entities set name='x' where slug='kalshi'; rollback;" 2>&1)
[[ $out == *"permission denied"* ]] && ok "entity_worker still refused on entities.name" || bad "name update: $out"
out=$("${PSQL[@]}" -t -A -c "begin; set role analyst_worker; select count(*) from atlas.entity_items i join atlas.entities e on e.id=i.main_entity_id; rollback;" 2>&1)
[[ $out == 1 ]] && ok "analyst_worker reads entity_items.main_entity_id join" || bad "analyst read: $out"
"${PSQL[@]}" -c "update atlas.entity_items set title='T2' where item_key='k-1';" >/dev/null
h=$(q "select table_name||' '||(changed ? 'title')::text from atlas.history where op='UPDATE' order by id desc limit 1")
[[ $h == "entity_items true" ]] && ok "entity_items history trigger logs under the new name" || bad "history: $h"

echo "== $PASS passed, $FAILS failures =="
[[ $FAILS == 0 ]]
