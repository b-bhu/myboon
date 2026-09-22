CREATE OR REPLACE FUNCTION public.entity_redirect_single_hop_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(61301, 1);

  IF EXISTS (
    SELECT 1 FROM public.entity_redirects AS redirect
    WHERE redirect.target_entity_id = NEW.source_entity_id
  ) THEN
    RAISE EXCEPTION 'redirect source already has an incoming redirect';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.entity_redirects AS redirect
    WHERE redirect.source_entity_id = NEW.target_entity_id
  ) THEN
    RAISE EXCEPTION 'redirect target already has an outgoing redirect';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS entity_redirect_single_hop_guard
  ON public.entity_redirects;
CREATE TRIGGER entity_redirect_single_hop_guard
BEFORE INSERT OR UPDATE OF source_entity_id, target_entity_id
ON public.entity_redirects
FOR EACH ROW
EXECUTE FUNCTION public.entity_redirect_single_hop_guard_v1();

-- A writer and a merge synchronize on the same Entity row. If the writer gets
-- the key-share lock first, the merge waits and includes the new dependency in
-- its manifest. If the merge wins, the writer wakes after archival and gets a
-- retryable failure instead of attaching fresh data to an archived Entity.
REVOKE ALL ON FUNCTION public.entity_redirect_single_hop_guard_v1()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.entity_redirect_single_hop_guard_v1()
  TO service_role;

COMMENT ON FUNCTION public.entity_redirect_single_hop_guard_v1() IS
  'Serializes redirect writes and rejects chains so runtime resolution stays one hop.';
