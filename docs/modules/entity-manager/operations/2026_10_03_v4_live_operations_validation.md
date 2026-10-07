# Issue 299 — actual source stores and runtime preparation

> Historical record for the 3 October implementation/validation phase. For the current article contract, scope and operating checkpoint, use the [working PRD](../PRDs/v4_prd.md) and [5 October handoff](2026_10_05_v4_entity_manager_checkpoint_handoff.md). These dated results do not establish the current profile/model settings or new article semantic quality.

Date: 2026-10-03. The owner authorized real tests, paid providers and actual databases as data sources. This lane performed runtime discovery, read-only actual-source inspection, bounded captured-source exports, genuine online backups/restores and schema rehearsals on restored copies. It did not start/stop workers, execute source ownership changes, replay historical work, publish anything or modify downstream code.

Private evidence directory: `/tmp/myboon-v4-live-20261003`, mode `0700`. Captured data and receipts are mode `0600`. No runtime credentials were printed or included in these artifacts. The unrelated repository-root `news.sqlite` was not opened or changed.

## Runtime identified

The local host is `srv1377229`, running the configured repository at `/home/ubuntu/myboon`. The current collectors environment points to `.data/news.sqlite` and `.data/pipeline.sqlite`, matching the production store paths and sizes documented by the September 29 VPS inspection.

Read-only current process-manager discovery found:

- `pm2-ubuntu.service` active; its already-running daemon and saved dump contain only `myboon-api`, online from `/home/ubuntu/myboon/packages/api/src/index.ts`.
- `pm2-root.service` inactive/disabled, with no live root PM2 daemon.
- Privileged `/proc` metadata inspection found no collector/shared Research/shared Entity script process. Raw command arguments and environments were not printed.
- Docker is running but has no running containers. Its metadata was inspected with `sudo -n docker ps`; no container was started.
- `/home/ubuntu/.ssh/config` is empty, so it supplies no alternate deployment alias.
- Existing Research and Entity runtime snapshots say `stopped`; their recorded process IDs are absent. Snapshot timestamps, including a recent Research snapshot, must not be presented as live health.

Runtime metadata is saved in `runtime-discovery.json`. All ten configured ecosystem entrypoint/cwd/interpreter paths were previously checked by the parent. World Cup remains a pre-existing missing collector with stale package scripts and no ecosystem app; no World Cup startup is claimed.

A separate pre-existing command-path problem affected the configured Editor process: ecosystem `HERMES_COMMAND=/root/.local/bin/mybooneditor` existed for root but was inaccessible to the current PM2 user, `ubuntu`. The parent corrected the ecosystem command to the invoking user's home directory. Read-only descriptor evaluation now resolves `/home/ubuntu/.local/bin/mybooneditor`, and existence/executable-access checks pass under Ubuntu. No process was changed; this is runtime configuration compatibility evidence, not a live Editor/provider success claim.

## Actual retained source state

Read-only SQLite URI connections used `mode=ro` and `PRAGMA query_only=ON`. Inventory is recorded in `source-inventory.json` and `source-retained-work-detail.json`.

| Actual source | News | Polymarket |
|---|---:|---:|
| Main file bytes | 1,238,822,912 | 362,901,504 |
| Canonical work rows | 26,729 | 4,687 |
| Complete work | 10,152 | 600 |
| Dead-letter work | 16,511 | 4,042 |
| Research pending | 62 | 45 |
| Synthesis pending | 1 | 0 |
| Entity pending | 3 | 0 |
| Saved shared worker leases | 0 | 0 |
| Native pending research | 28,267 | 287 |
| Saved native Research/Entity processing leases | 0 | 0 |
| Complete retained packets | 13,921 | 671 |
| Partial retained packets | 1,104 | 2,113 |
| Failed retained packets | 107 | 180 |

Every pending canonical item has an expired original freshness deadline. Native history is retained separately from the canonical queue; native pending rows must not be reported as canonical backlog. Polymarket's existing cleanup lease table has zero rows.

Neither actual store has the new V4 reservation, assignment-limit, research-record, ownership/receipt/activity, readiness, artifact pin/usage, retrieval-manifest or source-delivery-outbox tables yet. Missing payment-hold storage is unavailable evidence, not a verified zero unknown-outcome count. The 3,217 retained partial packets require the explicit D1 assessment/readiness path; startup must not infer full completion or create a historical replay from them.

