#!/usr/bin/env bash
# #397 local proof: up -> down -> up -> rerun for 20261101090000 on a throwaway Postgres.
# Applies the real atlas schema with packages/atlas-schema (LOCAL_SKIP stand-ins), then stubs
# the 5 public functions with prod's Nov 1 ACLs and postgres/public default privileges.
set -euo pipefail
V=20261101090000_revoke_anon_auth_function_execute_and_defaults
BIN=$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)
DIR=$(mktemp -d); PORT=${PORT:-55398}
trap '"$BIN/pg_ctl" -D "$DIR" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DIR"' EXIT
"$BIN/initdb" -D "$DIR" -U postgres >/dev/null
"$BIN/pg_ctl" -D "$DIR" -o "-p $PORT -k $DIR -c listen_addresses=localhost" -w start >/dev/null
URL="postgres://postgres@localhost:$PORT/postgres"
node_modules/.bin/tsx packages/atlas-schema/scripts/prepare-db.ts "$URL" t397
P() { psql -X -q -v ON_ERROR_STOP=1 -h localhost -p "$PORT" -U postgres -d t397 "$@"; }
P <<'SQL'
create function public.entity_manager_create_entity_v1(p_slug text, p_name text, p_type text, p_aliases jsonb, p_summary text, p_status text, p_show_in_carousel boolean, p_metadata jsonb, p_identity_slugs text[], p_identity_names text[], p_identity_aliases text[]) returns int language sql as 'select 1';
create function public.entity_manager_verify_migration_v1() returns int language sql as 'select 1';
create function public.entity_memory_compat_identity_v1() returns trigger language plpgsql as 'begin return new; end';
create function public.token_source_rank(src text) returns int language sql immutable as 'select 1';
create function public.touch_ai_explanations_updated_at() returns trigger language plpgsql as 'begin new.v := now(); return new; end';
revoke execute on function public.entity_manager_create_entity_v1(text,text,text,jsonb,text,text,boolean,jsonb,text[],text[],text[]), public.entity_manager_verify_migration_v1(), public.entity_memory_compat_identity_v1() from public;
grant execute on all functions in schema public to anon, authenticated, service_role;
create table public.ai_explanations (id int, v timestamptz);
create trigger t before update on public.ai_explanations for each row execute function public.touch_ai_explanations_updated_at();
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
SQL
snap() { P -At -c "select string_agg(x, E'\n' order by x) from (select p.oid::regprocedure::text||' '||coalesce(array(select unnest(p.proacl)::text order by 1)::text,'') x from pg_proc p where pronamespace in ('public'::regnamespace,'atlas'::regnamespace) union all select 'defacl '||defaclobjtype::text||' '||array(select unnest(defaclacl)::text order by 1)::text from pg_default_acl union all select 'rel '||c.oid::regclass::text||' '||coalesce(array(select unnest(c.relacl)::text order by 1)::text,'') from pg_class c where relnamespace in ('public'::regnamespace,'atlas'::regnamespace) and relkind in ('r','p','v','m','S')) s"; }
anon_fns() { P -At -c "select count(*) from pg_proc p where pronamespace='public'::regnamespace and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))"; }
anon_defs() { P -At -c "select count(*) from pg_default_acl where defaclacl::text ~ '(^|[{,])(anon|authenticated)='"; }
up() { P -f supabase/migrations/$V.sql; }
down() { P -f supabase/rollbacks/$V.down.sql; }
before=$(snap); echo "before: anon/auth executable public fns=$(anon_fns), default-acl entries naming anon/auth=$(anon_defs)"
up; up1=$(snap); echo "up1: anon/auth executable public fns=$(anon_fns), default-acl entries naming anon/auth=$(anon_defs)"
P -At -c "select has_function_privilege('service_role','public.token_source_rank(text)','execute') and has_function_privilege('service_role','public.entity_manager_verify_migration_v1()','execute')" | grep -qx t && echo "up1: service_role keeps EXECUTE"
P -c "insert into public.ai_explanations values (1, null); update public.ai_explanations set id=2" && echo "up1: trigger still fires after PUBLIC revoke"
P -c "create table public.new_after_up (id serial)"; P -At -c "select count(*) from information_schema.role_table_grants where table_name='new_after_up' and grantee in ('anon','authenticated')" | grep -qx 0 && echo "up1: new public table gets no anon/auth grants"; P -c "drop table public.new_after_up"
P -At -c "select count(*) from atlas.entities" >/dev/null && echo "up1: atlas schema (post-#542 entities) intact"
down; diff <(echo "$before") <(snap) && echo "down: ACLs identical to pre-migration snapshot (order-insensitive)"
echo "down: anon/auth executable public fns=$(anon_fns), default-acl entries naming anon/auth=$(anon_defs)"
up; [ "$(snap)" = "$up1" ] && echo "up2: identical to up1"
up; [ "$(snap)" = "$up1" ] && echo "rerun: idempotent"
echo PASS
