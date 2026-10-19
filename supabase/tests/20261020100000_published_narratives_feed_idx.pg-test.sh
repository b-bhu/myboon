#!/usr/bin/env bash
# #336 item 8: drift/restore test for published_narratives_feed_idx on a
# THROWAWAY local Postgres 17. Never points at Supabase.
# Applies every migration in order (prod baseline = 20260605 creates the index),
# simulates prod drift by dropping it, then verifies 20261020100000 restores it:
# exact indexdef, idempotent re-apply, feed-query plan before/after, rollback.
# Usage: bash supabase/tests/20261020100000_published_narratives_feed_idx.pg-test.sh
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
TMP=$(mktemp -d /tmp/issue336pg8.XXXX); PORT=55449; DB=db336i8
MIG=20261020100000_published_narratives_feed_idx.sql
DOWN=20261020100000_published_narratives_feed_idx.down.sql
EXPECTED_DEF='CREATE INDEX published_narratives_feed_idx ON public.published_narratives USING btree (created_at DESC, priority DESC)'
QUERY='select id, content_small, tags, content_type, created_at, source, primary_topic from public.published_narratives order by created_at desc limit 20'
trap '"$BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
"$BIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
"$BIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null
"$BIN/createdb" -h "$TMP" -p $PORT -U postgres "$DB"
PSQL=(psql -X -q -h "$TMP" -p $PORT -U postgres -d "$DB" -v ON_ERROR_STOP=1)
M=$REPO/supabase/migrations; R=$REPO/supabase/rollbacks; FAILS=0

# Supabase shim (roles/schemas/extensions) for the throwaway cluster; NOT Supabase, NOT prod.
"${PSQL[@]}" <<'SQL' >/dev/null
DO $$ BEGIN
  PERFORM 1;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticator') THEN CREATE ROLE authenticator NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_admin') THEN CREATE ROLE supabase_admin NOLOGIN; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_user::text $$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
SQL

# Every migration before this one, each in one transaction.
for f in $(ls "$M"/*.sql | sort); do
  base=$(basename "$f")
  if [[ "$base" > "$MIG" ]]; then break; fi
  "${PSQL[@]}" --single-transaction -f "$f" >/dev/null || { echo "FAIL migrate $base"; exit 1; }
done
echo "migrations: OK"

# ~5,000 published rows like the publisher's fixture: distinct created_at and a
# wide content_full so the heap dominates like prod; ANALYZE keeps the planner honest.
"${PSQL[@]}" <<'SQL' >/dev/null || { echo "FAIL seed"; exit 1; }
INSERT INTO public.published_narratives
  (content_small, content_full, tags, priority, actions, content_type, created_at, source, primary_topic)
SELECT
  'narrative ' || g,
  repeat(md5(g::text), 20),
  jsonb_build_array('t' || (g % 7)),
  (g % 5)::numeric,
  '[]'::jsonb,
  'narrative',
  now() - (g * interval '1 minute'),
  'news',
  'topic ' || (g % 11)
FROM generate_series(1, 5000) AS s(g);
ANALYZE public.published_narratives;
SQL
echo "seed: OK"

index_def()   { "${PSQL[@]}" -t -A -c "SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='published_narratives_feed_idx';"; }
index_count() { "${PSQL[@]}" -t -A -c "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='published_narratives_feed_idx';"; }
explain_query() { "${PSQL[@]}" -c "EXPLAIN (ANALYZE, TIMING ON) $QUERY;"; }

# 1. Drift simulation: after all migrations, DROP the index (as prod), then
# apply the new migration; the index must come back with the exact definition.
echo "== 1. drift: drop index (as prod), then apply migration"
"${PSQL[@]}" -c "DROP INDEX IF EXISTS public.published_narratives_feed_idx;" >/dev/null
if [[ "$(index_count)" == "0" ]]; then
  echo "PASS drift baseline: index absent"
else
  echo "FAIL drift baseline: index still present"; FAILS=$((FAILS+1))
fi
"${PSQL[@]}" --single-transaction -f "$M/$MIG" >/dev/null || { echo "FAIL migration apply"; exit 1; }
got_def=$(index_def)
if [[ "$got_def" == "$EXPECTED_DEF" ]]; then
  echo "PASS indexdef exact: $got_def"
else
  echo "FAIL indexdef: want [$EXPECTED_DEF] got [$got_def]"; FAILS=$((FAILS+1))
fi

# 2. Re-applying the migration when the index already exists is a no-op.
echo "== 2. re-apply migration (idempotent)"
if "${PSQL[@]}" --single-transaction -f "$M/$MIG" >/dev/null && [[ "$(index_count)" == "1" && "$(index_def)" == "$EXPECTED_DEF" ]]; then
  echo "PASS re-apply no-op (index unchanged)"
else
  echo "FAIL re-apply: count=$(index_count) def=[$(index_def)]"; FAILS=$((FAILS+1))
fi

# 3. Feed query plan and timing before (index dropped) and after.
echo "== 3. feed query plan before (dropped) and after"
"${PSQL[@]}" -c "DROP INDEX IF EXISTS public.published_narratives_feed_idx;" >/dev/null
before_plan=$(explain_query)
echo "--- plan with index dropped (prod state):"
echo "$before_plan"
if echo "$before_plan" | grep -q 'published_narratives_feed_idx'; then
  echo "FAIL before-plan still uses the index"; FAILS=$((FAILS+1))
else
  echo "PASS before-plan has no feed index (planner falls back)"
fi
"${PSQL[@]}" --single-transaction -f "$M/$MIG" >/dev/null || { echo "FAIL restore apply"; exit 1; }
after_plan=$(explain_query)
echo "--- plan after migration restore:"
echo "$after_plan"
if echo "$after_plan" | grep -q 'published_narratives_feed_idx'; then
  echo "PASS after-plan uses published_narratives_feed_idx"
else
  echo "FAIL after-plan does not use the feed index"; FAILS=$((FAILS+1))
fi

# 4. Rollback drops it; rollback is idempotent.
echo "== 4. rollback twice"
"${PSQL[@]}" --single-transaction -f "$R/$DOWN" >/dev/null || { echo "FAIL rollback apply"; FAILS=$((FAILS+1)); }
if [[ "$(index_count)" == "0" ]]; then
  echo "PASS rollback drops index"
else
  echo "FAIL rollback: index still present"; FAILS=$((FAILS+1))
fi
"${PSQL[@]}" --single-transaction -f "$R/$DOWN" >/dev/null || { echo "FAIL rollback re-apply"; FAILS=$((FAILS+1)); }
if [[ "$(index_count)" == "0" ]]; then
  echo "PASS rollback idempotent"
else
  echo "FAIL rollback idempotent: index present"; FAILS=$((FAILS+1))
fi

echo "== FAILS=$FAILS"
exit $((FAILS>0))