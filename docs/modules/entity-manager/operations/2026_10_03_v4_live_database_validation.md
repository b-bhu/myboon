# Entity V4 hosted database preflight — 2026-10-03

> Historical record for the 3 October implementation/validation phase. For the current article contract, scope and operating checkpoint, use the [working PRD](../PRDs/v4_prd.md) and [5 October handoff](2026_10_05_v4_entity_manager_checkpoint_handoff.md). These dated results do not establish the current profile/model settings or new article semantic quality.

This report records the initial read-only hosted preflight, isolated catalogue/role rehearsals, live internal evaluation and subsequent authorized hosted setup. The initial catalogue and memory export was read-only. After the bounded rehearsals, the parent applied the additive private schema and provisioned dedicated minimal logins. Existing stored facts, source ownership and deployed processes were not changed; source activation remains closed.

## Hosted findings

The configured project is `rrdvpdgebygfdstwknqc` (`myboon`, `ap-northeast-1`, ACTIVE_HEALTHY). PostgreSQL reports 17.6. At the initial preflight, hosted migration history contained 22 entries, ending at `20260921153932_harden_entity_catalog_review_boundaries`; the V4 private migration, schema and managed roles were absent. At `2026-10-03T05:33:20.559263Z`, the project contained 1,653 public entities and 47,598 legacy entity memories. The subsequent hosted setup is recorded below.

The existing `public.entities` catalogue uses JSONB aliases, 12 columns, seven indexes and enabled RLS with no policies. Catalogue and memory tables belong to `postgres`; API roles have table grants but ordinary API access remains subject to RLS. The SQL administrator is `postgres`, with NOSUPERUSER, CREATEROLE, CREATEDB, BYPASSRLS and REPLICATION. It has database/schema CREATE, owns the catalogue and has ADMIN/INHERIT/SET memberships in existing administrative and API roles. None of those memberships are appropriate for the dedicated managed writer.

The actual hosted security advisors returned one ERROR, two WARNs and 14 INFO findings. `public.published_narratives` has RLS disabled and API-role table grants. This is an existing exposure outside this private-writer change; remediation requires review of that table's intended access. See the [Supabase RLS-disabled linter guidance](https://supabase.com/docs/guides/database/database-linter?lint=0013_rls_disabled_in_public). The two mutable-search-path warnings concern `public.exec_sql(query text)` and `touch_ai_explanations_updated_at`. `exec_sql` is SECURITY DEFINER owned by `postgres`; anon/authenticated cannot execute it, while service_role can. No unrelated permission changes were made. Performance advisors returned two unindexed-FK and 15 unused-index INFO findings; these are recorded, not instructions to remove indexes.

## Private export and catalogue compatibility

Artifacts are in `/tmp/myboon-v4-live-20261003`, with directory mode 0700 and exported files mode 0600:

| Artifact | Contents |
| --- | --- |
| `preflight.json` | Project metadata, migration history, advisor findings and exact inspected grants/counts. |
| `schema.json`, `catalog.sql` | Actual catalogue columns, defaults, constraints, indexes, RLS and policies; controlled isolated reconstruction. |
| `cases.json` | 16 public-source legacy cases, 20 relevant catalogue rows and 30 bounded memory-context rows. |
| `reviewer-labels.json` | Manual pre-output relevance, attribution, ambiguity and coverage expectations. |
| `chain-entities.json` | Actual Micron/MU, Silver/XAGUSD, Solana, Tokens on Solana and Nasdaq catalogue rows. |
| `catalog-compatibility.json`, `catalog-compatibility.log` | Isolated migration and internal-context results against the actual catalogue shape and selected rows. |

Only public-source prose, source references, evidence URLs, entity identity fields and timestamps were exported. No credentials, Auth/account data or manual operator notes were exported. Body, summary and evidence collections are bounded and clipping flags are retained. These are legacy memories, not canonical Research packets or readiness proof. Reviewer labels are independent of model output but do not establish external truth.

One real legacy Solana memory is linked to GPT-5.6. That GPT row includes Solana-related aliases, while a correct Solana row also exists. The evaluation must ground identity from evidence and retain ambiguous catalogue candidates; it must not treat every alias match as an authorized entity membership. The catalogue contains a Nasdaq exchange row but no exact Nasdaq 100 index match in the bounded identity query.