Current safe policy metadata in `safe-runtime-policy.json` shows FEED_V3 Intake/Research/Entity active for News and Polymarket, legacy Research/Entity disabled-source declarations, `phase1` cutover policy, light-only depth, deep disabled and triage classifier disabled. The actual root/collectors environment has no V4 feature controls, reviewed V4 numeric policies or dedicated private PostgreSQL connection configured. Existing active flags alone do not authorize V4 ownership activation.

The actual read-only status command completed successfully:

```sh
cd /home/ubuntu/myboon/packages/collectors
pnpm exec tsx src/signal-platform/run-v4-status.ts
```

Output is saved in `actual-source-status.json`. Both sources report partial availability: work counters are available; readiness and reservations are unavailable; ownership has no durable row; managed writer is disabled. This is observed baseline status, not startup health.

## Captured-source exports

`source-cases.json` contains eight News and eight Polymarket examples read from the actual canonical Signal/Evidence/Research tables. `internal-chain-source-cases.json` contains two selected small captures for the parent's live internal-chain rehearsal.

Every case preserves its original Signal/work/packet IDs, native payload reference, title, public URL, publication/observation/capture timestamps, saved packet claims/limitations/entity hints and exact selected retained evidence text. The selected body is exported without additional truncation. Coverage explicitly records the original capture's truncation flag and that full article completeness has not been independently verified. One evidence record is selected per case; additional retained evidence may exist.

The selected News example is a Micron/Nasdaq social-news observation captured September 27; the selected Polymarket example is a Silver downside contract capture from September 18. The Polymarket watchlist's current native row is mutable; its current timestamp is clearly distinguished from the immutable original captured Signal material. These are historical captured inputs for a new isolated observation, not fresh collection evidence.

Natural semantic reviewer labels remain null. The evaluation lane can construct independently reviewed duplicate/correction/incomplete paired cases from these original captures, while ambiguous natural predictions remain observational. No model output was used to fabricate expected novelty or correction labels in this export.

## Genuine backup and restore

The product backup helper previously opened its source with write access. It now uses `DatabaseSync(..., {readOnly:true})`, confirmed by the installed Node SQLite type documentation and successful runtime execution. Online backup does not initialize source schema or create a mistyped source database. WAL readers can still require SQLite shared-memory sidecars in a writable source directory; a fully read-only directory is supported by the tested rollback-journal snapshot fixture.

Focused regression command:

```sh
pnpm exec tsx --test src/pipeline-store/backup.test.ts src/signal-platform/v4-sqlite-upgrade-restore.test.ts
```

Result: **21 passed, 0 failed, 0 skipped**. Added meaningful cases cover a read-only source file/directory with preserved source bytes/write timestamp and missing News/Polymarket source paths that are never created. Log: `read-only-backup-regression.log`.

Actual operation command:

```sh
/home/ubuntu/myboon/packages/collectors/node_modules/.bin/tsx /tmp/myboon-v4-live-20261003/run-source-backups.ts
```

This script invoked the real product online backup, manifest verification against source counts and restore functions. Both sources passed integrity and restore verification. Original main-file size and write timestamp remained unchanged; no source SQL write was executed.

| Source | Verified backup | SHA-256 |
|---|---|---|
| News | `backups/news-2026-10-03T05-41-09-765Z.sqlite` | `acf8ad25aa6453fcbb7db2cbf15580a4bdd56c55b37c00b13f9a15f7da1d7360` |
| Polymarket | `backups/pipeline-2026-10-03T05-45-15-167Z.sqlite` | `5b48028a698b1c9efa6aded9a6c18acc6248bf3f2cb0bb4715868b9028d99c09` |

Paths are relative to the private evidence directory. Both backups have v2 manifests. Detailed source counts, schema digests, verification results, before/after file metadata and restore results are saved in `source-backup-restore-receipt.json`; execution output is in `source-backup-restore.log`. Original-schema restored files were then upgraded only as described below. The verified backup files preserve the unmodified pre-upgrade source state.

## Actual-schema upgrade rehearsal on restored copies

```sh
/home/ubuntu/myboon/packages/collectors/node_modules/.bin/tsx /tmp/myboon-v4-live-20261003/upgrade-restored-copies.ts
```

