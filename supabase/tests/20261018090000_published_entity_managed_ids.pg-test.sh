#!/usr/bin/env bash
# #337 PR-D: run 20261018090000 + its rollback on a THROWAWAY local Postgres 17.
# Never points at Supabase. Usage: bash supabase/tests/20261018090000_published_entity_managed_ids.pg-test.sh
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
TMP=$(mktemp -d /tmp/pr389pg.XXXX); PORT=55437
trap '"$BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
"$BIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
"$BIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null
PSQL=(psql -X -q -h "$TMP" -p $PORT -U postgres -d postgres -v ON_ERROR_STOP=1)
M=$REPO/supabase/migrations; FAILS=0

# Pre-PR state: roles, touched tables, shared guard (20260921142116) and relationship guard (20260921153932) verbatim.
{
cat <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE myboon_knowledge_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE TABLE public.entities(id uuid PRIMARY KEY, slug text, name text, type text, aliases jsonb DEFAULT '[]', summary text,
  status text NOT NULL, metadata jsonb DEFAULT '{}', created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
ALTER TABLE public.entities ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA public TO myboon_knowledge_owner, service_role;
GRANT SELECT (id,slug,name,type,aliases,summary,status,metadata,created_at,updated_at) ON public.entities TO myboon_knowledge_owner;
GRANT UPDATE(updated_at) ON public.entities TO myboon_knowledge_owner;
CREATE POLICY entity_v4_private_catalog_lookup ON public.entities FOR SELECT TO myboon_knowledge_owner USING (true);
CREATE POLICY entity_v4_private_catalog_lock ON public.entities FOR UPDATE TO myboon_knowledge_owner USING (true) WITH CHECK (false);
CREATE TABLE public.entity_memories(id uuid PRIMARY KEY, entity_id uuid REFERENCES public.entities(id));
CREATE TABLE public.published_narratives(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text,
  entity_id uuid REFERENCES public.entities(id) ON DELETE SET NULL, entity_slug text, entity_name text,
  source_memory_ids jsonb NOT NULL DEFAULT '[]');
CREATE TABLE public.entity_published_history(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), published_narrative_id uuid,
  entity_id uuid REFERENCES public.entities(id) ON DELETE SET NULL, entity_slug text);
GRANT SELECT, INSERT, UPDATE ON public.entities, public.entity_memories, public.published_narratives, public.entity_published_history TO service_role;
CREATE SCHEMA managed_knowledge_private; GRANT USAGE ON SCHEMA managed_knowledge_private TO myboon_knowledge_owner;
CREATE TABLE managed_knowledge_private.entities(id uuid PRIMARY KEY, identity_key text, catalog_entity_id uuid REFERENCES public.entities(id),
  name text, slug text, type text, aliases jsonb, summary text, status text, show_in_carousel boolean, metadata jsonb,
  created_at timestamptz DEFAULT now(), updated_at timestamptz);
CREATE TABLE managed_knowledge_private.items(id uuid PRIMARY KEY, note text);
CREATE TABLE managed_knowledge_private.item_heads(item_id uuid PRIMARY KEY REFERENCES managed_knowledge_private.items(id), revision bigint DEFAULT 1, status text DEFAULT 'active');
DO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['entities','items','item_heads'] LOOP
  EXECUTE format('ALTER TABLE managed_knowledge_private.%I ENABLE ROW LEVEL SECURITY', r);
  EXECUTE format('ALTER TABLE managed_knowledge_private.%I FORCE ROW LEVEL SECURITY', r);
  EXECUTE format('CREATE POLICY owner_only ON managed_knowledge_private.%I TO myboon_knowledge_owner USING (true) WITH CHECK (true)', r);
  EXECUTE format('GRANT SELECT, INSERT ON managed_knowledge_private.%I TO myboon_knowledge_owner', r);
END LOOP; END $$;
GRANT UPDATE ON managed_knowledge_private.item_heads TO myboon_knowledge_owner;
SQL
sed -n 613,657p "$M/20260921142116_strengthen_entity_catalog_cleanup_boundaries.sql"
echo "REVOKE ALL ON FUNCTION public.entity_reference_requires_active_v1() FROM PUBLIC, anon, authenticated; GRANT EXECUTE ON FUNCTION public.entity_reference_requires_active_v1() TO service_role;"
sed -n 79,292p "$M/20260921153932_harden_entity_catalog_review_boundaries.sql"
cat <<'SQL'
REVOKE ALL ON FUNCTION public.entity_publication_relationship_guard_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.entity_publication_relationship_guard_v1() TO service_role;
-- Seed. A active catalogue (+ linked managed row, same id), B archived catalogue,
-- C active article-only, D review article-only, M1 public memory, MI1 active / MI2 retracted managed memory.
INSERT INTO public.entities(id,slug,name,type,status) VALUES
 ('aaaaaaaa-0000-4000-8000-000000000001','a','A','token','active'),
 ('aaaaaaaa-0000-4000-8000-000000000002','b','B','token','archived');
INSERT INTO managed_knowledge_private.entities(id,identity_key,catalog_entity_id,name,slug,type,status,metadata) VALUES
 ('aaaaaaaa-0000-4000-8000-000000000001','catalog:a','aaaaaaaa-0000-4000-8000-000000000001','A','a','token','active','{}'),
 ('aaaaaaaa-0000-4000-8000-000000000003','c','',NULL,NULL,NULL,NULL,NULL) ON CONFLICT DO NOTHING;
SQL
} > "$TMP/fixture.sql"
# (the placeholder row above is replaced below; kept simple for psql)
sed -i "s/('aaaaaaaa-0000-4000-8000-000000000003','c','',NULL,NULL,NULL,NULL,NULL) ON CONFLICT DO NOTHING;/('aaaaaaaa-0000-4000-8000-000000000003','c',NULL,'C','c','token','active','{}'),('aaaaaaaa-0000-4000-8000-000000000004','d',NULL,'D','d','token','review','{}');/" "$TMP/fixture.sql"
cat >> "$TMP/fixture.sql" <<'SQL'
INSERT INTO public.entity_memories VALUES ('bbbbbbbb-0000-4000-8000-000000000011','aaaaaaaa-0000-4000-8000-000000000001');
INSERT INTO managed_knowledge_private.items VALUES ('bbbbbbbb-0000-4000-8000-000000000021','mi1'),('bbbbbbbb-0000-4000-8000-000000000022','mi2');
INSERT INTO managed_knowledge_private.item_heads(item_id,status) VALUES ('bbbbbbbb-0000-4000-8000-000000000021','active'),('bbbbbbbb-0000-4000-8000-000000000022','retracted');
SQL
"${PSQL[@]}" -f "$TMP/fixture.sql" >/dev/null || { echo "FAIL fixture"; exit 1; }; echo "fixture: OK"

