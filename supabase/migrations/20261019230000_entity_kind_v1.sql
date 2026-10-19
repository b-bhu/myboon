-- #342 PR-4: managed entity `type` becomes the EntityKindV1 enum (Linglong,
-- Oct 19). managed_knowledge_private.entities.type today holds free-text
-- legacy types (writer bindings, the fill trigger and the 20261017120000
-- initialization UPDATE copy `binding->>'type'`/catalogue values verbatim).
-- Every reader and the CTO kind map expect one of the eleven kinds, so this
-- migration adds an IMMUTABLE determinstic normaliser
-- (managed_knowledge_private.entity_kind_v1), backfills the stored column in
-- place (keeping each replaced value in metadata.legacyType), enforces the
-- eleven-value CHECK and re-points the fill trigger's writer boundary so new
-- bindings land on kinds too. Same contract as the TS
-- legacyEntityTypeToKindV1 in
-- packages/collectors/src/entity-manager/entity-knowledge-context.ts - a parity
-- test reads the CASE below and asserts every pair.
--
-- Rollback: supabase/rollbacks/20261019230000_entity_kind_v1.down.sql
-- (drops the constraint, restores type from metadata.legacyType, restores the
-- original fill body byte-for-byte, drops the function).
-- Tests: supabase/tests/20261019230000_entity_kind_v1.pg-test.sh (+ .preseed,
-- .check.sql, .behaviour.sql, .rollback.check.sql). The preseed inserts legacy
-- rows BEFORE the migration applies, exactly the state this migration must fix.
--
-- Trigger/updated_at audit (required by the task): the table has exactly one
-- trigger, managed_entities_fill_columns (BEFORE INSERT, 20261017120000); no
-- BEFORE/AFTER UPDATE trigger exists on managed_knowledge_private.entities in
-- any migration, so this one-time UPDATE cannot be reverted by a trigger and
-- updated_at is a plain column (the merge already writes it directly in
-- #342 PR-3). updated_at is deliberately NOT touched here: type + metadata
-- already change the entity_revision_v1 digest, and in-flight plans carry a
-- stale targetRevisions entry and are held and re-planned (the #337 PR-A
-- pattern), never dead-lettered.
--
-- 20261017120000-style UPDATE paths at runtime: the initialization UPDATEs
-- themselves are migration-only. The runtime backfill runner
-- (packages/collectors/src/entity-manager/managed-entity-backfill.ts) creates
-- private rows through PUBLIC_ONLY_INSERT_SQL, i.e. through the fill trigger,
-- which below normalises catalogue types too; its SHARED_UPDATE_SQL never
-- writes type. Nothing else reuses the 20261017120000 UPDATE shape at runtime.

-- 1. The kind function. Same normalisation as the TS legacyEntityTypeToKindV1
--    (lower+trim, then every run of whitespace/hyphens becomes one '_'), then
--    the deterministic kind map; anything unmapped (including NULL/empty) is
--    'unclassified'.
CREATE OR REPLACE FUNCTION managed_knowledge_private.entity_kind_v1(value text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $kind$
  SELECT CASE token
    WHEN 'person' THEN 'person'
    WHEN 'organization' THEN 'organization'
    WHEN 'company' THEN 'organization'
    WHEN 'group' THEN 'organization'
    WHEN 'exchange' THEN 'organization'
    WHEN 'government_agency' THEN 'organization'
    WHEN 'data_provider' THEN 'organization'
    WHEN 'network' THEN 'network'
    WHEN 'protocol' THEN 'protocol'
    WHEN 'project' THEN 'protocol'
    WHEN 'crypto_project' THEN 'protocol'
    WHEN 'product' THEN 'product'
    WHEN 'ai_model' THEN 'product'
    WHEN 'platform' THEN 'product'
    WHEN 'software_application' THEN 'product'
    WHEN 'ai_coding_tool' THEN 'product'
    WHEN 'ai_agent_app' THEN 'product'
    WHEN 'asset' THEN 'asset'
    WHEN 'commodity' THEN 'asset'
    WHEN 'currency' THEN 'asset'
    WHEN 'index' THEN 'asset'
    WHEN 'instrument' THEN 'asset'
    WHEN 'asset_class' THEN 'asset'
    WHEN 'cryptoasset' THEN 'asset'
    WHEN 'financial_instrument' THEN 'asset'
    WHEN 'exchange_traded_fund' THEN 'asset'
    WHEN 'country' THEN 'place'
    WHEN 'nation' THEN 'place'
    WHEN 'geo' THEN 'place'
    WHEN 'place' THEN 'place'
    WHEN 'location' THEN 'place'
    WHEN 'event' THEN 'event'
    WHEN 'conflict' THEN 'event'
    WHEN 'election' THEN 'event'
    WHEN 'topic' THEN 'topic'
    WHEN 'market_theme' THEN 'topic'
    WHEN 'sector' THEN 'topic'
    WHEN 'indicator' THEN 'topic'
    WHEN 'geopolitical_topic' THEN 'topic'
    WHEN 'event_market' THEN 'topic'
    WHEN 'market' THEN 'topic'
    WHEN 'regulation' THEN 'regulation'
    WHEN 'legislation' THEN 'regulation'
    WHEN 'regulation_or_initiative' THEN 'regulation'
    WHEN 'proposed_government_payment_program' THEN 'regulation'
    WHEN 'unclassified' THEN 'unclassified'
    WHEN 'trader' THEN 'unclassified'
    WHEN 'wallet' THEN 'unclassified'
    WHEN 'wallet_or_trader' THEN 'unclassified'
    ELSE 'unclassified'
  END
  FROM (SELECT regexp_replace(lower(trim(value)), '[[:space:]-]+', '_', 'g') AS token) normalised;
$kind$;
-- Same grants as entity_name_key_v1 (20261017120000): execute for the owner
-- and the two v4 roles, when they exist.
REVOKE ALL ON FUNCTION managed_knowledge_private.entity_kind_v1(text) FROM PUBLIC;
DO $kind_grants$
DECLARE grantee text;
BEGIN
  FOREACH grantee IN ARRAY ARRAY['myboon_knowledge_owner','myboon_v4_worker','myboon_v4_research'] LOOP
    IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = grantee) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION managed_knowledge_private.entity_kind_v1(text) TO %I',grantee);
    END IF;
  END LOOP;
END
$kind_grants$;

-- 2. One-time backfill: only rows that actually change. The replaced legacy
--    value is preserved in metadata.legacyType; an existing legacyType key is
--    never overwritten (JSON || keeps the stored value), which also makes a
--    re-apply a no-op: by then every type is already a kind, so the WHERE
--    clause matches nothing.
--    The fill trigger only fires on INSERT, so it cannot run here; no UPDATE
--    trigger exists (audit above), so nothing reverts type.
UPDATE managed_knowledge_private.entities
SET type = managed_knowledge_private.entity_kind_v1(type),
    metadata = metadata || CASE
      WHEN metadata ? 'legacyType' THEN '{}'::jsonb
      ELSE jsonb_build_object('legacyType', type) END
WHERE type IS DISTINCT FROM managed_knowledge_private.entity_kind_v1(type);

-- 3. Belt and braces before the constraint: nothing may sit outside the map.
DO $kind_audit$
BEGIN
  IF EXISTS (SELECT 1 FROM managed_knowledge_private.entities
             WHERE type NOT IN ('person','organization','network','protocol','product','asset','place','event','topic','regulation','unclassified')) THEN
    RAISE EXCEPTION 'entity_kind_v1 backfill left rows outside the 11 kinds'
      USING ERRCODE = '55000',
        DETAIL = (SELECT string_agg(DISTINCT type, ', ')
                  FROM managed_knowledge_private.entities
                  WHERE type NOT IN ('person','organization','network','protocol','product','asset','place','event','topic','regulation','unclassified'));
  END IF;
END
$kind_audit$;

-- 4. The kind CHECK, fully validated (a plain ADD ... CHECK validates every
--    row; no NOT VALID).
DO $kind_constraint$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'managed_entities_type_kind_v1'
    AND conrelid = 'managed_knowledge_private.entities'::regclass) THEN
    ALTER TABLE managed_knowledge_private.entities ADD CONSTRAINT managed_entities_type_kind_v1
      CHECK (type IN ('person','organization','network','protocol','product','asset','place','event','topic','regulation','unclassified'));
  END IF;
