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

The analyst connects as `service_role` (only the granted columns and functions
exist to it). Jev and Clef are never contacted by the tests; see
`src/v4-status.db.test.ts` (local Postgres via `ANALYST_TEST_ADMIN_URL`) and
`src/deciders.test.ts` (fake fetch).

## Environment

- `ANALYST_DATABASE_CA_FILE` — optional PEM CA file the pool trusts instead of
  the bundled Supabase Root 2021 CA (`certs/supabase-prod-ca-2021.crt`).