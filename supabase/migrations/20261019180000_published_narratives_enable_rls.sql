-- #365: enable RLS on public.published_narratives (server-only). Prod had RLS
-- off with anon/authenticated holding full table grants; the service role
-- (BYPASSRLS) used by packages/api and collectors is unaffected. No policies
-- on purpose (CTO decision Oct 17); 20260714153008_secure_published_narratives.sql
-- is in the repo but was never applied to prod.
-- RLS does not apply to TRUNCATE/REFERENCES/TRIGGER, so those grants are revoked.

ALTER TABLE public.published_narratives ENABLE ROW LEVEL SECURITY;

REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.published_narratives FROM anon, authenticated;
