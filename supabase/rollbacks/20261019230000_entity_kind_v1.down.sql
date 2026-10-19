-- Rollback for 20261019230000_entity_kind_v1.sql (#342 PR-4).
-- Restores the pre-#342-PR-4 state: the kind CHECK is dropped, every stored
-- type is restored from metadata.legacyType (the exact value the migration
-- replaced) and that key is removed, the 20261017120000 fill trigger body is
-- restored byte-for-byte, and entity_kind_v1 is dropped. No grants or policies
-- are touched - the kind function only ever granted EXECUTE to roles that
-- entity_name_key_v1 already grants.
-- Order matters: the CHECK goes first so the restored legacy types do not
-- violate it.

-- 1. Constraint first.
ALTER TABLE managed_knowledge_private.entities
  DROP CONSTRAINT IF EXISTS managed_entities_type_kind_v1;

-- 2. Writer boundary back to the verbatim 20261017120000 body (the pg-test
--    compares md5 of prosrc against the pre-migration body). CREATE OR REPLACE
--    resets function ACLs, so the 20261017120000 REVOKE PUBLIC is repeated.
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
  IF NEW.type IS NULL THEN NEW.type := coalesce(catalog.type,NEW.binding->>'type','unclassified'); END IF;
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

-- 3. Restore type from metadata.legacyType, then remove the key. Rows without
--    the key (kinds from birth, e.g. 'organization') are untouched. A key that
--    cannot restore a text type (json null or an empty string) is left in
--    place rather than nulling a NOT NULL column.
UPDATE managed_knowledge_private.entities
SET type = coalesce(nullif(metadata->>'legacyType',''), type)
WHERE metadata ? 'legacyType';
UPDATE managed_knowledge_private.entities
SET metadata = metadata - 'legacyType'
WHERE metadata ? 'legacyType'
  AND metadata->>'legacyType' IS NOT NULL
  AND metadata->>'legacyType' <> '';

-- 4. Drop the kind function last.
DROP FUNCTION IF EXISTS managed_knowledge_private.entity_kind_v1(text);