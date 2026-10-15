-- Not applied. Apply only after Bucket's explicit yes on #318.
-- Kept outside supabase/migrations so `supabase db push` never runs it as a forward migration. Run manually only for rollback.
drop table if exists public.token_registry;
drop function if exists public.token_source_rank(text);
