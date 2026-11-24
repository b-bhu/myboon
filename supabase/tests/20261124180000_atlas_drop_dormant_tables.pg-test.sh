#!/usr/bin/env bash
# #827 drop atlas.entity_alias_merge_source and public.manual_command_log, on a THROWAWAY
# local Postgres 17. Never points at Supabase. Builds only the minimal prerequisite
# schema (roles, atlas schema, a stub public.entities), creates the two tables by
# running the rollback, then:
#   schema snapshot -> up (tables gone) -> down (schema snapshot must match, rows are
#   not restored) -> down again -> up -> up again.
# Needs server binaries (initdb, pg_ctl, postgres) in PG_BIN; psql, createdb and pg_dump come from PATH.
# Usage: PG_BIN=/path/to/pg17/bin bash supabase/tests/20261124180000_atlas_drop_dormant_tables.pg-test.sh
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
TMP=$(mktemp -d /tmp/issue827drop.XXXX); PORT=$((50000 + RANDOM % 10000)); DB=db827d
V=20261124180000_atlas_drop_dormant_tables
UP=$REPO/supabase/migrations/$V.sql
DOWN=$REPO/supabase/rollbacks/$V.down.sql
trap '"$BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
"$BIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null || { echo "initdb failed ($BIN)"; exit 1; }
"$BIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null || { echo "pg_ctl start failed"; cat "$TMP/log"; exit 1; }
createdb -h "$TMP" -p $PORT -U postgres "$DB" || { echo "createdb failed"; exit 1; }
export PGOPTIONS='-c client_min_messages=warning'
PSQL=(psql -X -q -h "$TMP" -p $PORT -U postgres -d "$DB" -v ON_ERROR_STOP=1)
PASS=0; FAILS=0
ok()  { echo "PASS $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL $1"; FAILS=$((FAILS+1)); }
q()   { "${PSQL[@]}" -t -A -c "$1" 2>/dev/null || echo "QUERY-ERROR"; }
check() { local got; got=$(q "$2"); [[ "$got" == "$3" ]] && ok "$1" || bad "$1 (got '$got', want '$3')"; }

# Schema-only snapshot of the two tables: presence, columns, constraints, indexes, RLS, grants.
dump() {
  pg_dump -h "$TMP" -p $PORT -U postgres -d "$DB" --schema-only --no-owner --no-privileges \
    -t atlas.entity_alias_merge_source -t public.manual_command_log 2>/dev/null | grep -v -E '^\\(un)?restrict ' || true
  "${PSQL[@]}" -t -A -c "
    select n.nspname||'.'||c.relname,
           c.relrowsecurity::text, c.relforcerowsecurity::text,
           coalesce((select string_agg(cons.conname||':'||pg_get_constraintdef(cons.oid, true), ',' order by cons.conname)
                     from pg_constraint cons where cons.conrelid=c.oid), ''),
           coalesce((select string_agg(privilege_type, ',' order by privilege_type)
                     from information_schema.role_table_grants g
                     where g.table_schema=n.nspname and g.table_name=c.relname and g.grantee='atlas_analyst'), ''),
           coalesce((select string_agg(privilege_type, ',' order by privilege_type)
                     from information_schema.role_table_grants g
                     where g.table_schema=n.nspname and g.table_name=c.relname and g.grantee='service_role'), ''),
           coalesce((select count(*)::text from pg_policies p
                     where p.schemaname=n.nspname and p.tablename=c.relname), '0')
    from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where (n.nspname, c.relname) in (('atlas','entity_alias_merge_source'),('public','manual_command_log'))
    order by 1;
  "
  "${PSQL[@]}" -t -A -c "
    select table_schema||'.'||table_name||'.'||grantee||'.'||privilege_type
    from information_schema.role_table_grants
    where (table_schema, table_name) in (('atlas','entity_alias_merge_source'),('public','manual_command_log'))
      and grantee in ('anon','authenticated','public','atlas_analyst','service_role')
    order by 1;
  "
}

EXISTS="select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where (n.nspname, c.relname) in (('atlas','entity_alias_merge_source'),('public','manual_command_log')) and c.relkind='r'"

"${PSQL[@]}" >/dev/null <<'SQL'
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role atlas_analyst nologin;
create schema atlas;
create table public.entities (id uuid primary key);
SQL

