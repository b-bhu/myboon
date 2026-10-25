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
"${PS[@]}" -f "$REPO/supabase/migrations/20261025100000_atlas_core.sql" >/dev/null
"${PS[@]}" -f "$REPO/supabase/migrations/20261025100300_atlas_shelves_carousel.sql" >/dev/null
python3 "$REPO/scripts/atlas/seed_shelves.py" "$SRC" "$TMP/sh" >/dev/null
for f in "$TMP"/sh/*.sql; do "${PS[@]}" -f "$f"; done
"${PS[@]}" -f "$HERE/search.sql" >/dev/null
python3 "$HERE/score.py" "$HERE/queries.tsv" "$OUT" -- "${PS[@]}"