The controlled catalogue copy imported 20 rows with the actual 12-column JSONB-alias schema. The additive private migration and named private context queries succeeded using a non-superuser administrator with hosted-equivalent relevant privileges. The isolated server was PostgreSQL 17.11; this checks catalogue and privilege compatibility, not hosted deployment itself.

## Role-parity fix and regression evidence

The original migration attempted `ALTER ROLE ... NOSUPERUSER`, which PostgreSQL rejects for a non-superuser administrator even when the target role is already ordinary. The migration now creates explicit minimal NOLOGIN roles and rejects any existing managed role with LOGIN, elevated attributes or outgoing inherited memberships. It does not silently adopt or demote unrelated elevated roles.

Named-function execution grants are established before function ownership is transferred. Ownership transfer temporarily grants the administrator SET membership only when required, with INHERIT false; that temporary SET option is removed afterward. Creator ADMIN OPTION is retained as required for subsequent migration administration. The function owner remains minimal, cannot log in and receives no API/service-role membership. Existing hosted auth roles are unchanged.

Commands were run from `/home/ubuntu/myboon`:

```sh
pnpm --filter @myboon/collectors exec tsx /tmp/myboon-v4-live-20261003/catalog-compatibility.ts
ENTITY_V4_RUN_POSTGRES_TESTS=1 pnpm --filter @myboon/collectors exec tsx --test src/entity-manager/postgres-knowledge-writer.integration.test.ts
pnpm --filter @myboon/collectors test:entity-manager
sudo -n docker ps -a --filter label=myboon.fixture=entity-v4 --format '{{.Names}}'
```

The catalogue rehearsal exited 0. The explicit private PostgreSQL suite passed 21/21 tests, including fresh and pre-existing minimal roles under a non-superuser administrator, rejection of pre-existing LOGIN/BYPASSRLS/service-role membership, preserved minimal function ownership and restored SET privileges. Existing permission, concurrency, receipt, crash, history and forged-evidence cases also passed. The Entity suite exited 0 with 310 passed, zero failed and two opt-in PostgreSQL tests skipped (312 reported tests). The fixture container query returned no remaining task container. Detailed logs are `postgres-role-parity-tests.log` and `entity-tests-after-role-fix.log` in the private artifact directory. Earlier isolated validation is recorded in [the private writer validation report](./2026_10_03_v4_entity_validation.md).

## Connection and staging requirements

The actual direct endpoint resolves to IPv6 and its TCP port 5432 is reachable from this machine. A PostgreSQL SSLRequest followed by strict system-trust TLS verification failed with `CERTIFICATE_VERIFY_FAILED: self-signed certificate in certificate chain`. No authentication or SQL was attempted through that diagnostic. The production writer must receive the authentic project root CA through `MYBOON_MANAGED_KNOWLEDGE_DATABASE_CA`; certificate verification must remain enabled. The app tools expose no certificate or pooler connection metadata. Direct IPv6 is usable here; a pooler address must be copied from actual project Connect metadata rather than inferred from region.

The applying administrator needs database/schema CREATE, CREATEROLE and authority over the isolated managed roles for grants and ownership transfer. Dedicated LOGINs receive only named executor/context role membership, with no service_role, API-role, administrative or managed-table mutation grants. The writer URL belongs only in `MYBOON_MANAGED_KNOWLEDGE_DATABASE_URL`. Managed activation additionally requires explicit policy, active sources and durable source-ownership gates. No hosted login or activation configuration was provisioned during the initial preflight; authorized hosted setup followed the bounded evaluation below.

