#!/usr/bin/env bash
# #337 final step: run 20261019120000 + its rollback on a THROWAWAY local Postgres 17.
# Never points at Supabase. Usage: bash supabase/tests/20261019120000_entity_memories_read_only_archive.pg-test.sh
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
TMP=$(mktemp -d /tmp/pr39xpg.XXXX); PORT=55438
trap '"$BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
"$BIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
"$BIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null
PSQL=(psql -X -q -h "$TMP" -p $PORT -U postgres -d postgres -v ON_ERROR_STOP=1)
M=$REPO/supabase/migrations; R=$REPO/supabase/rollbacks; T=$REPO/supabase/tests; FAILS=0

# Pre-migration state mirroring prod (Oct 19 read-only SELECTs): the three roles
# with full table grants, RLS enabled on entity_memories, the ON DELETE CASCADE
# FK, and the three existing no-op guard triggers under their prod names.
{
cat <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE TABLE public.entities(id uuid PRIMARY KEY, status text NOT NULL);
CREATE TABLE public.entity_memories(id uuid PRIMARY KEY, entity_id uuid REFERENCES public.entities(id) ON DELETE CASCADE, title text);
ALTER TABLE public.entity_memories ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.entities, public.entity_memories TO anon, authenticated, service_role;
CREATE FUNCTION public.entity_memories_fixture_noop_v1() RETURNS trigger LANGUAGE plpgsql AS $noop$
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$noop$;
CREATE TRIGGER entity_memories_compat_identity_v1 BEFORE INSERT OR UPDATE
  ON public.entity_memories FOR EACH ROW EXECUTE FUNCTION public.entity_memories_fixture_noop_v1();
CREATE TRIGGER entity_memories_active_entity_guard BEFORE INSERT OR UPDATE OR DELETE
  ON public.entity_memories FOR EACH ROW EXECUTE FUNCTION public.entity_memories_fixture_noop_v1();
CREATE TRIGGER entity_memories_canonical_scope_guard BEFORE INSERT OR UPDATE OR DELETE
  ON public.entity_memories FOR EACH ROW EXECUTE FUNCTION public.entity_memories_fixture_noop_v1();
-- Seed: 2 entities, 3 memories.
INSERT INTO public.entities(id, status) VALUES
 ('eeeeeeee-0000-4000-8000-000000000001','active'),
 ('eeeeeeee-0000-4000-8000-000000000002','active');
INSERT INTO public.entity_memories(id, entity_id, title) VALUES
 ('bbbbbbbb-0000-4000-8000-000000000011','eeeeeeee-0000-4000-8000-000000000001','m1'),
 ('bbbbbbbb-0000-4000-8000-000000000012','eeeeeeee-0000-4000-8000-000000000001','m2'),
 ('bbbbbbbb-0000-4000-8000-000000000013','eeeeeeee-0000-4000-8000-000000000002','m3');
SQL
} > "$TMP/fixture.sql"
"${PSQL[@]}" -f "$TMP/fixture.sql" >/dev/null || { echo "FAIL fixture"; exit 1; }; echo "fixture: OK"

# expect <label> <role> <sqlstate|OK> <sql> — runs BEGIN; (SET LOCAL ROLE); DO; ROLLBACK.
expect() {
  local label=$1 role=$2 want=$3 sql=$4 got
  local steer="SET LOCAL ROLE $role;"
  [[ $role == postgres ]] && steer=""
  got=$("${PSQL[@]}" -t -A -v ON_ERROR_STOP=0 -c "BEGIN; $steer DO \$t\$ BEGIN $sql; RAISE NOTICE 'RESULT=OK'; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT=% %', SQLSTATE, SQLERRM; END \$t\$; ROLLBACK;" 2>&1 | sed -n 's/.*RESULT=//p')
  if [[ "${got%% *}" == "$want" ]]; then echo "PASS $label -> $got"; else echo "FAIL $label: want $want got $got"; FAILS=$((FAILS+1)); fi
}
MEM="'bbbbbbbb-0000-4000-8000-000000000011'"; ENT="'eeeeeeee-0000-4000-8000-000000000002'"
ins() { echo "INSERT INTO public.entity_memories(id, entity_id, title) VALUES ('bbbbbbbb-0000-4000-8000-000000000014', 'eeeeeeee-0000-4000-8000-000000000001', 'm4')"; }
upd() { echo "UPDATE public.entity_memories SET title = title WHERE id = $MEM"; }
del() { echo "DELETE FROM public.entity_memories WHERE id = $MEM"; }
trunc() { echo "EXECUTE 'TRUNCATE public.entity_memories'"; }
sel() { echo "EXECUTE 'SELECT id FROM public.entity_memories'"; }
sel_lock() { echo "EXECUTE 'SELECT id FROM public.entity_memories FOR SHARE'"; }
del_entity() { echo "DELETE FROM public.entities WHERE id = $ENT"; }

