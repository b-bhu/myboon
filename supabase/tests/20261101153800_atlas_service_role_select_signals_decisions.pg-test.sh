#!/usr/bin/env bash
# #552 local proof: up -> down -> up -> rerun for 20261101153800 on a throwaway Postgres.
# Applies the real atlas schema, then sets service_role's prod Nov 1 grants (INSERT only on signals/decisions).
set -euo pipefail
V=20261101153800_atlas_service_role_select_signals_decisions
BIN=$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)
DIR=$(mktemp -d); PORT=${PORT:-55552}
trap '"$BIN/pg_ctl" -D "$DIR" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DIR"' EXIT
"$BIN/initdb" -D "$DIR" -U postgres >/dev/null
"$BIN/pg_ctl" -D "$DIR" -o "-p $PORT -k $DIR -c listen_addresses=localhost" -w start >/dev/null
URL="postgres://postgres@localhost:$PORT/postgres"
node_modules/.bin/tsx packages/atlas-schema/scripts/prepare-db.ts "$URL" t552
P() { psql -X -q -v ON_ERROR_STOP=1 -h localhost -p "$PORT" -U postgres -d t552 "$@"; }
P -c "revoke all on atlas.signals, atlas.decisions from service_role; grant insert on atlas.signals, atlas.decisions to service_role; grant usage on schema atlas to service_role;"
priv() { P -At -c "select string_agg(t||':'||has_table_privilege('service_role','atlas.'||t,'SELECT')::text||'/'||has_table_privilege('service_role','atlas.'||t,'INSERT')::text, ' ' order by t) from unnest(array['decisions','signals']) t"; }
reads() { P -At -c "set role service_role; select count(*) from atlas.signals; select count(*) from atlas.decisions" >/dev/null 2>&1 && echo ok || echo denied; }
b=$(priv); echo "before: $b read=$(reads)"; [ "$b" = "decisions:false/true signals:false/true" ]; [ "$(reads)" = denied ]
P -f supabase/migrations/$V.sql; u=$(priv); echo "up1: $u read=$(reads)"; [ "$u" = "decisions:true/true signals:true/true" ]; [ "$(reads)" = ok ]
P -f supabase/rollbacks/$V.down.sql; d=$(priv); echo "down: $d read=$(reads)"; [ "$d" = "$b" ]; [ "$(reads)" = denied ]
P -f supabase/migrations/$V.sql; [ "$(priv)" = "$u" ] && echo "up2: identical to up1"
P -f supabase/migrations/$V.sql; [ "$(priv)" = "$u" ] && echo "rerun: idempotent"
echo PASS
