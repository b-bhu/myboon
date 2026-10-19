#!/usr/bin/env bash
# #390: run 20261018090000 (baseline) then 20261019190000 + its rollback on a THROWAWAY local Postgres 17.
# Never points at Supabase. Usage: bash supabase/tests/20261019190000_published_managed_memory_ownership.pg-test.sh
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${PG_BIN:-/usr/lib/postgresql/17/bin}
TMP=$(mktemp -d /tmp/pr390pg.XXXX); PORT=55438
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
CREATE TABLE managed_knowledge_private.memberships(item_id uuid NOT NULL REFERENCES managed_knowledge_private.items(id), entity_id uuid NOT NULL,
  role text, added_operation text, removed_operation text, placement_confidence numeric, uncertain boolean NOT NULL DEFAULT false, PRIMARY KEY(item_id,entity_id));
DO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['entities','items','item_heads','memberships'] LOOP
  EXECUTE format('ALTER TABLE managed_knowledge_private.%I ENABLE ROW LEVEL SECURITY', r);
  EXECUTE format('ALTER TABLE managed_knowledge_private.%I FORCE ROW LEVEL SECURITY', r);
  EXECUTE format('CREATE POLICY owner_only ON managed_knowledge_private.%I TO myboon_knowledge_owner USING (true) WITH CHECK (true)', r);
  EXECUTE format('GRANT SELECT, INSERT ON managed_knowledge_private.%I TO myboon_knowledge_owner', r);
END LOOP; END $$;
GRANT UPDATE ON managed_knowledge_private.item_heads, managed_knowledge_private.memberships TO myboon_knowledge_owner;
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
INSERT INTO managed_knowledge_private.items VALUES ('bbbbbbbb-0000-4000-8000-000000000021','mi1'),('bbbbbbbb-0000-4000-8000-000000000022','mi2'),
 ('bbbbbbbb-0000-4000-8000-000000000023','mi3'),('bbbbbbbb-0000-4000-8000-000000000024','mi4'),('bbbbbbbb-0000-4000-8000-000000000025','mi5'),('bbbbbbbb-0000-4000-8000-000000000026','mi6');
INSERT INTO managed_knowledge_private.item_heads(item_id,status) VALUES ('bbbbbbbb-0000-4000-8000-000000000021','active'),('bbbbbbbb-0000-4000-8000-000000000022','retracted'),
 ('bbbbbbbb-0000-4000-8000-000000000023','active'),('bbbbbbbb-0000-4000-8000-000000000024','active'),('bbbbbbbb-0000-4000-8000-000000000025','active'),('bbbbbbbb-0000-4000-8000-000000000026','active');
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

MI3='["bbbbbbbb-0000-4000-8000-000000000023"]'; MI4='["bbbbbbbb-0000-4000-8000-000000000024"]'
MI5='["bbbbbbbb-0000-4000-8000-000000000025"]'; MI6='["bbbbbbbb-0000-4000-8000-000000000026"]'
# Memberships (CTO #390 Q5): MI1 live to A and C; MI3 live to C only; MI4 to A but removed; MI5 to A but uncertain; MI6 live to A.
"${PSQL[@]}" -c "INSERT INTO managed_knowledge_private.memberships(item_id,entity_id,role,added_operation,removed_operation,uncertain) VALUES
 ('bbbbbbbb-0000-4000-8000-000000000021',$A,'primary','op',NULL,false), ('bbbbbbbb-0000-4000-8000-000000000021',$C,'related','op',NULL,false),
 ('bbbbbbbb-0000-4000-8000-000000000023',$C,'primary','op',NULL,false), ('bbbbbbbb-0000-4000-8000-000000000024',$A,'primary','op','op-rm',false),
 ('bbbbbbbb-0000-4000-8000-000000000025',$A,'primary','op',NULL,true),  ('bbbbbbbb-0000-4000-8000-000000000026',$A,'primary','op',NULL,false)" >/dev/null && echo "memberships: OK"

echo "== apply #389 migration 20261018090000 (prerequisite)"
"${PSQL[@]}" --single-transaction -f "$M/20261018090000_published_entity_managed_ids.sql" >/dev/null || { echo "FAIL 20261018090000"; exit 1; }; echo "20261018090000: OK"
echo "== before #390 (gap being closed)"
expect "before: managed memory owned only by C, cited for A, is accepted" OK "$(ins "$A" "$MI3")"
expect "before: removed membership accepted" OK "$(ins "$A" "$MI4")"
expect "before: uncertain membership accepted" OK "$(ins "$A" "$MI5")"