echo "== before migration (baseline as service_role)"
expect "baseline: INSERT" service_role OK "$(ins)"
expect "baseline: UPDATE" service_role OK "$(upd)"
expect "baseline: DELETE" service_role OK "$(del)"
expect "baseline: TRUNCATE" service_role OK "$(trunc)"
expect "baseline: SELECT ... FOR SHARE" service_role OK "$(sel_lock)"

echo "== apply migration (single transaction, then again for idempotency)"
"${PSQL[@]}" --single-transaction -f "$M/20261019120000_entity_memories_read_only_archive.sql" >/dev/null || { echo "FAIL migration"; exit 1; }; echo "migration: OK"
"${PSQL[@]}" --single-transaction -f "$M/20261019120000_entity_memories_read_only_archive.sql" >/dev/null || { echo "FAIL migration re-run"; exit 1; }; echo "migration re-run (idempotent): OK"
echo "== post-migration check file"
CHK=$("${PSQL[@]}" -t -A -F'|' -f "$T/20261019120000_entity_memories_read_only_archive.check.sql")
echo "$CHK"; if echo "$CHK" | grep -q '|f$'; then echo "FAIL check file"; FAILS=$((FAILS+1)); else echo "PASS check file"; fi

echo "== after migration: archive is read-only"
expect "service_role INSERT rejected" service_role 42501 "$(ins)"
expect "service_role UPDATE rejected" service_role 42501 "$(upd)"
expect "service_role DELETE rejected" service_role 42501 "$(del)"
expect "service_role TRUNCATE rejected" service_role 42501 "$(trunc)"
expect "service_role SELECT ok" service_role OK "$(sel)"
expect "service_role SELECT ... FOR SHARE ok (publication guard path)" service_role OK "$(sel_lock)"
expect "postgres (owner) UPDATE rejected" postgres 42501 "$(upd)"
expect "postgres (owner) DELETE rejected" postgres 42501 "$(del)"
expect "postgres DELETE entity WITH memories rejected (cascade blocked)" postgres 42501 "$(del_entity)"
CNT=$("${PSQL[@]}" -t -A -c "SELECT count(*) FROM public.entity_memories")
if [[ $CNT == 3 ]]; then echo "PASS row count $CNT (archive intact)"; else echo "FAIL row count: want 3 got $CNT"; FAILS=$((FAILS+1)); fi

echo "== rollback (single transaction, then again for idempotency)"
"${PSQL[@]}" --single-transaction -f "$R/20261019120000_entity_memories_read_only_archive.down.sql" >/dev/null || { echo "FAIL rollback"; exit 1; }; echo "rollback: OK"
"${PSQL[@]}" --single-transaction -f "$R/20261019120000_entity_memories_read_only_archive.down.sql" >/dev/null || { echo "FAIL rollback re-run"; exit 1; }; echo "rollback re-run (idempotent): OK"
echo "== post-rollback check file"
RCHK=$("${PSQL[@]}" -t -A -F'|' -f "$T/20261019120000_entity_memories_read_only_archive.rollback.check.sql")
echo "$RCHK"; if echo "$RCHK" | grep -q '|f$'; then echo "FAIL rollback check file"; FAILS=$((FAILS+1)); else echo "PASS rollback check file"; fi

echo "== after rollback: table writable again"
expect "service_role INSERT ok" service_role OK "$(ins)"
expect "service_role UPDATE ok" service_role OK "$(upd)"
expect "service_role DELETE ok" service_role OK "$(del)"
expect "service_role TRUNCATE ok" service_role OK "$(trunc)"
expect "service_role SELECT ... FOR SHARE ok" service_role OK "$(sel_lock)"

echo "== re-apply migration"
"${PSQL[@]}" --single-transaction -f "$M/20261019120000_entity_memories_read_only_archive.sql" >/dev/null || { echo "FAIL migration re-apply"; exit 1; }; echo "migration re-apply: OK"
CHK2=$("${PSQL[@]}" -t -A -F'|' -f "$T/20261019120000_entity_memories_read_only_archive.check.sql")
if echo "$CHK2" | grep -q '|f$'; then echo "FAIL check file (re-apply)"; FAILS=$((FAILS+1)); else echo "PASS check file (re-apply)"; fi
expect "service_role INSERT rejected again" service_role 42501 "$(ins)"

echo "== FAILS=$FAILS"; exit $((FAILS>0))