The current native News/Pipeline stores and source-specific canonical store were initialized against `restored/news.sqlite` and `restored/pipeline.sqlite` only. Production paths were never passed to a schema initializer.

Results in `actual-copy-schema-upgrade-runtime.json` and `actual-copy-schema-upgrade-verification.json` show:

- All 11 pre-existing News tables and 15 pre-existing Polymarket tables retained their exact row counts.
- SHA-256 comparisons of the first and last 32 primary-key ordered rows per table, projected to every original column, matched the actual source.
- `PRAGMA foreign_key_check` found zero failures in both upgraded copies.
- Additive reservation/assignment, saved-research, readiness, artifact and retrieval tables were created empty.
- The native source outboxes were empty: no historical delivery obligation was fabricated.
- Source ownership, receipts and tracked operation tables remained absent: startup did not manufacture authority or execute an activation.
- No queue promotion, provider dispatch or worker start occurred. The historical pending/completion states remained retained.

The original files were read again for this comparison using read-only/query-only connections. Backup integrity and exact restore digest validation establish the full pre-upgrade snapshot; the post-upgrade checks above are counts and bounded row samples, not a claim of exhaustive semantic evaluation of all historical research.

## Remaining activation boundaries

These backups and copy rehearsals are actual technical evidence, but they are not a signed source ownership approval receipt. The parent still sequences real provider decision results, hosted private-writer schema/role/TLS gates, explicit source-scoped policies, reviewed stopped-worker/reconciliation proof and bound ownership receipts. News must activate first. PostgreSQL in-flight leases and planning dispatches require independent actual-epoch reconciliation; zero SQLite leases cannot prove that boundary safe.

The source authority initialization must preserve historical work and pause admissions/claims before any switch. Pending/partial history is retained for explicit recovery/assessment, not automatically requeued or promoted. No deployment, restart, retirement or historical deletion has been performed by this lane.

## Dedicated private PostgreSQL transport preflight

Read-only inspection at **2026-10-03 05:59 UTC** confirmed that this server can reach the project's direct PostgreSQL endpoint with verified TLS. Neither database authentication nor SQL execution was attempted in these transport checks. No role, password, SSL enforcement setting, runtime configuration or worker was changed.

Supabase MCP project metadata identifies `rrdvpdgebygfdstwknqc` as `myboon`, region `ap-northeast-1`, status `ACTIVE_HEALTHY`, with PostgreSQL `17.6.1.084`. The project's direct host is `db.rrdvpdgebygfdstwknqc.supabase.co`. DNS returned only IPv6 (`2406:da14:271:9919:4625:9129:6370:644`). This VPS has a global IPv6 address and default route; TCP port 5432 and PostgreSQL SSLRequest succeeded.

The initial TLS attempt with the machine's default trust store failed with certificate verification code 19, `self-signed certificate in certificate chain`. That is a trust configuration gap, rather than an IPv6 connectivity failure. Supabase documents downloading its root certificate from Database settings and configuring both certificate and hostname verification. [SSL enforcement documentation](https://supabase.com/docs/guides/platform/ssl-enforcement)

