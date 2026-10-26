# @myboon/scout-news

Issue #444, scope narrowed by the CTO: scout only. Fetch the tokens.xyz news
feed ONCE, map each item to a V4 Signal, insert and enqueue in one
transaction. It does not consume the queue and runs no SQL migrations of its
own (the atlas schema and queue functions already exist; see
supabase/migrations/20261025100000_atlas_core.sql and
20261025100100_atlas_queues.sql).

What one run does (src/scout.ts, `runScoutOnce`):

1. Fetches the blended feed with `fetchFeed({ limit: 50 })` from
   `@myboon/shared/news-feed` (no new HTTP client; fetcher injectable).
2. Maps every item with `feedItemToSignal` (src/map.ts) and validates via
   `parseSignal`. Items that cannot become a valid signal are skipped and
   counted as `invalid`.
3. Inserts into `atlas.signals` and enqueues into `atlas.signal_queue`
   (max_attempts = 3) in ONE transaction, on a client from the pool
   (src/store.ts, `insertSignals`).

Dedupe is the database key `(source, source_id)`: the insert is
`on conflict do nothing returning signal_id`, and only a row that was
actually inserted is enqueued — a signal that is already present is NOT
re-enqueued. The mapping is stable: signal_id = sha256 over
"tokens_xyz\0url", source 'tokens_xyz', source_id/link = item.url,
type 'news' (article) / 'post' (post), text = title/text, excerpt = same
text truncated to 500 chars, occurred_at = publishedAt/postedAt (or null),
numbers {}, priority 0, raw_ids only for non-empty members
(coingecko: comma-joined relatedCoinIds, plus outlet/handle when present),
raw_hash = sha256 of the upstream JSON.

src/queue.ts holds thin typed wrappers for whoever consumes the queue
(claim / heartbeat / complete / fail around the atlas.queue_* functions). It
runs no queue SQL of its own, defines nothing in the database, and exposes
the used SQL strings plus CLAIM_LIMIT (10), LEASE ('5 minutes') and
HEARTBEAT_MS (60000) as constants.

## Env vars

Names only (values are never logged):

- `DATABASE_URL` — Postgres connection string used by `pnpm run scout:once`
- `TOKENS_API_KEY` — tokens.xyz API key, required by `fetchFeed` in
  @myboon/shared (an unauthenticated call is refused there rather than
  mistaken for an empty feed)
- `NEWS_FEED_API_BASE` / `TOKENS_API_BASE` — optional upstream base override,
  handled inside @myboon/shared
- `SCOUT_TEST_DATABASE_URL` — database for src/scout.db.test.ts (integration
  tests are skipped when it is unset)

## SQL executed by one run

In one transaction, per signal (parameterized; constants in src/store.ts):

```sql
-- SQL_INSERT_SIGNAL (dedupe key (source, source_id); 15 parameters)
insert into atlas.signals
  (signal_id, schema_version, source, source_id, type, priority, occurred_at,
   fetched_at, text, numbers, link, raw_ids, unusual_score, excerpt, raw_hash)
values ($1, ..., $15)
on conflict (source, source_id) do nothing
returning signal_id;

-- SQL_ENQUEUE_SIGNAL, ONLY when the insert above returned a row
insert into atlas.signal_queue (signal_id, priority, max_attempts)
values ($1, $2, 3)
on conflict (signal_id) do nothing;
```

The transaction sets `statement_timeout = '10s'` and `lock_timeout = '2s'`,
commits, and rolls back entirely on error.

## Run

```sh
DATABASE_URL=... pnpm --filter @myboon/scout-news scout:once
```

Exits non-zero when the fetch, mapping storage or transaction fails; DATABASE_URL
is never printed.

## Tests

```sh
pnpm --filter @myboon/scout-news typecheck
pnpm --filter @myboon/scout-news test
# integration tests run only with a disposable atlas database:
SCOUT_TEST_DATABASE_URL=postgresql://... pnpm --filter @myboon/scout-news test
```

src/map.test.ts covers the mapping (article and post fixtures, excerpt
truncation, signal_id stability). src/scout.db.test.ts covers duplicate
handling, lease retake and dead-lettering against a real database and
truncates atlas.signal_queue, atlas.dead_letter and atlas.signals (cascade)
before every test — point it at a disposable database only.