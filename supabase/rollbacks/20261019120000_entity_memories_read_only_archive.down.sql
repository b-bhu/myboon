-- Rollback for 20261019120000_entity_memories_read_only_archive.sql (#337 final step).
-- Restores public.entity_memories as a writable table with the exact
-- pre-migration grants (this migration only added triggers, one function and
-- REVOKEs, so GRANTs here restore those grants verbatim).
--
-- Exact revert steps:
--   1. to also revert the read-source switch, set ENTITY_V4_READ_SOURCE back to
--      'dual' for myboon-api, myboon-editor-draft and myboon-publisher in
--      ecosystem.config.cjs (or revert the PR), then reload those three apps:
--      pm2 reload myboon-api myboon-editor-draft myboon-publisher --update-env
--   2. run this file with --single-transaction
--
-- Idempotent: re-running is a no-op (DROP IF EXISTS; GRANTs are additive).

DROP TRIGGER IF EXISTS entity_memories_archive_read_only ON public.entity_memories;
DROP TRIGGER IF EXISTS entity_memories_archive_no_truncate ON public.entity_memories;
DROP FUNCTION IF EXISTS public.entity_memories_archive_read_only_v1();
GRANT INSERT, DELETE, TRUNCATE ON public.entity_memories TO anon, authenticated, service_role;
GRANT UPDATE ON public.entity_memories TO anon, authenticated;