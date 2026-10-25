# Rollbacks

One rollback per migration lives here, never in `supabase/migrations/`:

    supabase/migrations/<version>_<name>.sql      # applied by `supabase db push`
    supabase/rollbacks/<version>_<name>.down.sql  # applied by hand, only with approval

The Supabase CLI treats every `.sql` file in `migrations/` as a migration and keys it by the
version prefix, so a `.down.sql` beside its migration reads as a duplicate version and breaks
`db push`. Each migration's pg-test / acceptance script proves up -> down -> up on a throwaway
local Postgres before the migration ships.
