# @myboon/scout-news

Issue #444, scope narrowed by the CTO: scout only. Fetch the tokens.xyz news
feed ONCE, map each item to a V4 Signal, insert through the Supabase client
(service_role). The insert IS the handoff to the analyst (#478): the migration
supabase/migrations/20261027120000_atlas_signal_status.sql gives every new row
status 'received', attempts 0 and next_attempt_at now(), so a committed signal
is immediately claimable. The package runs no SQL migrations of its own (the
atlas schema is created by supabase/migrations/20261025100000_atlas_core.sql).

What one run does (src/scout.ts, `runScoutOnce`):

1. Fetches the blended feed with `fetchFeed({ limit: 50 })` from
   @myboon/shared/news-feed (no new HTTP client; fetcher injectable).
2. Maps every item with `feedItemToSignal` (src/map.ts) and validates via
   `parseSignal`. Items that cannot become a valid signal are skipped and
   counted as `invalid`.
3. Inserts into `atlas.signals` through the Supabase client (src/store.ts,
   `insertSignals`). There is no queue row, no enqueued_at stamp and no
   sweep (the sweep and queue wrappers went away with atlas.signal_queue
   in #478).

## What one run calls (src/store.ts)

One PostgREST call: `db.schema('atlas').from('signals')`
`.upsert(<all signal fields>, { onConflict: 'source,source_id',
ignoreDuplicates: true }).select('signal_id')`. The read-back selects ONLY
signal_id — of the columns service_role may read (signal_id, source,
source_id, created_at) it needs nothing else — so the returned ids are
exactly the rows this call inserted: a signal that is already present yields
no id and is never re-handed-off, so a completed signal survives later
re-runs untouched.

Because one statement inserts and hands off atomically, a failed run heals
itself: the failing insert commits nothing, and the next run's upsert lands
the missing signals normally. Nothing stays stranded half-written.

An error throws `scout-news: signal insert failed: <PostgREST message>`
(never a URL or key).

Dedupe: the batch is deduped in memory on the database key
`(source, source_id)` first (keeping the first; Postgres rejects one upsert
statement that hits the same key twice), and those in-batch repeats count as
`duplicates`, as do the rows PostgREST skipped on conflict.

The mapping is stable: signal_id = sha256 over "tokens_xyz\0url",
source 'tokens_xyz', source_id/link = item.url, type 'news' (article) /
'post' (post), text = title/text, excerpt = same text truncated to 500 chars,
occurred_at = publishedAt/postedAt (or null), numbers {}, priority 0,
raw_ids only for non-empty members (coingecko: comma-joined relatedCoinIds,
plus outlet/handle when present), raw_hash = sha256 of the upstream JSON.

## Downstream

Consumers read atlas.signals directly — signal status, claim columns and the
decision log live there since #478 (`atlas.signal_claim` /
`signal_finish` / `signal_fail`); nothing in this package calls them.

## Env vars

Names only (values are never logged):

- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` — required by
  `pnpm run scout:once` (checked by `requireSupabaseEnv` from
  @myboon/shared/supabase-client, which also builds a timeout-bounded client)
- `TOKENS_API_KEY` — tokens.xyz API key, required by `fetchFeed` in
  @myboon/shared (an unauthenticated call is refused there rather than
  mistaken for an empty feed)
- `NEWS_FEED_API_BASE` / `TOKENS_API_BASE` — optional upstream base override,
  handled inside @myboon/shared
- `SCOUT_TEST_DATABASE_URL` — Postgres for src/scout.db.test.ts (integration
  tests are skipped when it is unset)

## Run

```sh
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... pnpm --filter @myboon/scout-news scout:once
```

Exits non-zero when the env check, the fetch, the mapping store or the insert
fails; it logs one JSON line with the run's counts and nothing else — never a
URL or key.

## Tests

```sh
pnpm --filter @myboon/scout-news typecheck
pnpm --filter @myboon/scout-news test
# DB-side tests run only with a disposable atlas database:
SCOUT_TEST_DATABASE_URL=postgresql://... pnpm --filter @myboon/scout-news test
```

src/map.test.ts covers the mapping (article and post fixtures, excerpt
truncation, signal_id stability). src/store.test.ts covers the exact
PostgREST call and the dedupe bookkeeping against a fake; src/scout.test.ts
covers the run order (fetch, then store) and its counts. PostgREST is not run
locally, so src/scout.db.test.ts verifies the DB-side behavior the Supabase
call relies on — `insert ... on conflict (source, source_id) do nothing
returning signal_id` — with `pg` (test-only dependency) against a real
database, plus the handoff contract: the inserted signal is received,
unclaimed and due, enqueued_at is gone, signal_queue is gone and
`atlas.queue_claim('signal_queue', ...)` raises `unknown queue`. It
truncates atlas.signals (cascade) before every test — point it at a
disposable database only.