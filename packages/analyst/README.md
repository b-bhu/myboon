# @myboon/analyst

V4 analyst. #478: per-signal states (`atlas.signal_states`), time-limited claims, the
sweeper, retry/dead-letter, and the logged Jev client (`atlas.jev_decisions`).
#479: the Linker + Story analyst (`src/analyst.ts`) — `runAnalystOnce` claims signals,
shortlists active shelves by alias in code (with `atlas.routing_rules` applied), makes
ONE logged Jev call per signal and files `atlas.decisions` in the same transaction that
advances the signal to `analysed`.

## One-shot run

`scripts/analyst-run.ts` (npm script `analyst:once`) admits fresh signals and runs
`runAnalystOnce` once:

    ANALYST_DATABASE_URL=postgres://... JEV_API_TOKEN=... pnpm --filter @myboon/analyst analyst:once

Env vars:

- `ANALYST_DATABASE_URL` (required): the Postgres the analyst connects to — on Supabase
  the analyst connects as `service_role` (one shared team login, per CTO, #485 review),
  so this is that project's service_role connection string. The migration in
  `supabase/migrations/20261026230000_atlas_routing_rules.sql` grants service_role
  select on `atlas.routing_rules` and select+insert on `atlas.decisions` (+#474/#449
  already cover the rest).
- `JEV_API_TOKEN` (required): the shared TypeSafe System One token, read by `jevFromEnv`;
  never printed, logged or written. This entrypoint is the only place real Jev may be
  called — tests use scripted ports only.
- `ANALYST_LIMIT` (default 50), `ANALYST_LEASE_MS` (default 60000), `ANALYST_BACKOFF_MS`
  (default 60000), `ANALYST_JEV_TIMEOUT_MS` (default 30000): optional knobs. The analyst refuses to start (`AnalystConfigError`) unless `ANALYST_LEASE_MS` > 1.2 × `ANALYST_JEV_TIMEOUT_MS`.

Nothing here creates or reads a `.env` file — provide the values yourself. The PM2 wiring
(process name, cwd, restart policy, log rotation) belongs to the systems manager; this
package ships only the entrypoint and this env contract.

## Tests

    ANALYST_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:55478/postgres pnpm --filter @myboon/analyst test

`src/*.db.test.ts` create and drop throwaway databases on that local Postgres through
`@myboon/atlas-schema` (all `*_atlas_*.sql` migrations applied fresh per database) and skip
when `ANALYST_TEST_ADMIN_URL` is unset. Real Jev is never called; Jev answers are scripted.