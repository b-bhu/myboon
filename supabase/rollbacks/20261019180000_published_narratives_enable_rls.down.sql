-- WARNING: this reopens the anon/authenticated read/write hole on public.published_narratives; emergency use only.
ALTER TABLE public.published_narratives DISABLE ROW LEVEL SECURITY;
