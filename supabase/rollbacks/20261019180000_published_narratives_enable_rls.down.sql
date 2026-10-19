-- WARNING: this reopens the anon/authenticated read/write hole on public.published_narratives; emergency use only.
GRANT TRUNCATE, REFERENCES, TRIGGER ON TABLE public.published_narratives TO anon, authenticated;
ALTER TABLE public.published_narratives DISABLE ROW LEVEL SECURITY;
