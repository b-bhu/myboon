# Issue 299 — source ownership, operations and recovery validation

> Historical record for the 3 October implementation/validation phase. For the current article contract, scope and operating checkpoint, use the [working PRD](../PRDs/v4_prd.md) and [5 October handoff](2026_10_05_v4_entity_manager_checkpoint_handoff.md). These dated results do not establish the current profile/model settings or new article semantic quality.

Date: 2026-10-03

The owner approved validation after the implementation-only pass. This lane validates the internal source and recovery boundary only: collector observations, source intake, Research/Entity ownership, operational reporting and recoverable SQLite state. All databases and ownership artifacts used below are disposable fixtures under `/tmp/myboon-v4-operations-*`. External provider calls are mocked. Production files, source flags, deployments and workers were not changed or restarted.

## Reproducible result

From `packages/collectors`:

```sh
pnpm exec tsx --test \
  src/news/tests/*.test.ts \
  src/signal-platform/runtime-config.test.ts \
  src/signal-platform/runtime-control.test.ts \
  src/signal-platform/active-triage.test.ts \
  src/signal-platform/source-intake.test.ts \
  src/signal-platform/intake-durability.test.ts \
  src/signal-platform/status-sqlite-composition.test.ts \
  src/signal-platform/operator-recovery.test.ts \
  src/signal-platform/v4-source-cutover-preflight.test.ts \
  src/signal-platform/source-ownership.test.ts \
  src/signal-platform/v4-runtime-config.test.ts \
  src/signal-platform/v4-sqlite-upgrade-restore.test.ts \
  src/signal-platform/v4-operational-status.test.ts \
  src/polymarket/markets-data-engineer.test.ts \
  src/polymarket/markets-data-engineer-ownership.test.ts \
  src/pipeline-store/backup.test.ts \
  src/pipeline-store/restore-command.test.ts \
  src/pipeline-store/source-delivery-outbox.test.ts
```

Result: **210 passed, 0 failed, 0 skipped**, approximately 24 seconds. Complete command output: `/tmp/myboon-v4-operations-final.log`.

The five new operations regression files contain **23 tests**. The remaining tests exercise the existing News collector/research contract, source delivery, intake, runtime configuration/control, recovery, status, Polymarket collection and SQLite backup/restore behavior.

The parent requested the existing pipeline regressions for restart preparation. The following separate offline run also passed:

```sh
pnpm exec tsx --test \
  src/editor-draft/*.test.ts \
  src/publisher/*.test.ts \
  src/x-desk/*.test.ts \
  src/hyperliquid/*.test.ts \
  src/entity-maintenance/*.test.ts \
  src/hermes/*.test.ts \
  src/pipeline-store/*.test.ts \
  src/pipeline-ledger.test.ts
```

Result: **252 passed, 0 failed, 0 skipped**, approximately 15 seconds. Complete command output: `/tmp/myboon-v4-existing-pipelines.log`. These existing suites use injected stores/providers and disposable SQLite files; the Hermes process-group cleanup tests spawn only local shell fixtures. They add no downstream integration and make no live publishing, notification or model-provider calls. Some SQLite suites appear in both commands, so the two counts should not be presented as a count of unique tests.

The API compatibility check was run separately because its existing routes import the collectors package. Inspection confirmed injected fake knowledge readers, catalog/command stores and HTTP implementations with placeholder credentials. The broad `createApp` routing test rejects an invalid draft before remote store access, but constructing the app also creates a local swap SQLite file at the relative `.data/swap.sqlite` path. Therefore all API tests ran from a disposable working directory with absolute source paths, preserving the existing tests and avoiding the API's real `.data` directory.

Command, with working directory `/tmp/myboon-v4-api-compatibility-NzQiru`:

```sh
/home/ubuntu/myboon/packages/api/node_modules/.bin/tsx --test \
  /home/ubuntu/myboon/packages/api/src/internal/*.test.ts \
  /home/ubuntu/myboon/packages/api/src/stories.test.ts \
  /home/ubuntu/myboon/packages/api/src/narratives.test.ts \
  /home/ubuntu/myboon/packages/api/src/entity-knowledge.test.ts \
  /home/ubuntu/myboon/packages/api/src/news-feed/*.test.ts
```

Result: **67 passed, 0 failed, 0 skipped**, approximately 7 seconds. Complete command output: `/tmp/myboon-v4-api-compatibility.log`. The generated swap store remained inside the disposable working directory, which was removed after completion. Logged upstream failures and hydration limits are expected injected failure cases. No API/downstream source was edited; these results establish offline compatibility only and make no production startup or publishing claim.

## Pre-existing unavailable World Cup collector

`packages/collectors/src/world-cup` and its collector/test entrypoints do not exist. This was already true at base HEAD `3e750f3fb2f750e22f4dafdace19b274dc3432b8`; `git ls-tree -r --name-only HEAD -- packages/collectors/src/world-cup apps/video/src/world-cup` returns only the three unrelated video UI files. The base package manifest already contains stale `world-cup:pre-match` and `test:world-cup` scripts pointing to the missing source directory. Neither the base nor current `ecosystem.config.cjs` defines a World Cup app.

No World Cup suite or worker startup was attempted or claimed ready. Rebuilding that unrelated feature is outside issue 299; a requested World Cup restart needs a separate scope decision.

