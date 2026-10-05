# Entity V4 private writer validation — 2026-10-03

> Historical record for the 3 October implementation/validation phase. For the current article contract, scope and operating checkpoint, use the [working PRD](../PRDs/v4_prd.md) and [5 October handoff](2026_10_05_v4_entity_manager_checkpoint_handoff.md). These dated results do not establish the current profile/model settings or new article semantic quality.

This rehearsal exercises the additive private migration, production PostgreSQL client, managed Entity processor and accepted-receipt recovery in the shared Entity worker. Every inference response is a local mock. No production database, deployed process, paid provider or downstream reader/consumer was changed or called.

## Containment

The machine had no local PostgreSQL binaries. Docker 29.4.0 was available through `sudo -n docker`; the normal user could not access its socket. The fixture uses the official `postgres:17.11` image, digest `sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f`.

`IsolatedEntityPostgres` creates a random task-labelled container and a separate `--internal` Docker network. It accepts no database URL or container name from environment variables. No port is published. The host connects only to the fixture's newly allocated private bridge IP. A fresh one-day certificate includes that IP; both administrative fixture connections and the production writer verify TLS certificates. The fixture also confirms `current_database()` is `myboon_entity_v4_validation` and `pg_stat_ssl.ssl` is true before applying SQL.

Only a fresh task-owned TLS directory is mounted. PostgreSQL data lives in the fresh container volume. Synthetic fixture passwords and local LOGIN roles are used. The exact baseline `public.entities` schema (including JSONB aliases) is loaded from `20260624_entity_manager_v1.sql`, followed by the actual additive V4 migration in a transaction. A legacy memory sentinel and index detect accidental changes to legacy storage.

Cleanup removes only the fixture's exact labelled container/volume and internal network. Task-owned certificate and server-log directories remain under `/tmp/myboon-v4-entity-*`. Server restart and backend termination below affect this disposable fixture exclusively.

Docker 29 did not create published-port mappings for an internal network. The initial harness assertion failed before any migration ran; using the private bridge IP retained network isolation and removed the need to publish a port.

## Commands and results

Run from `/home/ubuntu/myboon`:

```sh
sudo -n docker info --format '{{.ServerVersion}}'
sudo -n docker pull postgres:17.11
pnpm --filter @myboon/collectors test:entity-manager
ENTITY_V4_RUN_POSTGRES_TESTS=1 pnpm --filter @myboon/collectors exec tsx --test src/entity-manager/postgres-knowledge-writer.integration.test.ts
sudo -n docker ps -a --filter label=myboon.fixture=entity-v4 --format '{{.Names}}'
```

| Command | Result |
| --- | --- |
| Existing Entity suite before fixes | Exit 0; 310 passed, zero failed/skipped. |
| Existing Entity suite after fixes | Exit 0; 310 passed, zero failed; one opt-in PostgreSQL suite skipped. Total reported: 311. Duration: 19,068.511372 ms. |
| Explicit PostgreSQL rehearsal | Exit 0; 15 reported tests passed (14 focused cases plus their enclosing test); zero failed/skipped. Duration: 4,318.479635 ms. Server artifacts: `/tmp/myboon-v4-entity-VW5ND7`. |
| Fixture-labelled container query after completion | No remaining fixture container. |

The normal Entity suite never provisions Docker resources: the PostgreSQL integration test requires explicit `ENTITY_V4_RUN_POSTGRES_TESTS=1`. Logs are `/tmp/entity-v4-existing-tests.log`, `/tmp/entity-v4-existing-tests-final.log` and `/tmp/entity-v4-postgres-tests.log`. An initial SQL-failure log is retained at `/tmp/entity-v4-postgres-failure-jsonb.log`; each later run reports its exact disposable server-log directory.

## Rehearsed behavior

