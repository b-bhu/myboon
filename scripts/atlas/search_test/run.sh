#!/usr/bin/env bash
# #443: run the 20-query Atlas search test on a THROWAWAY local PG17 loaded from cleanup.sqlite.
# Never points at Supabase. Usage: bash scripts/atlas/search_test/run.sh [out_dir]
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../../.." && pwd)
SRC=${CLEANUP_SQLITE:-/home/box/work/myboon-snapshot/cleanup.sqlite}
OUT=${1:-$HERE/results}; mkdir -p "$OUT"
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}; PORT=55443
TMP=$(mktemp -d "${PG_TEST_ROOT:-/home/box/work}/search443.XXXX")
trap '"$BIN/pg_ctl" -D "$TMP/d" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
"$BIN/initdb" -D "$TMP/d" -U postgres -A trust >/dev/null
"$BIN/pg_ctl" -D "$TMP/d" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null
PS=(psql -X -q -h "$TMP" -p $PORT -U postgres -v ON_ERROR_STOP=1)
# All atlas migrations (incl. #541 rename to atlas.entities); tool_log is a partitioned stand-in, as in supabase/tests.
"${PS[@]}" -c "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;" >/dev/null
for f in $(ls "$REPO"/supabase/migrations/*_atlas*.sql | sort); do
  if [[ $(basename "$f") == 20261025100200_atlas_tool_log.sql ]]; then
    "${PS[@]}" -c "create table atlas.tool_log (id bigint generated always as identity, logged_at timestamptz not null default now(), run_id text, tool text not null, input jsonb, output jsonb, duration_ms bigint, error text, primary key (logged_at, id)); alter table atlas.tool_log enable row level security;" >/dev/null
    continue
  fi
  "${PS[@]}" -f "$f" >/dev/null
done
python3 "$REPO/scripts/atlas/seed_entities.py" "$SRC" "$TMP/sh" >/dev/null
for f in "$TMP"/sh/*.sql; do "${PS[@]}" -f "$f"; done
"${PS[@]}" -f "$HERE/search.sql" >/dev/null
python3 "$HERE/score.py" "$HERE/queries.tsv" "$OUT" -- "${PS[@]}"