GUARD389=$("${PSQL[@]}" -t -A -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.entity_publication_relationship_guard_v1()'::regprocedure")
echo "== apply #390 migration (single transaction)"
"${PSQL[@]}" --single-transaction -f "$M/20261019190000_published_managed_memory_ownership.sql" >/dev/null || { echo "FAIL migration"; exit 1; }; echo "migration: OK"
echo "== post-migration check file"
CHK=$("${PSQL[@]}" -t -A -F'|' -f "$REPO/supabase/tests/20261019190000_published_managed_memory_ownership.check.sql")
echo "$CHK"; if echo "$CHK" | grep -q '|f$'; then echo "FAIL check file"; FAILS=$((FAILS+1)); else echo "PASS check file"; fi
CHK=$("${PSQL[@]}" -t -A -F'|' -f "$REPO/supabase/tests/20261018090000_published_entity_managed_ids.check.sql")
if echo "$CHK" | grep -q '|f$'; then echo "FAIL #389 check file"; echo "$CHK"; FAILS=$((FAILS+1)); else echo "PASS #389 check file still passes"; fi

run389() {
  local p=$1
  expect "$p 1 active catalogue A passes" OK "$(ins "$A" '[]')"
  expect "$p 2 archived catalogue B rejected" 40001 "$(ins "$B" '[]')"
  expect "$p 3 active article-only C passes" OK "$(ins "$C" '[]')"
  expect "$p 4 review article-only D rejected" 40001 "$(ins "$D" '[]')"
  expect "$p 5 neither store rejected" 23503 "$(ins "$X" '[]')"
  for e in A B C D X; do w=OK; [[ $e == B || $e == D ]] && w=40001; [[ $e == X ]] && w=23503
    expect "$p history $e" $w "INSERT INTO public.published_narratives(id,entity_id) VALUES ('dddddddd-0000-4000-8000-000000000001',$A); INSERT INTO public.entity_published_history(published_narrative_id, entity_id) VALUES ('dddddddd-0000-4000-8000-000000000001', ${!e})"; done
  expect "$p entity_memories keeps shared guard (C rejected)" 23503 "INSERT INTO public.entity_memories VALUES (gen_random_uuid(), $C)"
  expect "$p 6 managed active memory publishes (catalogue A)" OK "$(ins "$A" "$MI1")"
  expect "$p 6b managed active memory publishes (article-only C)" OK "$(ins "$C" "$MI1")"
  expect "$p 7 memory in neither store rejected" 23503 "$(ins "$A" "$MX")"
  expect "$p 7b retracted managed memory rejected" 23503 "$(ins "$A" "$MI2")"
  expect "$p public memory still publishes" OK "$(ins "$A" "$M1")"
  for r in service_role anon authenticated; do w=OK; [[ $r != service_role ]] && w=42501
    got=$("${PSQL[@]}" -t -A -v ON_ERROR_STOP=0 -c "BEGIN; SET LOCAL ROLE $r; DO \$t\$ BEGIN PERFORM public.read_managed_entities_v1(ARRAY[$C]::uuid[]); RAISE NOTICE 'RESULT=OK'; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RESULT=% %', SQLSTATE, SQLERRM; END \$t\$; ROLLBACK;" 2>&1 | sed -n 's/.*RESULT=//p')
    if [[ "${got%% *}" == "$w" ]]; then echo "PASS $p read_managed_entities_v1 as $r -> $got"; else echo "FAIL $p $r: want $w got $got"; FAILS=$((FAILS+1)); fi; done
}
echo "== every #389 case keeps its result"
run389 "#389"

echo "== #390 ownership cases"
expect "S1 membership to A, publication for A succeeds" OK "$(ins "$A" "$MI6")"
expect "S2 membership to C only, publication for A rejected" 23503 "$(ins "$A" "$MI3")"
expect "S2b same memory, publication for C succeeds" OK "$(ins "$C" "$MI3")"
expect "removed membership rejected" 23503 "$(ins "$A" "$MI4")"
expect "uncertain membership rejected" 23503 "$(ins "$A" "$MI5")"
expect "mixed: public M1 + managed MI3 for A rejected" 23503 "INSERT INTO public.published_narratives(entity_id, source_memory_ids) VALUES ($A, '[\"bbbbbbbb-0000-4000-8000-000000000011\",\"bbbbbbbb-0000-4000-8000-000000000023\"]'::jsonb)"
expect "history uses the narrative's entity (narrative C cites MI3, history row OK)" OK "INSERT INTO public.published_narratives(id,entity_id,source_memory_ids) VALUES ('dddddddd-0000-4000-8000-000000000002',$C,'$MI3'::jsonb); INSERT INTO public.entity_published_history(published_narrative_id, entity_id) VALUES ('dddddddd-0000-4000-8000-000000000002', $C)"
expect "service_role cannot read memberships directly (helper is the only path)" 42501 "PERFORM 1 FROM managed_knowledge_private.memberships"
for r in service_role anon authenticated; do w=t; [[ $r != service_role ]] && w=f
  got=$("${PSQL[@]}" -t -A -c "SELECT has_function_privilege('$r','public.managed_owned_memory_ids_v1(uuid[],uuid,boolean)','EXECUTE')")
  if [[ $got == "$w" ]]; then echo "PASS helper EXECUTE for $r = $got"; else echo "FAIL helper EXECUTE $r: want $w got $got"; FAILS=$((FAILS+1)); fi; done

# S3: a second session moves the membership while the publish waits.
# Session 2 locks Entity A FOR UPDATE-free path is not needed: it holds the
# membership row (UPDATE) so the guard's FOR SHARE on memberships waits, then
# commits a move to C (removed for A). The guard must answer 40001.
wait_case() {
  local label=$1 update=$2 restore=$3
  ( "${PSQL[@]}" -c "BEGIN; $update; SELECT pg_sleep(2); COMMIT;" >/dev/null 2>"$TMP/s2.err" ) &
  local s2=$!; sleep 0.8
  local t0=$(date +%s.%N)
  expect "$label" 40001 "$(ins "$A" "$MI6")"
  local t1=$(date +%s.%N); wait $s2
  echo "     (publish waited $(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.1f", b-a}')s on session 2's membership lock)"
  "${PSQL[@]}" -c "$restore" >/dev/null
}
wait_case "S3 membership moved to C during the wait" \
  "UPDATE managed_knowledge_private.memberships SET removed_operation='op-move' WHERE item_id='bbbbbbbb-0000-4000-8000-000000000026' AND entity_id=$A; INSERT INTO managed_knowledge_private.memberships(item_id,entity_id,role,added_operation) VALUES ('bbbbbbbb-0000-4000-8000-000000000026',$C,'primary','op-move')" \
  "DELETE FROM managed_knowledge_private.memberships WHERE item_id='bbbbbbbb-0000-4000-8000-000000000026' AND entity_id=$C; UPDATE managed_knowledge_private.memberships SET removed_operation=NULL WHERE item_id='bbbbbbbb-0000-4000-8000-000000000026'"