- Verified TLS succeeds with the fixture CA; an untrusted certificate fails through the production writer.
- Catalogue alias lookup works with the real legacy JSONB column. Source native identity and canonical URL resolve accepted managed context. Original requested URL, final URL, retrieval hash, provider provenance and immutable readiness survive the source checkpoint.
- Writer LOGIN has named function execution only: direct private table reads/inserts and public catalogue updates fail. Context-only LOGIN cannot call the writer. API/service identity is rejected even after a fixture deliberately grants it executor membership. Function owner is NOLOGIN/NOSUPERUSER/NOBYPASSRLS, has no schema CREATE, immutable-item UPDATE or history DELETE grant. Helpers are not publicly executable; functions have fixed `pg_catalog` search paths.
- Three simultaneous lease contenders yield one winner. A later epoch fences old commit/checkpoint/renew/release calls. Replaying an accepted operation with a different stale owner returns the original terminal receipt.
- A receipt-insert exception rolls back item, evidence, history and receipt effects. Saved validated plans survive client disconnect. Terminating the actual writer backend while the transaction waits at receipt insertion also leaves zero effects. Concurrent retries of the saved plan commit once and return the same receipt.
- Held history and the original plan revision remain unchanged when a later revision is accepted. Held plans cannot be resumed as unheld plans.
- Missing Research admission, changed signal linkage, wrong packet digest and forged claim/evidence URL tuples are rejected by named SQL functions. Forged evidence leaves zero item/history/receipt effects.
- Catalogue revision changes, mismatched expected-absent IDs, an item ID occupied after planning and concurrent operations against one captured context prevent stale commits.
- Corrections create linked successors while retaining old prose. Evidence attachment, membership removal and retraction advance revisions and append history; they preserve immutable prose and removed membership rows.
- The managed processor and actual `SharedEntityWorker` acknowledge an accepted receipt before packet/readiness hydration, ownership processing or construction of unavailable provider configuration. Worker completion uses zero additional processing.
- Unknown paid planning execution becomes durable held dispatch history. Changing policy or restarting after dispatch reservation cannot purchase a replacement. Reconciliation rejects missing proof digest, wrong request hash, wrong provider and an unbound provider route. Bound synthetic no-execution proof creates an attributable event; unresolved unsupported execution stays held.
- Approved attributed partial Research produces one managed item shared by two grounded private identities, including a secondary participant. Caveats and open questions survive. No public catalogue entity is created. An owed evidence attachment takes the deterministic path with zero planner calls.
- Restarting the disposable PostgreSQL server preserves receipts, saved plans and private knowledge. Legacy memory/index remain unchanged. Operational status returns payload-free counts.

## Defects fixed from the rehearsal

1. `context_v1` used `unnest` for legacy JSONB aliases. Actual execution failed with SQLSTATE `42883`; it now uses `jsonb_array_elements_text`.
2. The source checkpoint mapped a nonexistent retrieved-evidence `url` property. The requested URL disappeared during canonical serialization; it now stores `requestedUrl`.
3. The planning checkpoint queried unqualified `snapshot`, which conflicted with a PL/pgSQL variable and failed with SQLSTATE `42702`. The table column is qualified.
4. SQL three-valued logic admitted a missing Research readiness outcome. Admission now fails closed and also binds readiness schema, signal, source and recorded packet completion to the saved packet.
5. SQL three-valued logic allowed null reconciliation proof fields. Required proof fields now fail closed. Reconciliation additionally requires an explicitly stored matching provider; an unbound route cannot be released by an arbitrary provider claim.

## Reusable fixture

The implementation is `packages/collectors/src/entity-manager/isolated-postgres.test-support.ts`. An integrated pipeline rehearsal may create a new fixture, call `await start()` and `await migrate()`, then use `writer()` or `writerOptions()` for the same production client and TLS configuration. `pool('v4_reader_fixture')` uses the separate context-only LOGIN. Always close writers/pools before `await close()` in `finally`.

## Limits

This establishes local PostgreSQL 17 behavior with the repository's exact private migration and real client/runtime paths. It does not validate a production Supabase instance, existing deployed role memberships, a hosted pooler, real Jev/model behavior, measured budget calibration, pipeline rollout, or production restart. No downstream exposure is part of this work. Root's combined TypeScript and pipeline checks are recorded separately.

The Supabase CLI is absent, so Supabase advisors were not run. Direct disposable PostgreSQL permission/RLS/function queries above provide local evidence; hosted Supabase advisors remain a rollout check. Current primary documentation consulted: [PostgreSQL CREATE FUNCTION](https://www.postgresql.org/docs/current/sql-createfunction.html), [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html), [Supabase database functions](https://supabase.com/docs/guides/database/functions), the [Supabase changelog](https://supabase.com/changelog.md) and [product security guidance](https://supabase.com/docs/guides/security/product-security.md).

The September 25 [PostgreSQL 15.19/17.11 breaking-change notice](https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes) was reviewed. Its affected features are ltree, legacy pgcrypto encryption, float btree_gist indexes and custom selectivity operators. This private migration uses none of those features; that source-based conclusion concerns this migration only and does not characterize the deployed database.
