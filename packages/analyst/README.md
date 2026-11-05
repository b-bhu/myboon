# @myboon/analyst (V4 analyst, issue #478)

The decider slot and signal claim state for the V4 analyst. The package owns no
tables: everything it touches is created by
`supabase/migrations/20261027120000_atlas_signal_status.sql`.

## What is here

- `src/states.ts` — claim a due signal (`claimNext`), finish it
  (`finishClaim`), record a failure (`failClaim`). Each is one call to an
  `atlas.signal_*` SQL function: a short committed transaction that clears the
  claim, so a crash is fenced by the claim token — the next `claimNext` picks
  the signal up again only after `claim_expires_at`.
- `src/deciders.ts` — `SystemOneDecider`, the Jev/Clef client (one POST per
  call to `/v1/systemone` with a `pick` choice question; the response model is
  pinned). `jevFromEnv()` and `clefFromEnv()` read `JEV_API_TOKEN` and
  `OLLAMA_API_KEY`; tokens are never logged or emitted. Failures map to
  `DeciderError` kinds: `out_of_credit` (HTTP 402), `timeout` (abort), `error`.
- `src/process.ts` — `processNext` ties it together: claim, build the case,
  run primary (Jev) and shadow (Clef) deciders in parallel, fall back to Clef
  when Jev errors/times out/is out of credit, then `finishClaim` with the
  decision row (full provenance: probabilities, runner-up margin, latency,
  decided_by, shadow answer) or `failClaim` with the last error.
- `src/runner.ts` — `runAnalystOnce` / `analystMain` (#512): one pass over due
  signals, one summary line, always ends the pool.
- `src/signal-worker.ts` (renamed from `d36-worker.ts` in #559) — the signal worker (#504): claim, one LLM session per
  signal with Jev/Clef as the decision tool, the sink, plus the standing rule
  that a signal older than 24 hours is parked `backlog_skip_24h` (#391) before
  the LLM runs. Since #571 the analyst writes **no entity items and no
  summaries**: its work ends at the handoff (below). `PgHandoffSink` records
  the `atlas.decisions` row (decision, reason, the one entity pick in
  `targets`, `summary` null); other targets are dropped with a
  `target_dropped` log line, and no entity is ever created (#567). `pgCandidateLookup` is
  the read-only #566 candidate fetch.
- `src/session.ts` — the analyst session and type-first matching (#567, see
  below). `src/dry-run-matching.ts` is the read-only matching dry run.

## The handoff (#571)

```mermaid
flowchart LR
  S[atlas.signals row] --> A[analyst session]
  A --> H[AnalystHandoff: decision, reason, entity pick or null, full signal]
  H --> D[atlas.decisions row]
  D -.-> EM[entity manager, #571 task 3]
```

`AnalystHandoff` and `SignalMetadata` live in `@myboon/contracts`
(`signal-metadata.ts`). The signal is the whole `atlas.signals` row, unchanged:
id, source, type, priority, times, `text`, `numbers`, `link`, `raw_ids`
(`image`, `author`, `feed_source`, `outlet`, `handle`, `coingecko`, plus any
other key), `unusual_score`, `excerpt`, `raw_hash`. Scout stores no article
body: `text` is the article title or the full post. `PgHandoffSink` stores it in
one `atlas.decisions` insert: `handoff` (the AnalystHandoff JSON snapshot),
`handoff_version` (1) and `em_status` (`pending` for every keep, entity null =
growth path; `none` for ignore/unclear), the entity manager's claim queue. The
columns and the analyst_worker grants come from DB Guy's migration
`20261105150000_atlas_em_handoff.sql` (#581), which must be applied first.

## Entity matching (#567, shortlist + one pick)

```mermaid
flowchart LR
  A[Signal] --> M[Turn 1: mentions, exactly 2 types each, one marked main]
  M --> S[Shortlist over all mentioned types, per type in parallel]
  S --> H[Alias hits first, always kept]
  H --> F[Fill by entity item count, cap 40]
  F --> P[One decision-tool call: slug or none]
  P -->|slug| E[One main entity per signal]
  P -->|none| L[entity_miss log, nothing created]
```

- Mentions are validated with zod (`analystMentionSchema` in `@myboon/contracts`):
  exactly 2 distinct types, a `main` flag (first mention if none is marked).
- `pgCandidateLookup().shortlist(types, names, cap)` runs one read-only query per
  type in parallel: active entities whose name or alias (`atlas.entity_candidates`,
  #566, exact on `atlas.norm_alias`) matches the mentions or a 1-3 word phrase of
  the headline and text, kept first (the cap holds for them too); then the most active entities of those types
  by `entity_items` count, deduped, up to `SHORTLIST_CAP` (40). Each row carries
  id, slug, name, type, aliases and a one-line summary.
- One decision-tool (Jev) call gets the article, the main subject and the full shortlist
  and answers one slug or `none` (closed choice). Anything outside the list counts
  as none. There is no type-decision call, no retry and no cross-type fallback.
- None logs one `entity_miss` line (see the RUNBOOK) and routes nothing. No code
  path inserts into `atlas.entities`. No CoinGecko, no embeddings.
- The reasoning and note turns accept a plain-text reply.

Dry run (read-only, needs the analyst env; nothing is written):
`pnpm --filter @myboon/analyst matching:dry-run --recent 20` or
`--ids id1,id2` or `--text "..."`, plus `--force-keep` to skip the keep gate.
Each line also shows the `handoff` the worker would save (null for `--text`).
On 100 recent prod signals (Nov 4, 2026): 72 matched, 21 `entity_miss`, 7 ignored,
0 failed, mean confidence 0.94. Design record: wiki V4-Design (analyst session) and
Decision-Log D37.

- `src/catchup.ts` — the #391 one-off catch-up CLI (confirm-gated, Ollama
  quota guard, no new entities); `src/ollama-quota.ts` reads ollama.com's
  `/api/balance` for its quota guard.

There is no package entry point: `src/index.ts` was removed in #559 (nothing
imported `@myboon/analyst`). Import from the module that owns a symbol, and run
the CLIs via the `analyst:*` / `entity-manager:once` scripts.

## Configuration knobs (`src/config.ts`, all optional, positive integers)

- `ANALYST_MAX_SIGNALS_PER_RUN` — default **40** signals per run.
- `ANALYST_LEASE_MS` (default 300000, 5 min), `ANALYST_TIMEOUT_MS` (20000),
  `ANALYST_BACKOFF_MS` (60000), `ANALYST_MAX_ATTEMPTS` (3).
- `ANALYST_LLM_MODEL` (default `glm-5.3-flash`), `ANALYST_WORKER`
  (default `<hostname>:<pid>`), `ANALYST_SHADOW` (`true` enables the Clef shadow).

The analyst connects as `service_role` (only the granted columns and functions
exist to it). Jev and Clef are never contacted by the tests; see
`src/v4-status.db.test.ts` (local Postgres via `ANALYST_TEST_ADMIN_URL`) and
`src/deciders.test.ts` (fake fetch).

## Environment

- `ANALYST_DATABASE_CA_FILE` — optional PEM CA file the pool trusts instead of
  the bundled Supabase Root 2021 CA (`certs/supabase-prod-ca-2021.crt`).