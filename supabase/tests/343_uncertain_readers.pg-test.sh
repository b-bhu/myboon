#!/usr/bin/env bash
# #343: prove every story/history reader skips uncertain memberships, on a
# THROWAWAY local Postgres 17 with every repo migration applied in order.
# Never points at Supabase and never runs `supabase db push` (#397).
# Usage: bash supabase/tests/343_uncertain_readers.pg-test.sh
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
TMP=$(mktemp -d /tmp/pg343.XXXX); PORT=${PG_TEST_PORT:-55343}
trap '"$BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
"$BIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
"$BIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null
PSQL=(psql -X -q -h "$TMP" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1)

# Minimal Supabase surface the migrations expect.
"${PSQL[@]}" -c "CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE ROLE authenticator NOINHERIT LOGIN; GRANT anon, authenticated, service_role TO authenticator;
  CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto SCHEMA extensions; CREATE EXTENSION \"uuid-ossp\" SCHEMA extensions;"
count=0
for migration in "$REPO"/supabase/migrations/*.sql; do
  PGOPTIONS='-c client_min_messages=error' "${PSQL[@]}" -1 -f "$migration" >/dev/null 2>"$TMP/migration.err" || { cat "$TMP/migration.err"; echo "FAIL migration $(basename "$migration")"; exit 1; }
  count=$((count + 1))
done
echo "migrations applied: $count"

# context_v1 + article_context_v1 (research context and story history).
"${PSQL[@]}" -f "$REPO/supabase/tests/20261017093000_article_uncertain_memberships.check.sql" 2>&1 | grep -o 'check 343 ok.*' \
  || { echo "FAIL 20261017093000_article_uncertain_memberships.check.sql"; exit 1; }
# read_managed_entity_knowledge_v1 (stories API, editor-draft, publisher, x-desk).
"${PSQL[@]}" -f "$REPO/supabase/tests/20261017210000_managed_entity_knowledge_reader.uncertain.check.sql" 2>&1 | grep -o 'check 343 reader ok.*' \
  || { echo "FAIL 20261017210000_managed_entity_knowledge_reader.uncertain.check.sql"; exit 1; }
echo "PASS: every reader skips uncertain memberships"