# expect <label> <sqlstate|OK> <sql run as service_role>
expect() {
  local label=$1 want=$2 sql=$3 got
  got=$("${PSQL[@]}" -t -A -v ON_ERROR_STOP=0 -c "BEGIN; SET LOCAL ROLE service_role; DO \$t\$ BEGIN $sql; RAISE NOTICE 'RESULT=OK'; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT=% %', SQLSTATE, SQLERRM; END \$t\$; ROLLBACK;" 2>&1 | sed -n 's/.*RESULT=//p')
  if [[ "${got%% *}" == "$want" ]]; then echo "PASS $label -> $got"; else echo "FAIL $label: want $want got $got"; FAILS=$((FAILS+1)); fi
}
ins() { echo "INSERT INTO public.published_narratives(entity_id, source_memory_ids) VALUES ($1, '$2'::jsonb)"; }
A="'aaaaaaaa-0000-4000-8000-000000000001'"; B="'aaaaaaaa-0000-4000-8000-000000000002'"; C="'aaaaaaaa-0000-4000-8000-000000000003'"
D="'aaaaaaaa-0000-4000-8000-000000000004'"; X="'cccccccc-0000-4000-8000-0000000000ff'"
M1='["bbbbbbbb-0000-4000-8000-000000000011"]'; MI1='["bbbbbbbb-0000-4000-8000-000000000021"]'
MI2='["bbbbbbbb-0000-4000-8000-000000000022"]'; MX='["bbbbbbbb-0000-4000-8000-0000000000ff"]'

echo "== before migration (baseline)"
expect "baseline: article-only entity C rejected" 23503 "$(ins "$C" '[]')"
expect "baseline: managed-only memory rejected" 23503 "$(ins "$A" "$MI1")"

echo "== apply migration (single transaction)"
"${PSQL[@]}" --single-transaction -f "$M/20261018090000_published_entity_managed_ids.sql" >/dev/null || { echo "FAIL migration"; exit 1; }; echo "migration: OK"
echo "== post-migration check file"
CHK=$("${PSQL[@]}" -t -A -F'|' -f "$REPO/supabase/tests/20261018090000_published_entity_managed_ids.check.sql")
echo "$CHK"; if echo "$CHK" | grep -q '|f$'; then echo "FAIL check file"; FAILS=$((FAILS+1)); else echo "PASS check file"; fi

