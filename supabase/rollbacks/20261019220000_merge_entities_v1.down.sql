-- Rollback for 20261019220000_merge_entities_v1.sql (#342 PR-3).
-- Drops the merge function and removes only the grants/policies the migration
-- added: the two owner RLS policies on the published tables, the owner's
-- column grants on the published tables and entity_memories-adjacent extras,
-- and the guard-helper EXECUTE for the owner. Grants earlier migrations made
-- are preserved - notably entities UPDATE(revision) (20261017180000) and
-- UPDATE(updated_at) (20261018090000), the owner's entity_memories read
-- (20261004103000) and every service_role grant. No data is touched.

-- The policies and the public-table grants go first, as the migration role
-- (which owns the published tables). DROP POLICY IF EXISTS keeps the rollback
-- re-runnable both ways.
DROP POLICY IF EXISTS merge_entities_owner_read ON public.published_narratives;
DROP POLICY IF EXISTS merge_entities_owner_repoint ON public.published_narratives;
DROP POLICY IF EXISTS merge_entities_owner_read ON public.entity_published_history;
DROP POLICY IF EXISTS merge_entities_owner_repoint ON public.entity_published_history;
-- entity_memories: the migration added the guard's row-lock aid (an UPDATE
-- policy whose USING only feeds FOR SHARE checks, plus one inert column
-- grant); the owner's SELECT (id, entity_id) from 20261004103000 stays.
DROP POLICY IF EXISTS merge_entities_owner_memory_lock ON public.entity_memories;
REVOKE UPDATE (updated_at) ON public.entity_memories FROM myboon_knowledge_owner;
REVOKE SELECT (id, entity_id, source_memory_ids), UPDATE (entity_id, entity_slug, entity_name)
  ON public.published_narratives FROM myboon_knowledge_owner;
REVOKE SELECT (id, entity_id, published_narrative_id), UPDATE (entity_id, entity_slug)
  ON public.entity_published_history FROM myboon_knowledge_owner;
-- entities' aliases/status/metadata were granted here; revision/updated_at stay
-- because earlier migrations granted them.
REVOKE UPDATE (aliases, status, metadata) ON managed_knowledge_private.entities FROM myboon_knowledge_owner;
DO $guard_grants$
DECLARE
  helper record;
BEGIN
  FOR helper IN SELECT * FROM (VALUES
    ('public.managed_active_memory_ids_v1(uuid[],boolean)'),
    ('public.managed_entity_lock_status_v1(uuid)'),
    ('public.managed_owned_memory_ids_v1(uuid[],uuid,boolean)'),
    ('public.entity_publication_relationship_guard_v1()')
  ) AS t(signature) LOOP
    IF to_regprocedure(helper.signature) IS NOT NULL THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM myboon_knowledge_owner', helper.signature);
    END IF;
  END LOOP;
END
$guard_grants$;

DO $access$
BEGIN
  PERFORM set_config('myboon.rollback_had_owner_set',pg_has_role(current_user,'myboon_knowledge_owner','SET')::text,true);
  PERFORM set_config('myboon.rollback_had_owner_create',has_schema_privilege('myboon_knowledge_owner','managed_knowledge_private','CREATE')::text,true);
  IF NOT pg_has_role(current_user,'myboon_knowledge_owner','SET') THEN
    EXECUTE format('GRANT myboon_knowledge_owner TO %I WITH INHERIT FALSE, SET TRUE',current_user);
  END IF;
END
$access$;
GRANT CREATE ON SCHEMA managed_knowledge_private TO myboon_knowledge_owner;
SET LOCAL ROLE myboon_knowledge_owner;
-- The merge function is owned by myboon_knowledge_owner, so the drop runs as
-- the owner.
DROP FUNCTION IF EXISTS managed_knowledge_private.merge_entities_v1(uuid, uuid, boolean);
RESET ROLE;
DO $restore$
BEGIN
  IF current_setting('myboon.rollback_had_owner_create')='false' THEN
    REVOKE CREATE ON SCHEMA managed_knowledge_private FROM myboon_knowledge_owner;
  END IF;
  IF current_setting('myboon.rollback_had_owner_set')='false' THEN
    EXECUTE format('REVOKE SET OPTION FOR myboon_knowledge_owner FROM %I',current_user);
  END IF;
END
$restore$;