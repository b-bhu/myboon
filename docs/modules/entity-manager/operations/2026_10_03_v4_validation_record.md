# Issue 299 — validation and restart gates

> Historical record for the 3 October implementation/validation phase. For the current article contract, scope and operating checkpoint, use the [working PRD](../PRDs/v4_prd.md) and [5 October handoff](2026_10_05_v4_entity_manager_checkpoint_handoff.md). These dated results do not establish the current profile/model settings or new article semantic quality.

Date: 2026-10-03

The owner accepted validation after the implementation-only pass. Scope remains Scout → Intake → Research → Entity Manager → private durable shared knowledge. Downstream integration is excluded. Other processes receive existing-behavior regression/startup checks only.

**Authorization update:** the owner subsequently authorized real Jev/Hermes calls and use of the actual database, without a dollar budget gate. The current VPS and Ubuntu PM2 daemon have been identified as the deployment target. Live work follows this offline record; its code snapshot and test evidence remain historical. [Live validation record](2026_10_03_v4_live_validation_record.md) records the resulting provider/data evidence and activation gates.

## Candidate and containment

Base commit: `3e750f3fb2f750e22f4dafdace19b274dc3432b8`. Implementation and validation fixes remain local; unrelated `.codex/agents/`, `.github/` and root `news.sqlite` changes are preserved.

The initial validation snapshot is `/tmp/myboon-v4-validation-20261003/initial-candidate.tar.gz`, with SHA-256 file manifest `/tmp/myboon-v4-validation-20261003/initial-candidate.json`. Its manifest digest is `b03202bc1921af6641b86e43d28d56faafb8532b856fa3f1c7870f3c4cfa050b`. It captures the initial validation source, tests, migration and configuration examples, without runtime credentials or source databases.

The frozen final code/configuration snapshot and SHA-256 manifest are `/tmp/myboon-v4-validation-20261003/final-candidate.tar.gz` and `/tmp/myboon-v4-validation-20261003/final-candidate.json`, containing 669 files. Runtime credentials, databases, unrelated user files and the validation evidence documents are excluded. The evidence remains in the repository documents and command logs; updating this record cannot change the code snapshot. The manifest and archive digests are recorded in `/tmp/myboon-v4-validation-20261003/final-candidate-digests.json`. Final manifest SHA-256: `570ec1a42efa7872d8fb97245d9fca8f645741aa647cfb1da6b21dd37106624c`; archive SHA-256: `d10d9df703cd43938bb29570485140bb83f72e202b95ade87059024b07e4cc71`.

Tests use temporary SQLite fixtures and a task-owned isolated PostgreSQL instance, with mocked providers. They do not use production database credentials, apply production migrations, replay historical work, change production flags or restart workers.

## Phase gates

| Phase | Status | Required evidence |
|---|---|---|
| 1 — candidate/configuration | Offline code candidate frozen; live fixes require a new snapshot | Final exact candidate/configuration digest; runtime inventory and release criteria. |
| 2 — parallel implementation validation | Passed, including final TypeScript | Entity/SQL, Research/Jev policy and operational/source lanes pass with reproducible commands and genuine failure-case coverage. |
| 3 — Jev/Hermes decision evaluation | Live evaluation authorized and underway | Reviewed cases, real provider outputs, false-known/contradiction/follow-up metrics, confidence acceptance, latency/calls/cost coverage and canary criteria. Mocked scores are not quality evidence. |
| 4 — complete isolated rehearsal | Passed with mocked providers; production preflight still required | Actual internal workers with synthetic sources, retained partial readiness, crashes/restarts, ownership changes, paid-result holds, atomic receipt recovery and state-preserving rollback. |
| 5 — production preflight/restart | Target identified; live readiness gates remain | Validated migrations/roles/TLS, explicit policies, backed-up recoverable stores, reconciled work/leases/dispatches, sole-owner receipts, News-first then Polymarket restart and healthy observation evidence. |

## Lane ownership

