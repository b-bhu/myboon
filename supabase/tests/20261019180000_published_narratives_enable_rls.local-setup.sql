-- LOCAL-ONLY fixture setup for #365 (never run against prod).
-- Builds the roles, the public.published_narratives table with prod's current
-- grants and three fixture rows on a throwaway Postgres so the local
-- assertions can prove the RLS behaviour. Standalone on purpose: the driver
-- runs the migration 20261019180000_published_narratives_enable_rls.sql
-- between the first (expected-failing) and second assertion runs.

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END
$roles$;

CREATE TABLE IF NOT EXISTS public.published_narratives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_small text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Mirrors prod's current grants before this migration: full table privileges
-- for anon, authenticated and service_role while RLS is still off.
GRANT ALL PRIVILEGES ON TABLE public.published_narratives
  TO anon, authenticated, service_role;

-- Three fixture rows to prove RLS hides them from anon/authenticated;
-- guarded so a rerun keeps the fixture at exactly three rows.
INSERT INTO public.published_narratives (content_small)
SELECT 'local fixture row ' || n || '/3'
FROM generate_series(1, 3) AS n
WHERE NOT EXISTS (SELECT 1 FROM public.published_narratives);
