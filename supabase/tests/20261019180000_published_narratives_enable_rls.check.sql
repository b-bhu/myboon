-- Read-only post-migration check for 20261019180000_published_narratives_enable_rls.sql (#365).
-- Only SELECTs on pg_catalog plus count(*) row probes; the role switch runs
-- inside a transaction that is rolled back. Every row should be pass = true.
SELECT check_name, pass FROM (VALUES
  ('01 public.published_narratives has relrowsecurity = true', 1, (
     SELECT relrowsecurity FROM pg_catalog.pg_class
     WHERE oid = 'public.published_narratives'::regclass)),
  ('02 zero policies on public.published_narratives (server-only)', 2, NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid = 'public.published_narratives'::regclass)),
  ('03 role service_role exists with rolbypassrls = true', 3, EXISTS (
     SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'service_role' AND rolbypassrls)),
  ('04 service_role holds SELECT, INSERT and UPDATE on the table', 4,
     has_table_privilege('service_role', 'public.published_narratives', 'SELECT')
     AND has_table_privilege('service_role', 'public.published_narratives', 'INSERT')
     AND has_table_privilege('service_role', 'public.published_narratives', 'UPDATE'))
) AS c(check_name, ord, pass)
ORDER BY ord;

-- Proves anon and authenticated see no rows through the policy-free RLS.
-- Only SELECTs; the role switch is inside a transaction that is rolled back.
BEGIN;
SET LOCAL ROLE anon;
SELECT 'anon visible rows' AS check_name, count(*) AS visible_rows, count(*) = 0 AS pass
  FROM public.published_narratives;
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT 'authenticated visible rows' AS check_name, count(*) AS visible_rows, count(*) = 0 AS pass
  FROM public.published_narratives;
RESET ROLE;
ROLLBACK;