END
$kind_constraint$;

-- 5. Writer boundary: the BEFORE INSERT fill trigger copies the catalogue or
--    binding type verbatim, which would violate the new CHECK on every writer
--    insert carrying a legacy value. Same function, same owner, same
--    search_path, body copied verbatim from 20261017120000 with ONLY the type
--    assignment wrapped in entity_kind_v1 (the trigger itself is unchanged).
--    CREATE OR REPLACE resets function ACLs, so the 20261017120000 REVOKE
--    PUBLIC is repeated.
CREATE OR REPLACE FUNCTION managed_knowledge_private.entity_fill_columns_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $fill$
DECLARE catalog record;
BEGIN
  IF NEW.catalog_entity_id IS NOT NULL THEN
    SELECT e.name,e.slug,e.type,e.aliases,e.summary,e.status,e.show_in_carousel,e.metadata,e.updated_at INTO catalog FROM public.entities e WHERE e.id = NEW.catalog_entity_id;
  ELSE
    -- A record that was never assigned cannot be dereferenced, so the unlinked
    -- path fills it from NULLs typed as the public.entities columns.
    SELECT NULL::text AS name,NULL::text AS slug,NULL::text AS type,NULL::jsonb AS aliases,
      NULL::text AS summary,NULL::text AS status,NULL::boolean AS show_in_carousel,
      NULL::jsonb AS metadata,NULL::timestamptz AS updated_at INTO catalog;
  END IF;
  IF NEW.name IS NULL THEN NEW.name := coalesce(catalog.name,NEW.binding->>'name'); END IF;
  -- Writers always send slug and type; a binding without them falls back to a
  -- slug derived from the name and the 'unclassified' kind instead of failing,
  -- and an empty derived slug (a non-ASCII name) becomes 'entity-'||id.
  IF NEW.slug IS NULL THEN
    NEW.slug := coalesce(catalog.slug,NEW.binding->>'slug',nullif(btrim(regexp_replace(lower(NEW.name),'[^a-z0-9]+','-','g'),'-'),''),'entity-' || replace(NEW.id::text,'-',''));
  END IF;
  IF NEW.type IS NULL THEN NEW.type := managed_knowledge_private.entity_kind_v1(coalesce(catalog.type,NEW.binding->>'type','unclassified')); END IF;
  IF NEW.aliases IS NULL THEN NEW.aliases := coalesce(catalog.aliases,nullif(NEW.binding->'aliases','null'::jsonb),'[]'::jsonb); END IF;
  IF NEW.summary IS NULL THEN NEW.summary := coalesce(catalog.summary,NEW.binding->>'summary'); END IF;
  IF NEW.status IS NULL THEN NEW.status := coalesce(catalog.status,NEW.binding->>'status','active'); END IF;
  IF NEW.show_in_carousel IS NULL THEN
    NEW.show_in_carousel := coalesce(catalog.show_in_carousel,CASE WHEN jsonb_typeof(NEW.binding->'show_in_carousel') = 'boolean'
      THEN (NEW.binding->>'show_in_carousel')::boolean ELSE false END);
  END IF;
  IF NEW.metadata IS NULL THEN
    NEW.metadata := coalesce(catalog.metadata,CASE WHEN jsonb_typeof(NEW.binding->'metadata') = 'object' THEN NEW.binding->'metadata' ELSE '{}'::jsonb END);
  END IF;
  IF NEW.updated_at IS NULL THEN NEW.updated_at := coalesce(catalog.updated_at,clock_timestamp()); END IF;
  RETURN NEW;
END
$fill$;
REVOKE ALL ON FUNCTION managed_knowledge_private.entity_fill_columns_v1() FROM PUBLIC;
-- No new trigger, and no new indexes (name_key and slug from #337 PR-A cover
-- the entity identity lookups; type is never probed by range/wildcard reads).