Primary documentation consulted: [PostgreSQL ALTER ROLE](https://www.postgresql.org/docs/17/sql-alterrole.html), [CREATE FUNCTION ownership/security](https://www.postgresql.org/docs/17/sql-createfunction.html), [Supabase connection methods](https://supabase.com/docs/guides/database/connecting-to-postgres) and [Supabase SSL certificates](https://supabase.com/docs/guides/platform/ssl-enforcement). SSL enforcement was not changed because that operation restarts the hosted database.

## Real-provider internal pipeline rehearsal

The opt-in harness is `packages/collectors/src/signal-platform/v4-live-internal-pipeline.integration.test.ts`. It uses actual exported historical source observations and catalogue rows with real source delivery/outbox, intake, Research worker, `StructuredResearchSynthesizer`, configured gateway, managed canonical Entity planner, private PostgreSQL writer and shared Entity worker. SQLite stores, source authority and PostgreSQL remain disposable. Retained retrieval is the only data injection; no provider output or Entity plan is mocked.

The evaluation-only route was `openrouter/stealth/space-bunny-alpha` with the parent's verified `myboonv4validation20261003` Hermes profile. That profile disables auxiliary title generation, compression and memory; each installed CLI usage receipt measured one primary API call and zero auxiliary calls. This is not a production route approval or classification-registry change. The evaluation composes the real Jev adapter and registry definitions, with sampling configured locally; both positive cases correctly bypassed paid novelty because private knowledge context was empty, and no newly admitted follow-up URL existed. There were zero Jev calls in this chain rehearsal; real Jev evaluation is recorded separately.

Original signal observed/published times and upstream provider/raw references remain unchanged. The harness uses an explicit historical logical clock for admission/retrieval freshness. Actual dispatch and receipt times use real wall time. News replays the retained X text, with full article completeness explicitly unverified. The Polymarket positive case replays its immutable native odds snapshot through a `historical-replay.native-observation` envelope. It is neither a current HTTP-fetched Polymarket page nor a resolved market outcome. The native snapshot's original timestamp inconsistency is retained: its signal observation precedes the current-odds timestamp stored in its immutable content. It is not silently repaired.

The exported Polymarket text itself was a Baidu/Yandex search capture. It is retained under its original Baidu URL, `search_connector` authority, work reference and capture time as a separate negative probe. It was never relabelled as market source evidence.

Commands:

```sh
ENTITY_V4_RUN_LIVE_INTERNAL_PIPELINE=1 pnpm --filter @myboon/collectors exec tsx --test src/signal-platform/v4-live-internal-pipeline.integration.test.ts
ENTITY_V4_RUN_LIVE_INTERNAL_PIPELINE=1 ENTITY_V4_LIVE_INTERNAL_CASES=negative pnpm --filter @myboon/collectors exec tsx --test src/signal-platform/v4-live-internal-pipeline.integration.test.ts
pnpm --filter @myboon/collectors exec tsx --test src/signal-platform/v4-live-internal-pipeline.integration.test.ts
```

The first command exercised both positive cases successfully, then exited 1 because the new negative harness referenced a different work ID from its retained evidence. That negative attempt purchased no provider call. A focused retry exposed a second local input-contract issue, the external-source allowance; it also purchased no call. The harness now preserves original work identity and admits the one retained external source explicitly. Only the negative probe was rerun, avoiding repeat purchase of the already completed positive cases. That final command passed 2/2 reported tests (the negative probe and enclosing test). The default invocation skipped its one test without constructing stores or providers.

| Case | Actual outcome |
| --- | --- |
| News Micron/Tokens on Solana capture | Attributed claims, `partial`, no verified facts, `ready_for_entity`. One immutable private item linked to the grounded Micron identity; retained source attribution, missing performance methodology, tokenized-instrument uncertainty and Research caveats. |
| Polymarket Silver native observation | Attributed archived 43.5% → 24.5% odds change, no verified facts, `ready_for_entity`. One private item linked to Silver; explicitly neither a current price nor evidence that Silver hit $65 or that the market resolved. |
| Unrelated Baidu/Yandex retrieval | Natural synthesis returned `failed`, zero claims and zero verified facts, with an explicit unrelated-source limitation. The actual Research assessor returned `failed`; the probe received no Entity admission/write. |

Both positive cases committed accepted terminal receipts. The harness deliberately lost SQLite completion acknowledgement, closed/reopened the source store, restarted PostgreSQL and constructed fresh writer clients. Receipt recovery completed each original work while packet hydration and provider construction were deliberately unavailable. Each recovery made zero new provider calls and returned the unchanged receipt.

Across the successful positive dispatches and final negative probe, CLI receipts measured five primary API calls, zero auxiliary calls, 13,568 input tokens, 3,183 output tokens and 3,394 cache-read tokens (20,145 total). Gateway usage remains adapter-estimated; installed CLI usage is retained separately. CLI cost status was `unknown`; a zero estimated cost does not establish that the calls were free.

Private detailed artifacts:

- `internal-chain-live-c2455998-46c5-4dc9-b819-c35f7b995e48/`: successful positive packet/readiness/evidence/reservation/plan/receipt/restart results and four actual dispatch receipts; the first overall test log reports the subsequent pre-dispatch harness failure honestly.
- `internal-chain-live-2b8d4aa0-5895-4a9d-aa04-bdb17fe7647d/`: final negative input/output/readiness, actual CLI usage and complete summary.
- `internal-chain-live-fbb905ac-af19-44b2-90ff-62182f70d5ba/`: zero-call intermediate negative input-contract failure.
- `internal-chain-live.log` and `internal-chain-live-negative.log`: exact runner output. The latter reports the final focused success.

Run directories have mode 0700; artifacts and logs have mode 0600. All task-labelled PostgreSQL containers were cleaned. The tested/frozen private migration SHA256 is `1f6bd7dde9e8c67f3f1f50324db207fae77d097894a50d241e17a0f0fa103ff6`. Named functions deliberately reject privileged/API/service identities and membership in the function-owner role. Hosted MCP administration cannot substitute `SET ROLE` for authenticating a dedicated minimal LOGIN: runtime checks must use that LOGIN directly with verified TLS.

These results establish a bounded real-provider internal rehearsal. Production provider health, hosted authenticated runtime checks, paid-policy calibration and source activation remain separately sequenced by the parent. No downstream reader/consumer was added or exercised.

## Authorized hosted setup and authenticated permission checks

After the preceding rehearsals, the parent applied the exact tested private migration to the actual Myboon project, SHA256 `1f6bd7dde9e8c67f3f1f50324db207fae77d097894a50d241e17a0f0fa103ff6`. Dedicated `myboon_v4_worker` and `myboon_v4_research` LOGINs were provisioned with SCRAM credentials held in operator-owned private secrets. Credentials and password verifiers are not committed to the repository's password-free role migration. Existing facts and source databases were not modified.

The authenticated direct PostgreSQL probe completed at `2026-10-03T06:10:21.444Z`. All 12 checks passed: each real LOGIN used strict verified TLS with the authentic project CA and minimal role attributes; each successfully called the real bounded private context function against Micron/Silver catalogue rows; direct private table reads/writes and function-owner impersonation were denied; worker operational status returned no private records; and the Research context identity could not execute the writer function. The source tables, managed items, plans, leases, receipts and planning dispatches remain empty. This resolves the earlier missing-login/CA preflight gap without disabling TLS verification.

The evidence receipt is `/tmp/myboon-v4-live-20261003/hosted-private-permission-probe.json` (`passed: true`, `privateRecordsCreated: false`, `sourceOrLegacyRecordsModified: false`), with a corresponding private log. The parent verified exact identities and absent destination versions before rekeying only the two newly created migration-history entries from the MCP-assigned versions to repository versions `20261003090000` and `20261003090001`. No unrelated history entries were changed. The latter repository migration is `supabase/migrations/20261003090001_entity_manager_v4_dedicated_logins.sql`; it creates minimal dedicated identities, preserves compatible existing credentials and rejects elevated or administrative memberships. Its isolated regression results are recorded in the follow-up below.

V4 source workers remain stopped. Actual production provider/billing gates have not been cleared by the evaluation-only alpha route. The newly installed private schema and authenticated permissions establish storage capability; they do not establish production activation or downstream integration.

## Dedicated-login isolated follow-up — pause checkpoint

The already-running isolated suite completed after the user's pause request. It reported 28 tests: 26 passed and two failed (one focused case and its enclosing test). All preceding private migration/permissions/concurrency/crash/receipt tests passed again. New fresh-login and four incompatible-existing-role cases passed, including atomic rollback of the first LOGIN when the second has BYPASSRLS, CREATEROLE, service-role membership or executor ADMIN OPTION. Existing SCRAM credentials and role settings were preserved.

At the pause, the remaining failure was in the new test's exact membership-row assertion: PostgreSQL 17 retains equivalent membership grants from distinct grantors. The fixture pregrants as its superuser, then the hosted-equivalent non-superuser migration adds the same permitted executor membership under another grantor. The assertion incorrectly expected one physical row per logical membership. The observed rows had the same approved parent, ADMIN false, INHERIT true and SET true. No login-migration defect was established by this failure; its resolution after resume is recorded below.

The exact command was the explicit PostgreSQL integration command above, with output preserved at `/tmp/myboon-v4-live-20261003/postgres-dedicated-login-tests.log` (mode 0600). Exit status was 1, duration 33,105.158914 ms. All test-owned containers were cleaned by the fixture. No new tests, provider calls or hosted changes were started during the pause.

## Resumed validation — final database evidence

After the user resumed validation, the membership assertion was corrected without changing either SQL migration. It deduplicates logical grants across every ADMIN/INHERIT/SET option; a changed privilege remains a distinct row and fails the assertion. A separate check proves the fixture's two expected grantors and confirms that reapplying the login migration preserves the complete grantor-specific membership state. This validates the observed PostgreSQL behavior rather than ignoring unexpected grants.

The explicit PostgreSQL suite passed 28/28 tests, zero failed/skipped, in 42,205.880992 ms. Compatible existing SCRAM credentials and role settings survive application and reapplication; both authentic LOGINs execute their permitted named context function over verified TLS, cannot read private tables or impersonate the owner, and the Research identity cannot execute the writer. Fresh roles and all incompatible-role rollback cases also pass. Evidence: `postgres-dedicated-login-tests-resumed.log`.

The parent's live fixture then exposed a separate containment-harness defect under private shell umask 077: OpenSSL created the public certificate as mode 0600 owned by the host user, preventing the container's PostgreSQL UID from reading it. The fixture now explicitly sets only `server.crt` to 0644. The key remains mode 0600 owned by the container's PostgreSQL UID, and the mounted directory remains 0755. Certificate verification is unchanged. The complete 28-test suite passed again under umask 077, zero failed/skipped, in 37,421.063736 ms; evidence is `postgres-dedicated-login-tests-umask077.log`, with server artifacts `/tmp/myboon-v4-entity-AJBGTc`. Cleanup affects only each fixture's exact owned container/network; another lane's active live fixture is left alone.

```sh
umask 077
ENTITY_V4_RUN_POSTGRES_TESTS=1 pnpm --filter @myboon/collectors exec tsx --test src/entity-manager/postgres-knowledge-writer.integration.test.ts
pnpm --filter @myboon/collectors exec tsx /tmp/myboon-v4-live-20261003/hosted-private-permission-probe-resumed.ts
```

The existing authenticated hosted probe was rerun without changing credentials, roles, ownership, facts or processes. All 12 checks passed at `2026-10-03T07:57:59.981Z`, using the same authentic CA and dedicated identities. The original evidence is preserved; the new receipt/log are `hosted-private-permission-probe-resumed.json` and `.log`. A read-only catalogue check at `07:58:28Z` confirms repository migration versions 90000/90001, exactly the intended executor memberships with ADMIN false, no private-function execution for anon/authenticated/authenticator/service_role, and unchanged public counts: 1,653 entities and 47,598 memories. At `08:04:30Z`, exact counts for all 16 managed tables were zero, including sources, entities, evidence, history, expired or active leases and dispatch events. Evidence: `hosted-catalogue-recheck-resumed.json` and `hosted-private-counts-recheck-resumed.json`. Artifacts are mode 0600; credential values were never printed.

## Performance advisor disposition

The fresh hosted performance pass at `2026-10-03T08:01:26Z` reports 19 private unindexed-FK INFO findings and three private unused-index INFO findings, in addition to the existing public findings. The parent's combined advisor snapshot is `final-hosted-advisors.json`. No index, schema or unrelated public-security change was made in response.

| Finding group | Assessment from the actual named-function paths |
| --- | --- |
| Operation/work references in entities, items, evidence, item sources, memberships, history, receipts and dispatches | Child inserts check indexed parent primary keys. The writer has no DELETE grant/path and does not update referenced operation/work IDs; changing lease owner/epoch/expiry does not change its key. These findings do not establish a write-integrity or receipt-recovery defect. Reverse work/history queries and future maintenance may still need indexes at larger cardinalities. |
| `developments.to_item` and composite planning-dispatch-event references | Runtime successor queries use the existing `from_item` primary-key prefix. Events are appended; dispatch recovery addresses its indexed operation/attempt key. Incoming-link or event-history lookup performance is not established by this bounded rehearsal. |
| `entities.catalog_entity_id` | Current context joins fetch catalogue rows by their indexed ID. Future catalogue hard-deletion or primary-key changes must account for private references and may scan managed identities; ordinary alias/status changes do not change the referenced ID. This lineage constraint must be respected during catalogue maintenance. |
| Composite receipt operation/revision reference | The receipt's unique operation primary key already bounds an operation/revision lookup to at most one row. A second full-column index is not justified merely by this linter finding. |
| Three unused private indexes | Keep `managed_sources_native_refs` for source-reference GIN lookup, `managed_plan_attempt` for saved-plan recovery and `managed_memberships_entity` for Entity-to-item lookup. Zero observed use with all managed tables empty is not evidence that these runtime indexes are unnecessary. |

These are non-blocking for the demonstrated functional, privilege and TLS checks. They are not a throughput guarantee. Context counts/joins and operational aggregates can scan increasing history, even though returned payloads are bounded; the context/commit advisory lock makes long queries an operational latency risk. Representative-cardinality EXPLAIN/latency work is needed before claiming scale capacity or enabling hard-delete/retention maintenance. Statement timeouts limit database work, and durable dispatch/plan/receipt guards prevent paying again merely because a slow storage operation failed, but timeouts do not make the workload performant. This conclusion follows from the inspected implementation and [PostgreSQL's explanation of foreign-key indexing](https://www.postgresql.org/docs/17/ddl-constraints.html#DDL-CONSTRAINTS-FK), not from INFO severity alone.

Database migration compatibility and authenticated permissions are now validated. The parent owns integrated compiler/regression results and the newly approved Luna pipeline-route evaluation; this lane did not invoke providers after resume. Production workers/ownership remain unchanged, no downstream integration was added, and existing public security advisor findings remain separately recorded.

## Internal pipeline activation — initial database evidence

The user subsequently authorized restarting the internal pipelines while leaving the running API untouched. This database lane performs read-only hosted reconciliation and transport health checks; the parent owns process/configuration actions, and the operations lane owns source ownership and SQLite/outbox reconciliation. No credentials, roles, schema or existing facts were changed by these checks.

At `2026-10-03T14:01:44.324344Z`, an all-operation hosted snapshot found zero private source registrations, items, plans, holds, receipts and leases, including zero active or expired leases and zero dispatches in every state. The dedicated worker and Research LOGINs then passed all 12 strict TLS, real named-function and least-privilege checks again at `14:02:01.596Z`. The actual global, News and Polymarket status functions reported zero unresolved planning dispatches and zero managed records. Authentic CA verification remained enabled.

An expanded metadata-only snapshot at `14:08:16.243567Z`, transaction snapshot `729119:729119:`, also found zero managed identities, contexts, memberships, evidence and history. Its scope covers every private operation, including leases that have no source association. It distinguishes active/expired leases with accepted terminal receipts from unresolved leases; it records every dispatch state, hold history, source packet/readiness digest and terminal receipt digest when present. Results are bounded at 501 rows per detail array and explicitly report truncation; this observation was not truncated. There were no epochs or dispatches requiring reconciliation at either observation.

Private activation artifacts live under `/tmp/myboon-v4-activation-20261003` (directory 0700, files 0600):

| Artifact | SHA256 |
| --- | --- |
| `private-reconciliation-initial.json` | `b8c6402d7923bcd8906e039f85d8cb89ceeea86b2cf8d6c1a60d61022b1b03b2` |
| `private-transport-health.json` | `39383da50cfe9dd2194bdc6d9a0ab1128a7b792f2daab1a84465e9b96b187bb5` |
| `private-runtime-status.json` | `0ba57ef5cd1f88dd7a70d5dea179f7253d3b495aba6269719a0de173e206e705` |
| `private-reconciliation-preinitialize-metadata.json` | `36a3deae2a1beb61b45f3ec1eadf577ba20496f8ffda6ddfd5984089141a0a07` |
| `private-reconciliation-query.sql` | `5533a6d890fe4ad459dafdea25f7ddb81ea1544f02b1f9e5dfff3a5481741e2f` |

These are initial private database proofs, not a completed source-ownership transition. Ownership evidence must separately bind the actual source store/revision/receipt and independently establish source inflight, outbox and residual-reference obligations. A fresh private snapshot is required after initialization and before resume; monitoring after the parent starts workers will establish actual managed-write and accepted-receipt outcomes. No downstream consumer is involved.
