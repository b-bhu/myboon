-- #337 final step: public.entity_memories becomes a read-only archive.
-- NOT APPLIED. Needs Bucket's explicit yes (needs-bucket). Apply only after a
-- real V4 draft + publish has been observed.
--
-- Rollback: supabase/rollbacks/20261019120000_entity_memories_read_only_archive.down.sql.
-- Run with --single-transaction; re-running is a no-op.
--
-- Writes are blocked by triggers, not by revoking every privilege from
-- service_role: entity_publication_relationship_guard_v1 (20261018090000) is
-- SECURITY INVOKER and runs as service_role (the publisher) doing
-- SELECT ... FROM public.entity_memories ... FOR SHARE, and FOR SHARE requires
-- UPDATE privilege, so service_role keeps SELECT+UPDATE; actual UPDATEs are
-- blocked by the row trigger below.
--
-- Existing triggers entity_memories_compat_identity_v1,
-- entity_memories_active_entity_guard and
-- entity_memories_canonical_scope_guard are left untouched.

CREATE OR REPLACE FUNCTION public.entity_memories_archive_read_only_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $read_only$
BEGIN
  RAISE EXCEPTION 'public.entity_memories is a read-only archive (#337): % rejected', TG_OP
    USING ERRCODE = '42501';
END
$read_only$;

COMMENT ON FUNCTION public.entity_memories_archive_read_only_v1()
  IS '#337 final step: rejects every INSERT/UPDATE/DELETE/TRUNCATE on public.entity_memories; the archive allows reads and FOR SHARE row locks only.';
REVOKE ALL ON FUNCTION public.entity_memories_archive_read_only_v1() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS entity_memories_archive_read_only ON public.entity_memories;
CREATE TRIGGER entity_memories_archive_read_only
  BEFORE INSERT OR UPDATE OR DELETE
  ON public.entity_memories
  FOR EACH ROW
  EXECUTE FUNCTION public.entity_memories_archive_read_only_v1();
COMMENT ON TRIGGER entity_memories_archive_read_only ON public.entity_memories
  IS '#337 final step: every row write on the entity_memories archive raises 42501.';

DROP TRIGGER IF EXISTS entity_memories_archive_no_truncate ON public.entity_memories;
CREATE TRIGGER entity_memories_archive_no_truncate
  BEFORE TRUNCATE
  ON public.entity_memories
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.entity_memories_archive_read_only_v1();
COMMENT ON TRIGGER entity_memories_archive_no_truncate ON public.entity_memories
  IS '#337 final step: TRUNCATE on the entity_memories archive raises 42501.';

-- service_role keeps SELECT (archive reads) and UPDATE solely for the FOR SHARE
-- row locks the publication relationship guard takes; the row trigger blocks
-- the writes those privileges could otherwise perform.
REVOKE INSERT, DELETE, TRUNCATE ON public.entity_memories FROM anon, authenticated, service_role;
REVOKE UPDATE ON public.entity_memories FROM anon, authenticated;