wait_case "S3b membership flipped to uncertain during the wait" \
  "UPDATE managed_knowledge_private.memberships SET uncertain=true WHERE item_id='bbbbbbbb-0000-4000-8000-000000000026' AND entity_id=$A" \
  "UPDATE managed_knowledge_private.memberships SET uncertain=false WHERE item_id='bbbbbbbb-0000-4000-8000-000000000026'"
( "${PSQL[@]}" -c "BEGIN; UPDATE managed_knowledge_private.memberships SET role=role WHERE item_id='bbbbbbbb-0000-4000-8000-000000000026' AND entity_id=$A; SELECT pg_sleep(2); COMMIT;" >/dev/null ) & s2=$!; sleep 0.8
expect "S3c control: no-op update during the wait still publishes" OK "$(ins "$A" "$MI6")"; wait $s2

echo "== rollback"
"${PSQL[@]}" --single-transaction -f "$REPO/supabase/rollbacks/20261019190000_published_managed_memory_ownership.down.sql" >/dev/null && echo "rollback: OK" || { echo "FAIL rollback"; FAILS=$((FAILS+1)); }
RCHK=$("${PSQL[@]}" -t -A -F'|' -f "$REPO/supabase/tests/20261019190000_published_managed_memory_ownership.rollback.check.sql")
echo "$RCHK"; if echo "$RCHK" | grep -q '|f$'; then echo "FAIL rollback check file"; FAILS=$((FAILS+1)); else echo "PASS rollback check file"; fi
GUARDRB=$("${PSQL[@]}" -t -A -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.entity_publication_relationship_guard_v1()'::regprocedure")
if [[ "$GUARDRB" == "$GUARD389" ]]; then echo "PASS guard body after rollback is byte-identical to the #389 body (md5 ${GUARDRB:0:12})"; else echo "FAIL guard body differs after rollback"; FAILS=$((FAILS+1)); fi
expect "after rollback: C-only memory cited for A accepted again (#389 behaviour)" OK "$(ins "$A" "$MI3")"
run389 "after rollback"
echo "== FAILS=$FAILS"; exit $((FAILS>0))