echo "== seed tables by running the rollback =="
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down (seed) applied" || bad "down (seed)"
check "seed: both tables exist" "$EXISTS" 2
check "seed: merge_source RLS on, not forced" "select relrowsecurity::text||','||relforcerowsecurity::text from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='atlas' and c.relname='entity_alias_merge_source'" "true,false"
check "seed: manual_command_log RLS on, not forced" "select relrowsecurity::text||','||relforcerowsecurity::text from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='manual_command_log'" "true,false"
check "seed: no policies" "select count(*) from pg_policies where tablename in ('entity_alias_merge_source','manual_command_log')" 0
check "seed: atlas_analyst select on merge_source only" "select count(*)||','||coalesce(string_agg(privilege_type, ',' order by privilege_type),'') from information_schema.role_table_grants where table_schema='atlas' and table_name='entity_alias_merge_source' and grantee='atlas_analyst'" "1,SELECT"
check "seed: service_role has all on manual_command_log (incl. MAINTAIN)" "select has_table_privilege('service_role','public.manual_command_log','select')::text||has_table_privilege('service_role','public.manual_command_log','insert')::text||has_table_privilege('service_role','public.manual_command_log','update')::text||has_table_privilege('service_role','public.manual_command_log','delete')::text||has_table_privilege('service_role','public.manual_command_log','truncate')::text||has_table_privilege('service_role','public.manual_command_log','references')::text||has_table_privilege('service_role','public.manual_command_log','trigger')::text||has_table_privilege('service_role','public.manual_command_log','maintain')::text" "truetruetruetruetruetruetruetrue"
check "seed: anon/auth/public have no select on either table" "select has_table_privilege('anon','atlas.entity_alias_merge_source','select')::text||has_table_privilege('authenticated','atlas.entity_alias_merge_source','select')::text||has_table_privilege('public','atlas.entity_alias_merge_source','select')::text||has_table_privilege('anon','public.manual_command_log','select')::text||has_table_privilege('authenticated','public.manual_command_log','select')::text||has_table_privilege('public','public.manual_command_log','select')::text" "falsefalsefalsefalsefalsefalse"
check "seed: merge_source check and pkey exist" "select string_agg(conname, ',' order by conname) from pg_constraint where conrelid='atlas.entity_alias_merge_source'::regclass" "entity_alias_merge_source_check,entity_alias_merge_source_pkey"
check "seed: manual_command_log pkey and entities FK (ON DELETE SET NULL)" "select conname||':'||pg_get_constraintdef(oid, true) from pg_constraint where conrelid='public.manual_command_log'::regclass and contype='f'" "manual_command_log_entity_id_fkey:FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE SET NULL"
check "seed: applied_at default is now()" "select pg_get_expr(adbin, adrelid) from pg_attrdef where adrelid='public.manual_command_log'::regclass and adnum=(select attnum from pg_attribute where attrelid='public.manual_command_log'::regclass and attname='applied_at')" "now()"

# Fixture rows prove the rollback restores schema only, not data.
E1=00000000-0000-7000-8000-0000000000e1
"${PSQL[@]}" >/dev/null <<SQL
insert into public.entities (id) values ('$E1');
insert into atlas.entity_alias_merge_source (loser_id, loser_slug, alias, winner_id, batch)
  values ('$E1', 'loser', 'Loser Name', '$E1', 'test-batch');
insert into public.manual_command_log (request_id, command_hash, actor, entity_id)
  values ('req-1', 'hash-1', '{"kind":"test"}', '$E1');
SQL
check "seed: fixture rows present" "select (select count(*) from atlas.entity_alias_merge_source)||','||(select count(*) from public.manual_command_log)" "1,1"

echo "== schema before up =="
dump > "$TMP/before.sql"
echo "snapshot: $(wc -l < "$TMP/before.sql") lines"

echo "== up / down / down / up / up =="
"${PSQL[@]}" -f "$UP" >/dev/null && ok "up applied" || bad "up"
check "up: both tables gone" "$EXISTS" 0
check "up: stub entities row kept" "select count(*) from public.entities" 1
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down applied" || bad "down"
check "down: both tables back" "$EXISTS" 2
check "down: fixture rows were not restored (schema-only rollback)" "select (select count(*) from atlas.entity_alias_merge_source)||','||(select count(*) from public.manual_command_log)" "0,0"
dump > "$TMP/after_down.sql"
if diff -u "$TMP/before.sql" "$TMP/after_down.sql" > "$TMP/diff.txt"; then ok "schema diff before up vs after down: identical ($(wc -l < "$TMP/before.sql") lines compared)"; else bad "schema differs after down"; head -40 "$TMP/diff.txt"; fi
"${PSQL[@]}" -f "$DOWN" >/dev/null && ok "down rerun (idempotent)" || bad "down rerun"
dump > "$TMP/after_down2.sql"
diff -q "$TMP/after_down.sql" "$TMP/after_down2.sql" >/dev/null && ok "down rerun changes nothing" || bad "down rerun changed schema"
"${PSQL[@]}" -f "$UP" >/dev/null && ok "up again applied" || bad "up again"
check "up again: both tables gone" "$EXISTS" 0
"${PSQL[@]}" -f "$UP" >/dev/null && ok "up rerun (idempotent)" || bad "up rerun"
check "up rerun: still gone" "$EXISTS" 0
check "entities stub still present after drops" "select count(*) from public.entities" 1

echo "RESULT: $PASS passed, $FAILS failures"
[[ $FAILS -eq 0 ]]
