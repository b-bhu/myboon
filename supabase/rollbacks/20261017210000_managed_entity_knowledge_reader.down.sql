-- Rollback for 20261017210000_managed_entity_knowledge_reader.sql (#337 PR-C).
-- Set ENTITY_V4_READ_SOURCE=legacy (or unset it) on every reader first; the
-- dual reader falls back to legacy on its own, the managed reader does not.
DROP FUNCTION IF EXISTS public.read_managed_entity_knowledge_v1(text,uuid,uuid[],timestamptz,text[],text[],timestamptz,uuid,integer);