echo "== trigger cases (published_narratives and entity_published_history)"
expect "1 active catalogue A passes" OK "$(ins "$A" '[]')"
expect "2 archived catalogue B rejected" 40001 "$(ins "$B" '[]')"
expect "3 active article-only C passes" OK "$(ins "$C" '[]')"
expect "4 review article-only D rejected" 40001 "$(ins "$D" '[]')"
expect "5 neither store rejected" 23503 "$(ins "$X" '[]')"
for e in A B C D X; do w=OK; [[ $e == B || $e == D ]] && w=40001; [[ $e == X ]] && w=23503
  expect "history $e" $w "INSERT INTO public.published_narratives(id,entity_id) VALUES ('dddddddd-0000-4000-8000-000000000001',$A); INSERT INTO public.entity_published_history(published_narrative_id, entity_id) VALUES ('dddddddd-0000-4000-8000-000000000001', ${!e})"; done
expect "entity_memories keeps shared guard (C rejected)" 23503 "INSERT INTO public.entity_memories VALUES (gen_random_uuid(), $C)"
echo "== memory cases"
expect "6 managed-only active memory publishes (catalogue A)" OK "$(ins "$A" "$MI1")"
expect "6b managed-only active memory publishes (article-only C)" OK "$(ins "$C" "$MI1")"
expect "7 memory in neither store rejected" 23503 "$(ins "$A" "$MX")"
expect "7b retracted managed memory rejected" 23503 "$(ins "$A" "$MI2")"
expect "public memory still publishes" OK "$(ins "$A" "$M1")"
echo "== grants"
for r in service_role anon authenticated; do w=OK; [[ $r != service_role ]] && w=42501
  got=$("${PSQL[@]}" -t -A -v ON_ERROR_STOP=0 -c "BEGIN; SET LOCAL ROLE $r; DO \$t\$ BEGIN PERFORM public.read_managed_entities_v1(ARRAY[$C]::uuid[]); RAISE NOTICE 'RESULT=OK'; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT=% %', SQLSTATE, SQLERRM; END \$t\$; ROLLBACK;" 2>&1 | sed -n 's/.*RESULT=//p')
  if [[ "${got%% *}" == "$w" ]]; then echo "PASS read_managed_entities_v1 as $r -> $got"; else echo "FAIL $r: want $w got $got"; FAILS=$((FAILS+1)); fi; done
"${PSQL[@]}" -t -A -c "SET ROLE service_role; SELECT 'service_role sees C: '||(public.read_managed_entities_v1(ARRAY[$C]::uuid[])->0->>'name')"

echo "== rollback"
"${PSQL[@]}" -c "INSERT INTO public.published_narratives(entity_id, entity_slug, source_memory_ids) VALUES ($C,'c','[]')"
if "${PSQL[@]}" --single-transaction -f "$REPO/supabase/rollbacks/20261018090000_published_entity_managed_ids.down.sql" >"$TMP/rb1" 2>&1; then
  echo "FAIL rollback did not refuse"; FAILS=$((FAILS+1)); else echo "PASS rollback refused: $(grep -o 'rollback would strand.*' "$TMP/rb1" | cut -c1-120)"; fi
PGOPTIONS='-c myboon.rollback_null_managed_entity_ids=on' "${PSQL[@]}" --single-transaction -f "$REPO/supabase/rollbacks/20261018090000_published_entity_managed_ids.down.sql" >/dev/null && echo "rollback with NULL opt-in: OK"
"${PSQL[@]}" -t -A -c "SELECT 'stranded row after rollback: entity_id='||coalesce(entity_id::text,'NULL')||' slug='||entity_slug FROM public.published_narratives WHERE entity_slug='c'"
RCHK=$("${PSQL[@]}" -t -A -F'|' -f "$REPO/supabase/tests/20261018090000_published_entity_managed_ids.rollback.check.sql")
echo "$RCHK"; if echo "$RCHK" | grep -q '|f$'; then echo "FAIL rollback check file"; FAILS=$((FAILS+1)); else echo "PASS rollback check file"; fi
expect "after rollback: article-only C rejected again" 23503 "$(ins "$C" '[]')"
expect "after rollback: managed-only memory rejected again" 23503 "$(ins "$A" "$MI1")"
expect "after rollback: active catalogue A passes" OK "$(ins "$A" "$M1")"
echo "== FAILS=$FAILS"; exit $((FAILS>0))