| Owner | Evidence document |
|---|---|
| Leo — private Entity/SQL | [Entity validation](2026_10_03_v4_entity_validation.md) |
| Maya — Research/Jev | [Research validation](2026_10_03_v4_research_validation.md) |
| Nora — source/operations/restore | [Operations validation](2026_10_03_v4_operations_validation.md) |
| Parent — inference gateway and integration | This record and `/tmp/myboon-v4-validation-20261003/` command logs |

## Parent findings and checks

The gateway regression tests exposed premature timeout handling: hold-on-unknown requests still reserved half their deadline for a fallback they could not use. A successful primary result arriving after that halfway point was discarded and held. The primary now receives its full logical deadline when unknown-outcome replacement is forbidden. Ordinary callers preserve their timeout/fallback behavior.

Focused classification/structured gateway regression run: **46 passed, 0 failed**, including one-call classification, shadow suppression, low-confidence admission, unknown timeout/unavailability holds, admitted output repair and full-deadline success. The full gateway suite subsequently passed **77 tests, zero failures/skips**:

```sh
pnpm exec tsx --test src/inference-gateway/*.test.ts
```

Log: `/tmp/myboon-v4-validation-20261003/inference-gateway-tests.log`.

The combined chain exposed a second runtime wiring defect: `buildNoveltyLookup` extracted the class reader's optional method and called it without its receiver. Private knowledge lookup therefore failed safely, but valid covered observations could never avoid synthesis. The method now retains its receiver, with a real class-reader regression in the Research lane.

The earlier implementation completion assessment also missed that shared Research recorded `proceed: false` but still synthesized unless exact result reuse succeeded. Validation added the guarded observation-resolution path: complete captured source, successful bounded knowledge coverage, fresh matching context/material digests, an immutable code-owned proof and no owed Entity action are required. Handoff rechecks that proof and freshness, retains source evidence, manufactures no claims and records `resolved_without_new_item` atomically. Incomplete/ambiguous comparisons continue ordinary Research; a changed saved no-item comparison is held.

## Combined internal pipeline rehearsal

From `packages/collectors`:

```sh
ENTITY_V4_RUN_POSTGRES_TESTS=1 pnpm exec tsx --test src/signal-platform/v4-internal-pipeline.integration.test.ts
```

Result: **7 reported tests passed** (six focused cases and their enclosing test), **zero failures/skips**. Log: `/tmp/myboon-v4-validation-20261003/internal-pipeline-rehearsal.log`.

This uses the actual News ingestion/outbox, canonical Intake, shared Research worker, deterministic retriever, durable SQLite ledgers/readiness, managed Entity processor, shared Entity worker and private PostgreSQL writer. Provider responses and source downloads are local fixtures; PostgreSQL is a new task-owned isolated TLS instance. It proves:

- Lost source acknowledgement is retried on an unchanged feed as one duplicate delivery and one saved admission.
- Attributed partial Research becomes explicit ready-for-Entity work, retaining caveats and durable settled decision exposure.
- The private write commits once despite loss of the SQLite completion acknowledgement.
- Reopening SQLite and restarting the disposable PostgreSQL server recovers the exact accepted receipt before packet/readiness hydration or provider construction, with no repeat planner call.
- Polymarket follows the same actual internal chain after evidence-bound exclusive News-first source ownership.
- An `already_known` fixture decision against actual private knowledge retains complete captured evidence, completes with no owed action, and invokes neither synthesis nor follow-up nor an additional private write.

The Entity lane separately passed **15 explicit PostgreSQL tests**, and the ordinary Entity suite passed **310 tests** with its opt-in PostgreSQL test skipped. The Research/gate lane passed **209 tests** and prepared **20 synthetic labeled evaluation requests**. The operations lane passed **210 source/recovery tests**, **252 existing pipeline compatibility tests**, and **67 API compatibility tests**, all without failures or skips. Some lane commands overlap; these counts are not a count of unique tests. Detailed commands, fixes and limits are in the linked lane documents.

