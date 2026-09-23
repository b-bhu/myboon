-- Alias meaning is contextual. Scheduled model output may report pollution,
-- but only the explicit, approval-gated operator function may remove aliases.
DROP FUNCTION IF EXISTS public.entity_catalog_apply_eligible_alias_v1(uuid, text);