The CA was downloaded over verified HTTPS from the exact production URL referenced by the official Supabase Studio `ssl:certificate_url` configuration: `https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt`. Its provenance is recorded against [the official Studio source](https://github.com/supabase/supabase/blob/master/apps/studio/hooks/custom-content/custom-content.json), rather than trusting a certificate copied from the database handshake.

| Evidence | Result |
|---|---|
| Downloaded CA | `supabase-prod-ca-2021.crt`, mode 0600 |
| CA SHA-256 | `700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7` |
| Python TLS verification | Required CA verification and hostname checking succeeded |
| Node `v24.18.0` TLS verification | `rejectUnauthorized: true`, explicit CA, matching server name; `authorized: true` |
| Negotiated transport | TLS 1.3, `TLS_AES_256_GCM_SHA384` |
| Peer certificate | CN and DNS SAN `db.rrdvpdgebygfdstwknqc.supabase.co`; valid through March 4, 2031 |
| Database authentication / SQL | Neither attempted |

Private evidence files are `supabase-studio-ca-provenance.json`, `supabase-direct-tls-preflight.json` and `supabase-node-tls-preflight.json`, all mode 0600 in the existing private evidence directory. These checks sent PostgreSQL SSLRequest followed by TLS negotiation only, without a database startup/authentication payload. They establish authenticated transport, not the permissions or health of a future dedicated LOGIN.

For this persistent IPv6-capable worker, the supported connection is the direct host on port 5432. The existing application-side `pg` pool already caps each writer instance at four connections. A shared session pooler on port 5432 is the supported fallback for an IPv4-only host; transaction pooling on port 6543 targets short-lived/serverless clients and restricts prepared statements and session state. No pooler or IPv4 add-on is needed for this VPS. [Connection methods](https://supabase.com/docs/guides/database/connecting-to-postgres)

The exact shared pooler shard cannot be inferred from region alone. If a different deployment requires it, obtain its host from the project's Connect dialog; a custom LOGIN uses `<login>.rrdvpdgebygfdstwknqc` through the shared pooler. The current MCP project metadata did not supply that host, so no guessed pooler endpoint is treated as project-bound evidence. [Pooler host and username troubleshooting](https://supabase.com/docs/guides/troubleshooting/tenant-or-user-not-found)

The connection/configuration recipe for the parent's later provisioning step is:

```text
MYBOON_MANAGED_KNOWLEDGE_DATABASE_URL=postgresql://<dedicated-login>:<percent-encoded-new-secret>@db.rrdvpdgebygfdstwknqc.supabase.co:5432/postgres
MYBOON_MANAGED_KNOWLEDGE_DATABASE_CA=<actual PEM contents of the verified Supabase CA>
```

The CA environment value is PEM content, not a file path. The private writer rejects SSL URL query parameters and always uses `ssl: { rejectUnauthorized: true, ca }`; no verification-disabling option is needed. A dedicated LOGIN should receive only the migration's `myboon_knowledge_executor` membership for worker operations, or only `myboon_knowledge_context_executor` for a separate context-only client. These are isolated NOLOGIN capability roles, exposing named private functions while retaining table permissions on the NOLOGIN owner. The private worker must not use a browser, service, admin or database-owner login. [Custom PostgreSQL roles](https://supabase.com/docs/guides/database/postgres/roles)

Supabase supports custom LOGIN roles on direct and pooled connections without separate pooler registration. The parent can provision a new minimal LOGIN and grant the required capability using additive DDL after its live gates; there is no need to reset the project's main database password. The parent plans to persist a locally generated SCRAM verifier in role DDL, keeping the actual new secret and DSN only in private mode 0600 configuration. This lane has not executed that provisioning or verified authenticated function permissions. [Custom role connection support](https://supabase.com/docs/guides/troubleshooting/fatal-password-authentication-failed)

The required Supabase changelog scan was saved as `supabase-changelog-summary.md`. Its relevant September 25 PostgreSQL minor-update/security entry does not change the observed IPv6, TLS or pooler selection above. No database upgrade was performed. Remaining gates are authenticated dedicated-role verification, actual hosted private schema/functions, reviewed policy and ownership receipts, source pause/reconciliation, and the parent's provider readiness decision. Successful TLS alone does not authorize restart.

## News-first activation preparation and current hosted gate

The parent subsequently applied the additive hosted private schema and provisioned separate minimal worker/context LOGINs. Its authenticated direct TLS/private-function probe passed **12/12** at 06:10 UTC, recorded in `hosted-private-permission-probe.json` and its companion log. Worker/context capabilities succeeded; direct table read/write, owner role switching and context-only writer-function access were denied. The parent confirmed the legacy public catalogue counts remained 1,653 entities and 47,598 memories, with no private source/item/receipt records created by that permission probe.

The provisioned DSNs and authentic CA are in `/home/ubuntu/.config/myboon/private-knowledge-v4.env`, mode 0600. This lane references that path without reading or printing its secrets. Those credentials have not been loaded into actual production runtime flags. The same existing `MYBOON_MANAGED_KNOWLEDGE_DATABASE_URL` contract is overridden separately per PM2 process: shared Entity gets the worker LOGIN; shared Research gets the context-only LOGIN. Both get PEM CA content. The News collector gets neither DSN. No new global URL or loader field is required.

Activation preparation is saved in `/tmp/myboon-v4-live-20261003/activation-preview/`, mode 0700; artifacts are mode 0600. The source inspection command was:

```sh
/home/ubuntu/myboon/packages/collectors/node_modules/.bin/tsx /tmp/myboon-v4-live-20261003/activation-preview/capture-news-preflight.ts
```

It read the original News database and the already-upgraded restored copy using read-only/query-only connections, inspected the existing PM2 daemon and known source/shared/legacy entrypoints in `/proc`, and exercised the actual ownership operator's read-only preview with unreviewed draft evidence. It did not initialize source authority, alter source tables/flags, call a provider or change a process. Original main-file size and write timestamp remained unchanged.

The refreshed 06:16 UTC snapshot records:

| Required evidence | Actual original News | Upgraded restored copy |
|---|---|---|
| Durable ownership | Absent | Absent |
| Pending source deliveries | Unavailable: table missing | 0 |
| Shared leases | 0 | 0 |
| Legacy Research in flight | 0 | 0 |
| Legacy Entity in flight | 0 | 0 |
| Unknown paid outcomes | Unavailable: table missing | 0 |
| Reserved, not dispatched | Unavailable: table missing | 0 |
| Tracked source operations in flight | 0; tracking not initialized | 0; tracking not initialized |
| Fresh pre-activation pending work | 0 | 0 |
| Signals missing current-policy decision | 0 | 0 |
| Owed frozen active-admission repairs | Unavailable: table missing | 0 |

PM2 still contains only the online `myboon-api`; no process matches any configured News/Polymarket collector, shared Research/Entity or known legacy source-specific Research/Entity entrypoint. This is a stopped-source snapshot, not a healthy running-worker observation window. Actual managed PostgreSQL epochs, leases and planning dispatches must be freshly reconciled after any isolated live-chain work; the earlier permission probe does not substitute for that proof.

The native 28,267 pending News observations and 66 expired canonical pending items remain retained. Scheduler lookup and the transactional claim both exclude expired freshness deadlines. Additive schema initialization creates an empty outbox/admission ledger rather than fabricating delivery obligations for that history. D1 retained-partial assessment, retry/recovery and any deliberate historical replay remain separate explicit work; none are activation commands.

There is a specific admission repair boundary to preserve: each News poll calls `retryUntriaged(25)`. A missing decision under a changed triage policy can re-evaluate an old Signal using a newly calculated freshness deadline. The actual 27,268 News decisions all use the currently implemented `feed-v3.rules-first.v1` and `feed-v3.research-budget.v1`; there are zero missing decisions under those versions. Before starting the collector, require that count, owed active admissions and fresh pre-activation work to remain zero. Do not change those old triage policy versions as part of V4 activation; the V4 policy has its own version. If these counts drift, hold startup until a deliberate disposition is reviewed. The current source ownership ledger alone does not create a historical-admission cutoff.

Preparation files include:

- `read-only-preflight.json`: actual/copy counters, selected PM2/process metadata, runtime-control state, hosted permission receipt hash and remaining blockers.
- `candidate-nonsecret-env.json`: News-only policy/feature profile, explicit numeric ceilings and its real secret-free runtime configuration digest. It is marked unapproved; provider health is unavailable.
- `initialize.receipt.draft.json` and `resume_shared.receipt.draft.json`: five hashed draft evidence bindings each, all explicitly `passed:false`. Resume binds the future executed initialize receipt, rather than claiming it already exists.
- `unreviewed-initialize-preview-result.json`: the real read-only operator rejected the draft with `Ownership backup_restore evidence is invalid or not reviewed`. No source authority was initialized.
- `upgrade-news-schema-later.ts`: prepared future additive schema command, requiring explicit apply and fresh reviewed stopped-worker health evidence; not executed.
- `run-reviewed-news-ownership-later.ts`: prepared wrapper loading the parent's future private per-process config without logging its environment; ownership preview is default, apply explicit; not executed.
- `future-command-sequence.md`: exact preparation, preview/apply, ordered PM2 startup and rollback commands, with actual reviewer/approved-receipt fields clearly pending.

The candidate fixture envelope is root-assignment **8 calls / 100,000 input tokens / 20,000 output tokens**, synthesis **20,000 / 4,000**, and one follow-up synthesis **20,000 / 4,000** with **2 sources / 20,000 total bytes / 10,000 per source / 5 seconds**. Reuse ages are proposed at 24 hours. These are explicit candidate limits drawn from the meaningful structural fixture coverage; actual paid synthesis/Entity-chain evidence and the parent's reviewed selection still determine the released profile. The assignment ceiling covers aggregate novelty, primary and follow-up exposure; it does not replenish a budget per stage. Dollar ceilings are explicitly `unknown`, with cost reported as unknown rather than zero. No additional monetary approval gate is introduced by this preparation.

The production provider failures remain material: primary Ollama returned HTTP 403 and the named OpenRouter Deepseek health route returned HTTP 402. An evaluation-only alpha route has not been approved as an equivalent production route. The parent must release a working route and attach the actual live decision/internal-chain evidence before health can be declared healthy or any source worker started.

The concrete future ownership order is **additive source schema preparation → initialize revision 1 paused → fresh resume_shared receipt → running revision 2 with collector/intake/research/entity all shared and legacy queue disabled**. Both operations require the actual original store ID `f8b556bac6087a78c29b19bbc2bda6bf11475351d36d4eb797db69f284d08154`, current reviewed configuration digest and artifact hashes. Health/reconciliation artifacts bind the current executed revision and receipt ID. Resume additionally requires every available SQLite obligation to be zero plus independent managed PostgreSQL lease/planning-dispatch reconciliation evidence. A preview receipt for a restored path cannot authorize the original source path.

The prepared post-gate PM2 startup sequence is intentionally limited to the exclusive shared Entity worker, shared Research worker and News collector, in that order:

```sh
pm2 startOrRestart /tmp/myboon-v4-live-20261003/activation-preview/news-first.ecosystem.private.cjs --only myboon-feed-v3-entity-manager --update-env
pm2 startOrRestart /tmp/myboon-v4-live-20261003/activation-preview/news-first.ecosystem.private.cjs --only myboon-feed-v3-research --update-env
pm2 startOrRestart /tmp/myboon-v4-live-20261003/activation-preview/news-first.ecosystem.private.cjs --only myboon-news-feed-ingestor --update-env
```

The parent has not yet written that private active ecosystem file; the commands are future instructions, not executed actions. Polymarket and legacy source-specific claimers remain inactive. Existing Editor/Publisher/X Desk are not wired into managed knowledge and are not included in this activation subset. Their separately mocked compatibility checks do not constitute provider readiness or permission to publish.

Rollback preparation requires a current source pause receipt, worker stop/drain and independent SQLite/PostgreSQL reconciliation, followed by a separate reviewed `resume_legacy` receipt before legacy workers may run. Restoring the original-schema backup is not an automatic undo of private PostgreSQL operations or an authorization to replay history. No retirement, production restore, ownership switch, worker start/stop or source schema upgrade was performed by this lane.

The parent compiler feedback also identified an unsupported static `node:sqlite` import in the new read-only backup test. It was replaced by the existing typed `createRequire(__filename)` constructor pattern, with no production typing changes. Focused command `pnpm exec tsx --test src/pipeline-store/backup.test.ts` passed **18/18**, with zero failures or skips. This lane's source/test file is frozen again; the parent owns the final compiler run.

## Final resumed validation: Luna route and read-only operations

The user resumed validation after the credential pause. This final section supersedes the earlier Ollama/OpenRouter route blockers. The actual collectors configuration now selects `INFERENCE_GATEWAY_PRIMARY_PROVIDER=openai-codex`, `INFERENCE_GATEWAY_PRIMARY_MODEL=gpt-5.6-luna` and `INFERENCE_GATEWAY_HERMES_PROFILE=myboonv4codex20261003`. The route matches the actual completed health and adapter usage receipts. The profile is selected for the pipeline; validation fixtures retain their own evaluation authority.

The parent completed its full live Luna internal-chain/recovery checks, bound here to `internal-chain-live-c60161fe-8d30-4b04-b298-3e34ca95bd42/summary.json`. That summary records all three expected case outcomes, five main Hermes calls, zero auxiliary calls and zero Jev calls, with News/Polymarket receipt-first recovery requiring no new paid call and an unrelated-content negative case. Its exact metadata remains `evaluationOnlyRoute:true`, `hostedWrites:false`, `gatewayUsageKind:adapter_estimated` and full-article completeness unverified. These are actual paid model calls with captured source material and isolated managed writes; they do not claim production queue execution or hosted managed writes. The separate hosted private-role probe remains 12/12 with no private records created. The parent/Maya own the broader 80-response Luna quality report; transport/operator success does not infer semantic approval.

The required remaining read-only operations were executed with:

```sh
/home/ubuntu/myboon/packages/collectors/node_modules/.bin/tsx /tmp/myboon-v4-live-20261003/activation-preview/capture-news-preflight.ts
/home/ubuntu/myboon/packages/collectors/node_modules/.bin/tsx /tmp/myboon-v4-live-20261003/activation-preview/validate-read-only-commands.ts
/home/ubuntu/myboon/packages/collectors/node_modules/.bin/tsx /tmp/myboon-v4-live-20261003/activation-preview/verify-existing-backups.ts
```

Actual source/PM2 refresh still finds only the online API and no configured source/shared/legacy claimant process. Both original ownership ledgers remain absent. News retains 66 expired pending canonical items; Polymarket retains 45. Both have zero fresh historical pending work and zero Signals missing the currently implemented triage decision policy. The upgraded copies retain zero source delivery, lease and reservation obligations and zero owed active admissions. Original missing-table counters remain unavailable, rather than zero. Runtime-control revision 12 remains running for Research and Entity, with its exact bytes unchanged.

The actual command validation passed **25/25** checks: **21 expected gate refusals** and **four successful read-only operations**. The expected refusals cover every enabled-but-uninitialized source/domain/owner gate, unreviewed evidence, a mismatched source, an expired receipt and missing explicit approved inputs to the prepared future helpers. The successful operations are two runtime-control drain dry-runs and status inspection of the original and upgraded-copy stores. These refusals are the intended paused/uninitialized activation boundary, not pipeline defects. `read-only-operator-validation.json` and command stdout/stderr files record the exact results. Source/copy main-file metadata and runtime-control bytes remained unchanged; no source authority was initialized.

The existing real News/Polymarket backups passed the product verifier again: integrity, manifest hashes and inventoried source counts all matched. `existing-backup-revalidation.json` records both successes. Original main-file metadata, complete table-name sets and every previously inventoried table count still match the baseline. Polymarket's zero-row native cleanup lease table was already present in the original inventory and remains retained; it is outside the legacy manifest's selected native-table count list. No new backup, restore or upgrade rehearsal was needed or executed because the inputs were unchanged. Earlier actual restore/copy-upgrade evidence remains applicable.

`activation-preview/final-operations-readiness.json` binds these technical results to the parent's frozen **675-file** candidate and runtime inputs:

| Frozen input | SHA-256 |
|---|---|
| `final-luna-candidate.json` | `3e50fa72a40eed6f97bd1d58272752677bf10ef8fe5aac499667e23ca577dafa` |
| `final-luna-candidate.tar.gz` | `712ae0a1795891d0eb96c75c3c1cb8a34d17e4384ca8ec1141dd8552cb69c5e5` |
| `final-luna-runtime-inputs.json` | `3e2690a01f6eb06be810692272e3a4c571af5628958d4e62f270cb8995f1743f` |

The manifest excludes mutable validation documentation, credentials, databases and unrelated user files. Runtime input evidence records the nonsecret Luna profile/hash and installed Codex transport hash. There is a concrete transport limitation: the installed Codex subscription backend omits `max_output_tokens`; profile `max_tokens:4096` is therefore **not a native hard output clamp**. Application estimated exposure budgets, call/time limits and durable holds remain distinct controls. No hard native output-token bound is claimed.

Technical operations validation is complete, with no required check unfinished in this lane. Production activation remains a separate operational step: select/review the final numerical policy, prepare the original News additive schema with stopped-worker evidence, freshly reconcile actual SQLite and private PostgreSQL epochs/leases/planning dispatches, approve and execute source-bound initialize/resume receipts, stage per-process credentials and explicitly start shared Entity, shared Research and News collection. The earlier exact command sequence remains prepared for that step. Draft approval evidence remains `passed:false`; this technical readiness record does not sign or execute ownership authority.

All operations artifacts/report are frozen after this append. No original source schema, production flag, ownership row or process was changed; no historical replay or downstream integration occurred. The parent owns the completed integrated tests/compiler and the consolidated final evidence manifest.
