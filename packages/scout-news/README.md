# @myboon/scout-news

Issue #444, scope narrowed by the CTO: scout only. Fetch the tokens.xyz news
feed ONCE, map each item to a V4 Signal, insert and enqueue through the
Supabase client (service_role). It does not consume the queue and runs no SQL
migrations of its own (the atlas schema and queue functions already exist;
see supabase/migrations/20261025100000_atlas_core.sql and
20261025100100_atlas_queues.sql; the `atlas.signals.enqueued_at` column is
added on the live databases separately).

What one run does (src/scout.ts, `runScoutOnce`):

1. Sweeps for stranded signals first with `sweepUnqueued` (src/store.ts) —
   a repair pass for a previous run that crashed mid-write; reported as the
   `swept` count. See "Crash recovery" below.
2. Fetches the blended feed with `fetchFeed({ limit: 50 })` from
   @myboon/shared/news-feed (no new HTTP client; fetcher injectable).
3. Maps every item with `feedItemToSignal` (src/map.ts) and validates via
   `parseSignal`. Items that cannot become a valid signal are skipped and
   counted as `invalid`.
4. Inserts into `atlas.signals`, enqueues into `atlas.signal_queue`
   (max_attempts = 3) and stamps `enqueued_at` through the Supabase client
   (src/store.ts, `insertSignals`) over the PostgREST calls described below.

## What one run calls (src/store.ts)

supabase-js has no transaction API, so the write is three PostgREST calls,
not one transaction:

1. `db.schema('atlas').from('signals').upsert(<all signal fields>,
   { onConflict: 'source,source_id', ignoreDuplicates: true }).select('signal_id')`.
   The read-back selects ONLY signal_id — of the columns service_role may
   read (signal_id, source, source_id, created_at, enqueued_at) it needs
   nothing else — so the returned ids are exactly the rows this call
   inserted: a signal that is already present yields no id and is NOT
   re-enqueued, so a completed signal survives later re-runs untouched.
2. `db.schema('atlas').from('signal_queue').upsert(<one row per returned
   signal_id: signal_id, priority, max_attempts 3>, { onConflict: 'signal_id',
   ignoreDuplicates: true })` — enqueued rows retry twice before
   dead-lettering.
3. `db.schema('atlas').from('signals').update({ enqueued_at: <iso> })
   .in('signal_id', <ids from call 1>)` with no read-back — the stamp marks
   the signals call 2 enqueued; the sweep reads exactly this marker (see
   below). service_role may update only `enqueued_at` on atlas.signals, and
   these calls touch nothing else.

An error from any call throws `scout-news: <step> failed: <PostgREST
message>` (never a URL or key).

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

## Crash recovery: the sweep (src/store.ts, `sweepUnqueued`)

The three calls above are not a transaction, so a run that dies (or errors)
between them can leave a signal inserted but unstamped: after call 1 without
an enqueue, or after call 2 without the stamp. Every run therefore opens with
the sweep before anything else:

1. Select: `from('signals').select('signal_id').is('enqueued_at', null)
   .gt('created_at', <now minus 24h, ISO>).limit(500)` — only recent rows
   still missing the stamp. A finished signal has no queue row left but keeps
   its enqueued_at, so it is never selected again; the 24h lookback and the
   limit keep the repair query bounded.
2. Re-enqueue: `from('signal_queue').upsert(<signal_id, priority 0,
   max_attempts 3>, { onConflict: 'signal_id', ignoreDuplicates: true })` —
   do-nothing for a signal whose original queue row survived (its enqueue
   landed; only the stamp was missed), so nothing is double-leased.
3. Stamp: the same `update ... .in('signal_id', ids)` as call 3, so the next
   sweep stops seeing the row.

The queue upsert being ignoreDuplicates is what makes the sweep safe to run
repeatedly: its worst case (a stamp failing) leaves the row unstamped with
its queue row present, and the next run re-runs the same upsert (a no-op) and
stamps again. Errors throw with the failing step name — `sweep select`,
`sweep enqueue` or `sweep stamp` — and the next run simply retries.

src/queue.ts holds thin typed wrappers for whoever consumes the queue:
claim / heartbeat / complete / fail, each one
`db.schema('atlas').rpc('queue_*', ...)` call around the atlas.queue_*
functions. It defines nothing in the database and exposes CLAIM_LIMIT (10),
LEASE ('5 minutes') and HEARTBEAT_MS (60000) as constants.

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

Exits non-zero when the env check, the sweep, the fetch, the mapping store or
the enqueue fails; it logs one JSON line with the run's counts (including
`swept`) and nothing else — never a URL or key.

## Tests

```sh
pnpm --filter @myboon/scout-news typecheck
pnpm --filter @myboon/scout-news test
# DB-side tests run only with a disposable atlas database:
SCOUT_TEST_DATABASE_URL=postgresql://... pnpm --filter @myboon/scout-news test
```

src/map.test.ts covers the mapping (article and post fixtures, excerpt
truncation, signal_id stability). src/store.test.ts and src/queue.test.ts
cover the exact PostgREST calls, the dedupe/enqueue bookkeeping, the
enqueued_at stamp and the sweep (filters, re-enqueue, stamp, error paths)
against fakes; src/scout.test.ts covers the run order (sweep, then fetch,
then store) and its counts. PostgREST is not run locally, so
src/scout.db.test.ts verifies the DB-side behavior those Supabase calls rely
on — `insert ... on conflict (source, source_id) do nothing returning
signal_id`, the max_attempts 3 enqueue, the atlas.queue_* functions and the
sweep's SQL filters (a recent unstamped row is found; a stamped row is not) —
with `pg` (test-only dependency) against a real database. Its setup adds
`atlas.signals.enqueued_at` (timestamptz) to the test database if missing —
that ALTER is test-only. It covers duplicate handling, lease retake and
dead-lettering, and truncates atlas.signal_queue, atlas.dead_letter and
atlas.signals (cascade) before every test — point it at a disposable
database only.