The World Cup collector directory was already absent at the base commit. Its stale package scripts have no matching PM2 application; no World Cup test/startup is claimed. API compatibility tests used a disposable working directory so their generated swap database could not affect runtime data. No downstream implementation was added.

## Final combined gates

The parent ran every collector test file found by `rg --files src`, ending in `.test.ts`, with test concurrency four. The exact 184-file command is recorded in `/tmp/myboon-v4-validation-20261003/combined-regression-command.json`.

Result: **1,417 passed, zero failed, two skipped**, 1,419 total reported tests, approximately 45 seconds. The two skipped entries are the explicit opt-in PostgreSQL rehearsals, both run successfully separately above. Log: `/tmp/myboon-v4-validation-20261003/combined-regression.log`.

The initial combined run found one stale assertion in the existing feed end-to-end test: its expected budget lacked the newly explicit `costUsdMicros: null`. Updating the expectation preserves the unknown-cost contract; its targeted rerun and the complete combined rerun passed. Initial failure output is retained as `combined-regression-initial.log`.

Final collectors compilation:

```sh
pnpm exec tsc --noEmit
```

Result: **exit 0**. Log: `/tmp/myboon-v4-validation-20261003/final-typescript.log`. The first compiler passes caught test-only evidence types, callback/factory signatures and an ignored unsupported News fixture field. These were corrected without weakening production types. A final direct-reader fixture correction passed all 17 affected worker tests; its typing fix occurred after the combined run and before the successful final compiler check. Nora's upgrade fixture now explicitly verifies both retained raw payload fields instead of passing an ignored input.

`node --check ecosystem.config.cjs` and the scoped `git diff --check` passed. Read-only configuration inspection confirmed all ten defined PM2 entrypoints, working directories and interpreters exist; this checks paths rather than process startup. `/tmp/myboon-v4-validation-20261003/configured-entrypoints.json` records that result. No task-labelled PostgreSQL containers remain after cleanup.

## Runtime inventory

Read-only inspection of the already-running PM2 daemon found only `myboon-api` online. No daemon was started by the inspection. Raw PM2 environment/credentials were not printed or saved. The secret-free snapshot is `/tmp/myboon-v4-validation-20261003/initial-runtime-inventory.json`.

The final read-only PM2 inventory still shows the same API PID and restart count. `/tmp/myboon-v4-validation-20261003/final-runtime-inventory.json` records the selected nonsecret fields.

At the end of the offline pass, paid calls and deployment discovery were pending. The owner's subsequent authorization removes the paid-budget gate, and live read-only inspection identifies the current VPS/Ubuntu PM2 deployment. Phases 3 and 5 remain open until the live evidence and activation requirements are satisfied.

## Remaining live work

1. Confirm real provider availability and run recorded paired Jev/Hermes evaluation and representative total-assignment measurements, retaining unknown outcomes and measured-or-null costs. The synthetic labels and passing policy tests are not real-model accuracy or savings evidence. No dollar cap is required by the owner's current instruction.
2. On the identified deployment host, validate the actual database migration history, roles, function permissions/RLS, TLS and any pooler behavior. Provision/apply the private migration only through that deployment's reviewed configuration. The isolated legacy schema plus private migration rehearsal does not validate the entire hosted migration chain.
3. Capture and verify recoverable source backups; inspect actual source obligations, work, leases and paid dispatches. Reconcile known outcomes or keep unknown outcomes held. Construct current, attributable source-owned execution receipts and bind the approved runtime policies. Synthetic test receipts cannot authorize production.
4. Stop/fence competing claims, activate and observe News first, then Polymarket. Restart the remaining defined processes in dependency order using the confirmed process manager; retain saved receipts/results and monitor the agreed health window. Do not retire the old owner until canonical health and residual obligations are established.

This record does not claim production activation, restart readiness, real model quality, cost savings, hosted Supabase advisor results or historical backlog replay. Implementation remains private and downstream integration remains outside issue 299.