## Actual isolated rehearsals

| Boundary | Evidence |
|---|---|
| Authority and sole ownership | Missing authority fails closed without creating a source database. Preview creates no authority or ownership schema. Applied receipts record one exclusive owner for collector/intake/research/entity. Persisted authority continues fencing obsolete processes whose environment flag is stale. |
| Receipt provenance | Changed artifact bytes, expired approval, changed runtime policy digest, stale revision, wrong executed receipt and obsolete News-first evidence are rejected. Polymarket cannot activate before an executed, currently running, exclusive shared News receipt. |
| Worker activity and rollback | Real collector execution remains tracked through its asynchronous action and blocks source activation until it finishes. Native and shared Research/Entity claim mutations are rejected while paused. Two actual shared leases block switching back to legacy. Releasing those exact leases permits a reviewed rollback; existing legacy work and canonical source history remain intact. |
| Abandoned work and paid holds | Failed tracked work settles its activity record. Recovery requires exact retained operation IDs, marks only those operations reconciled, and adds no queue work. Durable unknown-payment outcomes remain held and prevent ownership reopening. |
| Observation retention | Paused News observations receive explicit `observed_only` status and retain the exact immutable pending source delivery. An actual Polymarket collector cycle with intake off preserves each material observation and baseline while writing no obsolete candidate/thread admission. A source change during asynchronous intake capacity lookup prevents classifier dispatch and work admission while retaining the observation. |
| Legacy News schema upgrade | A real old constrained News schema is reconstructed on a disposable database with historical candidate/research rows, a child foreign key, a custom index and a custom trigger. The real startup upgrade widens the status constraint, preserves every historical row and raw research payload, passes `foreign_key_check`, retains the index and executes the retained trigger. It fabricates no historical delivery obligation. The existing oldest unrestricted schema upgrade tests also pass. |
| Verified backup and restore | The real Node SQLite online backup and restore routines run on News and Polymarket fixtures. Restored stores retain stable producer identities, producer pins, consumer usage provenance, resolvable evidence, pending native outbox delivery, unknown reservations, root assignment limits, saved research records and executed ownership receipts. An omitted present durability table in a v2 manifest makes verification fail. Digest/schema-bound pre-V4 v1 manifests remain restorable. |
| Reporting and command execution | Operational counters read actual saved reservation/settlement/reuse/execution rows and distinguish measured cost from unknown cost. Missing/corrupt sources remain unavailable while healthy peers keep reporting. Both `run-v4-status.ts` and existing `run-status.ts` execute as real subprocesses on fixture paths and retain compatible JSON. The real ownership CLI previews, explicitly applies and idempotently replays an approved fixture receipt. Missing source paths are not created. |
| Safe runtime defaults | Disabled V4 features never inspect private database credentials. Enabled Research requires explicit aggregate/primary policies and numeric ceilings; follow-up permits exactly one call and preserves explicit unknown cost. Optional private knowledge credentials are available for every Research feature; the managed writer requires its dedicated credentials. |

Reusable fixture composition is in `packages/collectors/src/signal-platform/v4-operations.test-support.ts`: `operationsFixture(source)`, `withIsolatedV4Environment()` and `observationInput()`. These fixtures create both native and canonical source stores and support receipt-bound initialization, activation, pause, recovery and rollback.

## Defects corrected during validation

1. Old News databases with an unrestricted status column were incorrectly rejected by the new status-widening migration. The migration now recognizes an already-unrestricted column and retains it; constrained schemas use the transactional widening path exercised above.
2. Backup manifests did not count the new source authority, reservation, assignment-limit, research checkpoint and cross-source artifact tables. New backups use manifest v2 and count every present durability table. Verification requires that inventory, while v1 retains its original digest/schema-bound compatibility contract.
3. An explicit ownership apply could open a nonexistent source path and create a database before rejecting missing source tables. The operator now requires an existing source database before opening either preview or apply.
4. Abandoned-operation preview checked the receipt shape but did not check whether the supplied IDs were current source-owned in-flight operations. Both preview and execution now check the exact retained IDs.
5. Optional private context credentials were exposed only with novelty enabled. They are now exposed for any enabled Research feature so reuse/follow-up can consult managed corrections without requiring the paid novelty classifier.

The existing News production-storage boundary assertion was updated to verify the new guarded native store composition rather than its old source-text construction. Its underlying native SQLite storage requirement is preserved.

## Acceptance limits

The receipt artifacts in these tests are explicitly synthetic reviewed fixture evidence. They demonstrate binding and rejection behavior; they are not approval artifacts for production. No production backup/restore proof, private PostgreSQL reconciliation, live healthy observation window, paid-provider decision quality, cost reduction or restart readiness is claimed by this lane.

Source SQLite fences future SQLite queue writes and tracks supported collector/native-worker activity. A sole-owner switch still requires independent operator proof that actual private PostgreSQL lease epochs and planning dispatches have been reconciled or fenced and that source workers are stopped. It must not infer PostgreSQL safety from zero SQLite rows. That boundary remains in the production preflight and the private Entity validation lane.

TypeScript compilation is owned by the parent after all validation lanes freeze. No build, deploy, restart, production migration or paid workload was executed by this lane. No downstream integration was added.
