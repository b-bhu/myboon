-- A catalogue audit is globally exclusive regardless of whether it is a full
-- or incremental run. Create the stricter index before dropping the old one:
-- PostgreSQL blocks conflicting writes while building a non-concurrent unique
-- index, and any pre-existing or racing conflict makes the migration fail
-- closed without opening an unprotected claim window.

DO $$
BEGIN
  IF (
    SELECT count(*)
    FROM public.entity_catalog_maintenance_runs
    WHERE status = 'running'
  ) > 1 THEN
    RAISE EXCEPTION 'cannot install global Entity catalogue lease while multiple runs are active';
  END IF;
END;
$$;

CREATE UNIQUE INDEX entity_catalog_maintenance_one_running_global_idx
  ON public.entity_catalog_maintenance_runs ((1))
  WHERE status = 'running';

DROP INDEX IF EXISTS public.entity_catalog_maintenance_one_running_scope_idx;

COMMENT ON INDEX public.entity_catalog_maintenance_one_running_global_idx IS
  'Allows at most one running Entity catalogue maintenance job across all scopes.';
