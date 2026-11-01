#!/usr/bin/env bash
# #397 local proof: up -> down -> up for 20260824122705 and 20261025140056 on a
# throwaway Postgres. The 9 tables are stubs carrying prod's Oct 25 grants.
set -euo pipefail
BIN=$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)
DIR=$(mktemp -d); PORT=${PORT:-55397}
trap '"$BIN/pg_ctl" -D "$DIR" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DIR"' EXIT
"$BIN/initdb" -D "$DIR" -U postgres >/dev/null
"$BIN/pg_ctl" -D "$DIR" -o "-p $PORT -k $DIR -c listen_addresses=''" -w start >/dev/null
P() { psql -X -q -v ON_ERROR_STOP=1 -h "$DIR" -p "$PORT" -U postgres -d postgres "$@"; }
M=supabase/migrations; R=supabase/rollbacks
P <<'SQL'
create role anon nologin; create role authenticated nologin;
create role service_role nologin bypassrls; create role myboon_knowledge_owner nologin;
do $$ declare t text; begin
  foreach t in array array['ai_explanations','entities','entity_memories','entity_published_history',
    'manual_command_log','pipeline_runs','polymarket_profile_cache','published_narratives','token_registry'] loop
    execute format('create table public.%I (id int primary key)', t);
    execute format('grant all on public.%I to service_role', t);
    if t = 'entity_memories' then
      execute format('grant select, references, trigger on public.%I to anon, authenticated', t);
    else
      execute format('grant all on public.%I to anon, authenticated', t);
    end if;
  end loop; end $$;
grant select on public.entities to myboon_knowledge_owner;
SQL
snap() { P -At -c "select coalesce(string_agg(table_name||':'||grantee||':'||privilege_type, ',' order by 1),'') from (select table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema='public' and grantee <> 'postgres' order by 1,2,3) g"; }
upd() { P -At -c "select to_regclass('public.polymarket_updown_reference_prices') is not null"; }
up() { P -1 -f $M/20260824122705_polymarket_updown_reference_prices.sql; P -1 -f $M/20261025140056_revoke_anon_auth_table_grants.sql; }
down() { P -f $R/20261025140056_revoke_anon_auth_table_grants.down.sql; P -f $R/20260824122705_polymarket_updown_reference_prices.down.sql; }
before=$(snap)
up; up1=$(snap)
P -At -c "select count(*) from information_schema.role_table_grants where table_schema='public' and grantee in ('anon','authenticated')" | grep -qx 0 && echo "up1: anon/authenticated grants = 0"
[ "$(upd)" = t ] && echo "up1: updown table present"
echo "$up1" | grep -q 'polymarket_updown_reference_prices:service_role:SELECT' && echo "up1: service_role keeps updown grants"
echo "$up1" | grep -q 'entities:myboon_knowledge_owner:SELECT' && echo "up1: myboon_knowledge_owner grant unchanged"
down; [ "$(snap)" = "$before" ] && echo "down: grants identical to pre-migration snapshot"; [ "$(upd)" = f ] && echo "down: updown table dropped"
up; [ "$(snap)" = "$up1" ] && echo "up2: identical to up1"
up; [ "$(snap)" = "$up1" ] && echo "rerun: idempotent"
echo PASS
