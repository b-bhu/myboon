# @myboon/web-reader — web reader worker (#582)

One gated background run that fills readable article bodies into the planned
`atlas.signals` columns (`body`, `body_status` = `ok`/`unavailable`/`failed`,
`body_fetched_at`) for linked `tokens_xyz` news signals. Runs one pass and
exits; PM2 starts it again on the next tick (`cron_restart */15 * * * *`).

**Ships switched off.** `WEB_READER_ENABLED` defaults to `false` and the app is
only registered under `MYBOON_V4_RUNTIME_ENABLED=1` — same pattern as
`myboon-scout` / `myboon-analyst` in `ecosystem.config.cjs`. Do not turn it on
in prod until Bucket says so.

## What one run does

1. Gate off (`WEB_READER_ENABLED != "true"`) → exit 0 before any DB or network.
2. Select up to `WEB_READER_MAX_PER_RUN` (default 50) signals — newest
   `fetched_at` first, `type='news' AND source='tokens_xyz' AND link IS NOT
   NULL AND (body_status IS NULL OR body_status='pending')`,
   `FOR UPDATE SKIP LOCKED`, no claim RPC (PM2 `cron_restart` prevents overlap).
3. Split into batches of `WEB_READER_BATCH_SIZE` (10), at most
   `WEB_READER_MAX_PARALLEL_BATCHES` (5) concurrent; last batch takes the
   remainder (45 → 10/10/10/10/5).
4. Per signal, best effort (one failure never aborts the run):
   - paywalled host (`reuters.com`, `bloomberg.com`, `wsj.com`, `ft.com`) →
     `unavailable` immediately, no fetch, no Hermes;
   - plain HTTP GET (15 s per hop, capped redirects/bytes) → `readableArticle`
     extraction → overlap guard vs the signal title → `ok` (body trimmed to
     4000 chars) when it passes;
   - otherwise a **headless Hermes oneshot** (`hermes --ignore-rules --provider
     ollama-cloud -m <model> -z <prompt>`, no `-t` browser toolset, no chat)
     with a strict body-only prompt that must return `BODY_UNAVAILABLE` or the
     article body; a body with no overlap vs the title or the plain extract is
     dropped as a likely hallucination;
   - `BODY_UNAVAILABLE`/empty → `unavailable`; hard errors (timeout, crash) →
     `failed`.
5. Rows that are already `ok`/`unavailable`/`failed` are never selected again.

## Environment (names only — values live in the VPS env, never in Git)

- `WEB_READER_ENABLED` — non-secret gate, `false` by default.
- `WEB_READER_DATABASE_URL` — **secret** (DB Guy's migration PR creates the
  `web_reader_worker` role for it).
- Non-secret tunables: `WEB_READER_HERMES_MODEL`, `WEB_READER_MAX_PER_RUN`,
  `WEB_READER_BATCH_SIZE`, `WEB_READER_MAX_PARALLEL_BATCHES`,
  `WEB_READER_BODY_CAP_CHARS`, `WEB_READER_FETCH_TIMEOUT_MS`,
  `WEB_READER_HERMES_TIMEOUT_MS`, `HERMES_COMMAND`.
- Hermes provider auth is whatever the installed `hermes` CLI is already
  configured with; no Ollama keys are read by this package.

## Dependencies

- DB Guy's migration PR: the `body` / `body_status` / `body_fetched_at`
  columns on `atlas.signals`, the `web_reader_worker` role and
  `WEB_READER_DATABASE_URL`. Until it lands, the worker cannot start (config
  parse fails before any pool exists) and unit tests do not need it — the SQL
  is exercised against mocked `pg` clients in the test suite.
- `readableArticle`/`htmlToText` are copied from
  `packages/collectors/src/research-engine/deterministic-retrieval.ts` into
  `src/extract.ts` (per CTO decision — no `@myboon/collectors` dependency).

## Dry-run once enabled (later, after Bucket's go)

```bash
# on the VPS, with the migration applied and WEB_READER_DATABASE_URL in env
WEB_READER_ENABLED=true pnpm --filter @myboon/web-reader web-reader:once
```

Then check the `web_reader_run` summary line in the PM2 logs
(`pm2 logs myboon-web-reader --lines 200`).

## Tests

`pnpm --filter @myboon/web-reader test` — vitest with injected fakes only: no
live network, no live Hermes, no database.
