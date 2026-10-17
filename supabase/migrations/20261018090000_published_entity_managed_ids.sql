-- #337 PR-D: published rows may reference managed-only entity ids.
-- NOT APPLIED. Needs Bucket's explicit yes (needs-bucket).
--
-- Rollback: supabase/rollbacks/20261018090000_published_entity_managed_ids.down.sql.
-- Depends on 20261017120000 (managed entity columns) and 20261017210000
-- (managed knowledge reader + owner/access pattern copied below).
--
-- One entity id space: catalogue-linked managed entities have
-- id = catalog_entity_id = public.entities.id, article-only managed entities
-- an id absent from public.entities; an entity_id is valid iff it exists in either store.

DO $access$
BEGIN
  PERFORM set_config('myboon.migration_had_owner_set',pg_has_role(current_user,'myboon_knowledge_owner','SET')::text,true);
  PERFORM set_config('myboon.migration_had_owner_public_create',has_schema_privilege('myboon_knowledge_owner','public','CREATE')::text,true);
  IF NOT pg_has_role(current_user,'myboon_knowledge_owner','SET') THEN
    EXECUTE format('GRANT myboon_knowledge_owner TO %I WITH INHERIT FALSE, SET TRUE',current_user);
  END IF;
END
$access$;
GRANT CREATE ON SCHEMA public TO myboon_knowledge_owner;
SET LOCAL ROLE myboon_knowledge_owner;

CREATE OR REPLACE FUNCTION public.read_managed_entities_v1(p_entity_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $entities$
DECLARE
  result_rows jsonb;
BEGIN
  IF p_entity_ids IS NULL OR pg_catalog.cardinality(p_entity_ids) = 0 OR pg_catalog.cardinality(p_entity_ids) > 100 THEN
    RAISE EXCEPTION 'managed entity lookup requires between 1 and 100 entity ids' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id',entity.id,'slug',entity.slug,'name',entity.name,'type',entity.type,'aliases',entity.aliases,
    'summary',entity.summary,'status',entity.status,'show_in_carousel',entity.show_in_carousel,
    'metadata',entity.metadata,'created_at',entity.created_at,'updated_at',entity.updated_at,
    'catalog_entity_id',entity.catalog_entity_id
  ) ORDER BY entity.id), '[]'::jsonb)
  INTO result_rows
  FROM managed_knowledge_private.entities AS entity
  WHERE entity.id = ANY(p_entity_ids);
  RETURN result_rows;
END
$entities$;

COMMENT ON FUNCTION public.read_managed_entities_v1(uuid[])
  IS '#337 PR-D: read-only managed entity rows in the single id space for the editor-draft/publisher entity existence checks. service_role only.';
REVOKE ALL ON FUNCTION public.read_managed_entities_v1(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_managed_entities_v1(uuid[]) TO service_role;

RESET ROLE;
DO $restore$
BEGIN
  IF current_setting('myboon.migration_had_owner_public_create')='false' THEN
    REVOKE CREATE ON SCHEMA public FROM myboon_knowledge_owner;
  END IF;
  IF current_setting('myboon.migration_had_owner_set')='false' THEN
    EXECUTE format('REVOKE SET OPTION FOR myboon_knowledge_owner FROM %I',current_user);
  END IF;
END
$restore$;

-- Drop every single-column FK from the two published tables to public.entities
-- on entity_id, whatever its name, so the article-only managed ids below are
-- kept. Existence is checked by the publisher across both stores instead.
DO $drop_fks$
DECLARE
  fk record;
BEGIN
  FOR fk IN
    SELECT c.conrelid, c.conname
    FROM pg_catalog.pg_constraint c
    WHERE c.contype = 'f'
      AND c.confrelid = 'public.entities'::regclass
      AND c.conrelid IN ('public.published_narratives'::regclass, 'public.entity_published_history'::regclass)
      AND c.conkey = ARRAY[(
        SELECT a.attnum::smallint
        FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = c.conrelid AND a.attname = 'entity_id'
      )]::smallint[]
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.conrelid::regclass, fk.conname);
  END LOOP;
END
$drop_fks$;

COMMENT ON COLUMN public.published_narratives.entity_id
  IS 'Entity id in the single catalogue/managed id space; existence is checked by the publisher (no FK since #337 PR-D).';
COMMENT ON COLUMN public.entity_published_history.entity_id
  IS 'Entity id in the single catalogue/managed id space; existence is checked by the publisher (no FK since #337 PR-D).';