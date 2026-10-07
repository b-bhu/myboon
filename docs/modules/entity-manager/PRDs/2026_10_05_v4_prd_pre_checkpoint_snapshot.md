# Historical V4 PRD snapshot — before the 5 October checkpoint

This preserves the working PRD immediately before its 5 October 2026 rewrite.
The [current V4 working PRD](v4_prd.md) and [checkpoint handoff](../operations/2026_10_05_v4_entity_manager_checkpoint_handoff.md) supersede its scope/status instructions for new work. Claims/evidence contracts and deferred-activation statements below describe their original date; D1/D2 and compatibility detail remain historical design context.

---

# Entity Manager V4 — Working PRD

Date: 2026-10-04
Status: article-based Researcher implementation complete and source-reviewed (§11); behavioral/TypeScript/database validation deferred. Earlier validation records describe the preceding claim/evidence contract.
Parent: [#299 — Entity Manager V4 implementation](https://github.com/b-bhu/myboon/issues/299)
Local implementation: `main` in `/home/ubuntu/myboon`, based on pushed `3e750f3`; current-pass changes saved locally without committing or publishing.
Owner: myboon product / Entity Manager

This is the canonical working document for V4. It consolidates the #299 issue body, the reviewed PRD snapshot embedded in it, the four chronological issue comments (investigation, owner decisions D1/D2, phase labels, preparation checkpoint), and the current local implementation. Where older text conflicts with this document, this document defines V4.

---

## 0. Authorization state and what this document is not

### Current article-based implementation instruction — 2026-10-04

The owner approved the article-based work list in §11 and asked the parent to orchestrate an implementation agent using `gpt-5.6-terra` with high reasoning. This revision removes formal claims and evidence from new Researcher outputs and from their readiness, handoff, Entity Manager and database-validation path. Captured article text, source identity/URL and dates remain the source provenance. Historical contracts remain readable; they are not the contract generated for new articles.

This is a local implementation pass. No test suite, build, TypeScript check, paid runtime evaluation, database mutation, migration application, pipeline restart or historical replay is performed in this pass. Source inspection and diff review establish code connectivity; behavioral validation remains a later phase. The stopped pipeline processes stay stopped and `myboon-api` is outside the changes. No API, UI, publisher, X Desk or downstream-reader integration is included.

This section and §11 supersede earlier claim/evidence requirements and older execution-phase instructions for the new article workflow. Earlier implementation, validation and activation records below remain historical evidence for their own contract and date.

### Current validation authorization — 2026-10-03

After completing the implementation-only pass and its final TypeScript check, the owner accepted the five-phase validation plan: freeze the candidate; run parallel isolated implementation/database/recovery tests; evaluate Jev against Hermes; rehearse the full internal pipeline; then perform production preflight and a staged restart once the preceding gates pass. Tests, test-file changes, fixes and database rehearsals are now authorized. The earlier no-tests instruction applied to the completed coding pass, not this validation phase.

The owner explicitly authorized real Jev/Hermes calls and the actual database as a validation data source, without a dollar budget gate. Actual database inspection, captured-data exports, source backups and restored-copy rehearsals are underway. The deployment host is the current VPS, with PM2 under the Ubuntu account. Production setup/restart still depends on validated configuration/ownership evidence and successful release gates. No production flags, databases or workers were changed during the initial offline lanes. Downstream integration and historical bulk replay/deletion remain excluded. This authorization supersedes earlier paid-call restrictions retained below as history.

Validation record: [2026-10-03 validation and restart gates](../operations/2026_10_03_v4_validation_record.md).

### Completed implementation instruction — 2026-10-03

The owner authorized parallel local implementation with Leo (managed storage / Entity), Maya (Research / spending), Nora (recovery / ownership / operations), and the parent orchestrator. The effective scope is **Scout → Intake → Research → Entity Manager → durable shared knowledge**.

**All downstream integration is deferred until after #299.** No production knowledge-reader framework, consumer checkpoints, V1 managed-item projection, Editor, Publisher, X Desk, API, or browser integration is part of this implementation. Research's narrow existing-knowledge consultation and Entity's internal grounding/context queries remain internal pipeline responsibilities. Managed items stay in private additive storage and are not exposed through existing publishing paths.

**Implementation only:** do not run tests, builds, TypeScript checks, database rehearsals, runtime probes, or pipeline checks during coding. Run the TypeScript check only after all implementation is in place. Behavioral tests, database validation, paid evaluation, pipeline inspection, migration application, and restart belong to the later owner-directed validation/activation phase. No test files are added or changed in this implementation pass.

This scope and execution policy supersede conflicting historical stage descriptions and acceptance requirements below. No deployment, production database mutation, paid execution, worker restart, historical replay, deletion, or remote publication is authorized by the current coding request.

The implementation baseline is pushed `main` at `3e750f3`. Older dated implementation and verification records below are historical evidence, not the status of the current coding pass.

### Earlier authorization history

**Authorized on 2026-10-01, by the issue owner directly in the current Codex/Hermes session: full local implementation.** The owner subsequently requested that the issue changes be committed into the local main worktree and that an implementation handoff be posted to #299.

That supersedes the earlier comments which said implementation was not authorized (2026-09-30 preparation checkpoint: "Implementation: Not started or authorized").

It does **not** authorize:

- deployment of anything;
- any production data change or production database write;
- paid Jev or follow-up activation, or any paid provider workload;
- worker restarts;
- historical backlog replay;
- deletion of any data;
- GitHub label changes, PR creation or remote merge, or issue edits beyond the requested handoff comment;
- pushing branches or publishing work externally.

The owner separately authorized an **isolated compatibility/database rehearsal**. A partial synthetic PostgreSQL 15 experiment was run and its disposable database removed (§6.5). That authorization did not extend to production schema inspection or data access.

Local commits keep implementation slices reviewable. Commits `efc12ae` and `44f02d4` are on local `main`; all work remains unpushed.

Root checkout `/home/ubuntu/myboon` (branch `main`) also holds unrelated user changes — modified `.codex/agents/{leo,maya,nora}.toml`, untracked `.github/` and `news.sqlite`. Those remain untouched. V4 commits were fast-forwarded into local `main`; the isolated worktree remains available.

Every "not authorized" statement elsewhere in this issue or its comments describes a *different, earlier* authorization moment. Where those conflict, this section is the current one and the other text is retained only as history. The three failing tests in §6.4 are unrelated to authorization; they are an expired review policy.

---

## 1. Source-of-truth scope from #299

### 1.1 Problem

Scout → Research → Entity Manager already has durable work records and entity memories, but handoffs can leave accepted decisions without their next job, retries can repeat paid planning, and useful attributed research can be rejected solely because it is labelled `partial`. Existing knowledge checks exist in the legacy Polymarket path but are not connected to shared Research. Evidence and research are not reused across both sources through the intended shared contract.

Entity knowledge also needs one coherent, sourced item serving several legitimately involved entities and independent teams, with linked developments, preserved history, and recoverable writes.

### 1.2 Goal

Complete useful work with less repeated reasoning, preserve Research's authority over its handoff, and persist reusable entity knowledge with reliable provenance and history. Downstream knowledge exposure is a separate follow-up.

### 1.3 Storage model

- **SQLite is the working desk.** Observations, jobs, ownership, saved research, evidence references, Research spending reservations, retries, required next actions. News and Polymarket keep separate local database files under shared worker contracts. V4 does not move internal job polling into Supabase.
- **Private PostgreSQL is the managed knowledge library.** Accepted managed entities/items, provenance, history, plans, leases, holds and receipts share the writer's transaction domain. Existing Supabase memory tables and publishing inputs remain separate. See §9 for the adaptation from the original snapshot's generic plan-storage description.
- **A timer is a reminder to check the desk.** A stage finishes only when its result and required next action, or a deliberate no-action outcome, are saved safely.

### 1.4 Scope decisions against the original seventeen items

| # | Original improvement | V4 decision |
|---|---|---|
| 1 | Scout discoveries reliably reach canonical intake | **Include.** Persist delivery responsibility with the observation; recover an unchanged observation whose earlier delivery failed. |
| 2 | Intake decision and required research work saved together | **Include.** One local transaction, or a durable acknowledged handoff where a boundary is crossed. |
| 3 | Wake deferred signals when they become eligible | **Exclude.** No new automatic reconsideration, stale-work catch-up, or deferred-signal scheduler. Existing bounded transport retries and lease recovery remain. |
| 4 | Check existing knowledge before research spend | **Reuse and connect.** Shared News/Polymarket Research now composes the existing gate with bounded legacy and private managed context; code implemented, behavioral validation deferred. |
| 5 | Finish Jev integration into the shared pipeline | **Include a bounded, feature-gated slice.** Wire evaluated novelty and the follow-up decision through existing classification infrastructure. Do not activate every future Jev workload. |
| 6 | Consolidate inference configuration and operating controls | **Exclude.** Reuse existing configuration, budgets, routing, audit. No gateway/control-plane consolidation. |
| 7 | Separate narrow decisions from prose generation | **Include.** Jev for suitable judgments; code for mechanical limits; generative model through Hermes for investigation, interpretation, writing. |
| 8 | Define all decision rules once across models | **Exclude the broad refactor.** A specific V4 workload still needs a versioned definition and compatible fallback in the existing registry. |
| 9 | Reuse Entity Manager plans and commit receipts | **Include.** Checkpoint accepted plans and resolve prior commits before paying for another plan. |
| 10 | Reuse evidence and research across jobs | **Include across News and Polymarket.** Reuse suitable saved material while preserving each source's context and researching new information. |
| 11 | Retire legacy queue bookkeeping | **Include controlled retirement.** Establish one owner, reconcile records, preserve source/history data, prove rollback, then retire obsolete queue writes and claims. |
| 12 | Make sources easy to plug in | **Design consideration for the two existing sources** (News, Polymarket). No new collectors, no separate source-framework rollout. |
| 13 | Separate content meaning from collection provenance | **Include.** Distinguish what was said from who published, discovered, or collected it. |
| 14 | Controlled Entity-job concurrency | **Exclude.** No worker-pool/throughput project. |
| 15 | Consolidate repeated entity-memory lookups | **Exclude.** Required new context reads are in scope; a general query-consolidation/N+1 project is not. |
| 16 | Optimize incremental maintenance | **Exclude.** Preserve existing maintenance safeguards. |
| 17 | Keep deferred capabilities outside this upgrade | **Scope rule.** New X/exchange collectors, deep-research activation, mandatory story-thread objects, ontology expansion, automatic entity merges, historical rewrites, public feed redesign stay out. |

Active feature scope: **1, 2, 4, 5, 7, 9, 10, 11, 13**. Item 12 guides design; item 17 constrains it. Excluded workstreams: **3, 6, 8, 14, 15, 16**. Necessary correctness checks do not authorize those broader projects.

### 1.5 Exclusions preserved verbatim in intent

Separate redirect/auth/runtime findings, historical backlog replay, production data deletion, new X/exchange collectors, deep activation, broad ontology work, and public feed redesign remain outside this issue. The owner additionally deferred all downstream readers/consumers, checkpoints, projections, Editor, Publisher, X Desk, API, and browser changes. Nothing in this session authorizes any of them.

### 1.6 Responsibilities

**Research owns research judgment and what it hands over. Entity Manager treats that as authoritative research input.** Entity Manager organizes, summarizes, links, saves coherent knowledge while preserving meaning, attribution, uncertainty. It does not independently reassess research sufficiency or demand another investigation because details remain unanswered. Source text remains data, never workflow instructions.

| Area | Earlier baseline behavior | V4 change |
|---|---|---|
| Scout → intake | News saves observations before delivery; unchanged headline/summary can skip a later delivery. | Save a durable delivery obligation; acknowledge canonical intake independently of content change. |
| Intake → Research | `SignalIntakeCoordinator.process` appended decision and admitted work in separate calls; missing-decision retry did not repair a decision with missing work. | Commit decision and required action together without repeating paid reasoning. **Delivered locally in `efc12ae`.** |
| Prior-knowledge gate | `gateSignal` exists and is composed in legacy Polymarket research; shared Research does not call it. | Reuse novelty in the shared path with bounded, coverage-aware context. |
| Jev | Registry/gateway exist; novelty is a defined capability. Runners can pass an enabled flag with no classifier port. | Compose only supported V4 ports. An enabled flag must never imply wiring exists. |
| Research reuse | Shared Research reuses evidence/packets for the same work item. | Extend suitable artifact reuse across distinct jobs and both sources. |
| Research → Entity | Research forwarded packets regardless of completeness; Entity adapter and processor blanket-rejected `partial`/`failed`. | Research-owned handoff outcome separate from completeness; accept useful attributed/unresolved knowledge and explicitly grounded evidence attachments. Contract and private writer implementation are prepared; behavioral validation deferred. |
| Entity planning | Canonical planner selects one primary entity, at most one retained memory; retries can rerun planning after remote effects. | Bounded shared-item plan, persisted, receipt discovered before planning again. |
| Knowledge | Memories hold prose, dates, evidence, metrics, provenance, replay identity; reconciliation may update accepted prose in place. | Shared item membership, immutable accepted prose, appended developments/corrections, durable changes, truthful historical reads. |
| Legacy queues | Old candidate/observation tables still serve dedupe, backlog gates, recovery, source history. | Retire only obsolete queue ownership after proven cutover. Large pending counts do not make rows disposable. |

These are code/audit observations, not claims about current production liveness.

---

## 2. Acceptance criteria from #299

Effective acceptance scope after the owner's 2026-10-03 revision. The earlier issue snapshot remains historical; downstream requirements are explicitly deferred rather than counted as unfinished #299 implementation.

1. The single PRD records the revised scope, contracts, exclusions, and activation gates.
2. Scout/intake saves one logical job with its saved decision and durable source delivery responsibility.
3. Research-ready attributed partial output reaches Entity without another research sufficiency judgment; invalid output has an explicit blocked/failed outcome.
4. Shared News and Polymarket consult bounded relevant existing knowledge and reuse eligible evidence/research while preserving new information and attribution.
5. The one-follow-up allowance and spending reservations survive retries and continuation; unknown paid results remain held. Paid activation is separately gated.
6. Saved plans and remote receipts resolve interrupted/concurrent attempts without duplicate accepted effects or unnecessary replanning.
7. Shared item identity, immutable prose, grounded entity memberships, provenance, linked developments/corrections, and retained history exist in private durable storage. Exposed historical reader views are deferred.
8. **Deferred:** independent downstream consumers, change delivery/checkpoints, Editor/Publisher/X Desk adoption, and evidence-only update handling.
9. Private managed storage prevents legacy writer bypass and preserves existing memory tables/indexes. **Deferred:** V1 projection, API/browser exposure and unaware-consumer integration.
10. Source ownership, reconciliation, fencing, recovery and rollback are implemented as prepared operator paths; no cutover or retirement is executed during coding.
11. All code is connected before the final TypeScript check. Behavioral tests, SQL rehearsal, measured evaluation, production pipeline checks, migration application and restart are later validation/activation work, not this coding pass.

During coding, status means implemented/unverified. Neither an in-memory implementation nor compiler success is evidence of database or production correctness.

---

## 3. Owner decisions

### 3.1 D1 — Older, incomplete research: preserve and assess

From the 2026-09-30 owner decision comment, still binding.

Older validated complete packets retain the supported legacy path. Older **incomplete** packets without a new readiness decision are held as `readiness_unknown`, Research-owned, and not automatically schedulable for Entity. Engineering defines the assessment and readiness transitions.

Explicitly forbidden: auto-promoting to ready, permanently rejecting, or bulk-rerunning the historical backlog. Some older work may remain waiting for assessment indefinitely. D1 does not change the supported validation path for older complete results, and it does not authorize replay.

A bounded, explicitly admitted assessment reads retained material and its provenance, validates linkage and evidence availability, records assessment identity/reason/version atomically with a new action or hold, and never rewrites the original packet. It may conclude ready-with-limitations, resolved-without-item, blocked, or failed. An absent capture or inability to assess stays unknown/held — never a fabricated result. The explicit single-item assessment runner is now implemented as `entity-v4:research-assess-partial`; it requires paused source ownership and an attributable admission. It has not been executed in this coding pass and does not replay or promote a backlog.

### 3.2 D2 — Unknown outcome of a paid provider dispatch: recover or hold, never auto-replace

Also from the 2026-09-30 owner decision comment, still binding.

A timeout is not proof the provider did no work or charged nothing.

- Preserve the spending reservation and the **same logical assignment/allowance**.
- Attempt recovery only through a mechanism the provider actually supports.
- If the outcome stays unknown, **hold the item for intervention**.
- Never automatically issue a replacement paid call. Never reset the allowance.

The owner accepts this per-item delay to prioritize avoiding duplicate spend. This is a recovery policy, not a guarantee that provider charges can always be recovered or prevented. Durable Research reservations and aggregate assignment limits are now wired to the shared worker. Entity planning also persists dispatch exposure in the private writer domain. Explicit reconciliation commands are prepared; unknown outcomes without supported evidence remain held. No provider dispatch or reconciliation command has run in this coding pass.

### 3.3 Jev activation policy — conservative and auditable

Jev is a **selective, feature-gated capability**. Approved operating default: when Jev judges a bounded follow-up worthwhile, Research may perform **one bounded additional investigation**, inside **one durable assignment allowance** that code enforces across retries, resumes, and continuations. Retrying or splitting work must not reset it. Classification fallback and output repair consume their applicable existing call/cost budgets; they are not free extra reasoning.

No numerical budget is approved here. **This PRD invents none.** The previously proposed figures in the older comments (one search request, at most two additional sources, ninety seconds, 15,000 input / 3,000 output tokens, $0.10 incremental, $0.25 total, four provider calls, freshness defaults of six hours / fifteen minutes / twenty-four hours) are **recorded proposals awaiting product approval**, not limits.

The issue owner has now accepted the preparation checkpoint's conservative recommendation for unresolved and no-addition handling:

- Jev returns `uncertain` → do not dispatch an additional paid follow-up. Continue only the already-authorized bounded Research path; preserve an explicit `uncertain` outcome and hold if readiness cannot be established.
- A completed follow-up adds nothing useful → record the attempt and no-addition finding; do not loop or relabel anything as verified. Keep the original attributed handoff only if it independently satisfies Research readiness; otherwise retain the evidence and hold/no-item with a reason.
- Neither case silently enables or repeats paid work. D2 reservation/reconciliation rules still apply to every dispatched call.

This is the adopted default for implementation and tests, based on the owner's 2026-10-01 instruction to proceed with the reviewed recommendations and the earlier checkpoint recommendation. No additional question is open on this policy. It remains disabled for paid production activation until the reviewed quality/cost/latency gates pass.

Note also: Jev must reduce total work at accepted quality. Failed optional shadow delivery must never block live work. A mandatory job handoff has different durability requirements from a Jev shadow sample.

### 3.4 Architecture decisions adopted from the issue recommendations

These are adopted as the design direction, **not** as verified deployed reality:

1. **Source-local SQLite work ownership.** Keep it. No central job queue, no third competing store.
2. **Immutable producer-owned research/evidence references.** The producer store owns each immutable capture or research artifact. A consuming job saves a store-qualified reference `{ownerStoreId, artifactId, captureVersion, digest}` plus its usage/eligibility decision in its own transaction. One source owns each job. A lookup across the two files is read-only. A required cross-file dependency is acknowledged by the owner (retention pin) before the consumer promotes the reference to usable. Missing owner data is an explicit miss/block, never an empty successful knowledge lookup. The existing evidence `workId` keeps identifying its **originating** work and is never rewritten to the consumer's work. Central artifact storage is a fallback only if federation fails measured requirements.
3. **A single controlled managed writer.** Managed knowledge mutations go through one narrow transactional path, not through whatever currently holds a service-role credential. The preferred mechanism from the issue: a private PostgreSQL connection from the same server-side worker with an operator-provisioned dedicated `LOGIN` role over TLS, `CONNECT` + `USAGE` on a non-exposed writer schema + `EXECUTE` on named commit/receipt functions, **no direct managed-table mutation grant**; the commit function is `SECURITY DEFINER` owned by a distinct minimal-privilege NOLOGIN role, fixed empty search path, schema-qualified objects, validated bounded inputs. `service_role` must not receive `EXECUTE` on the private writer. Triggers must discriminate managed vs legacy rows using protected identities and the **effective database role**, never a caller-settable session flag. An admin who can disable triggers remains trusted — this is application enforcement.
4. **Downstream compatibility is deferred.** Reader capabilities, V1 projection and independent consumer adoption are follow-up work after #299. This implementation uses only bounded internal Research/Entity context queries and preserves existing product storage/routes.

**The current implementation prepares additive private managed tables.** It does not repurpose `entity_memories`, its indexes or publication UUIDs. Migration application, role provisioning and SQL rehearsal remain deferred. The original compatibility alternatives below are retained as historical considerations for the later downstream project; they are not requirements to build a projection in this pass.

### 3.5 Historical compatibility constraints for later projection work

The current private additive schema avoids mutating the legacy structures listed here. These constraints remain relevant if downstream compatibility later requires a managed projection; that work is deferred.

Known checkout facts to rehearse (checkout ≠ deployed fleet):

- `entity_memory_canonical_scope_guard_v1` allows only one article/packet per entity — it would reject V4 multi-development plans.
- `entity_memories_source_unique_idx` assumes the old source/type/title tuple. Two managed drafts may legitimately share it. Do not fix by inventing research IDs or changing titles. Prefer a legacy-only partial compatibility index plus managed identity uniqueness — **only after** proving every binary naming the old full-tuple `ON CONFLICT` target is retired or adapted. The migration cannot assume the deployed fleet matches this checkout.
- v1 identity constraint and store validators assume the old key format. Widen validation for managed rows only; adapt code validators.
- `entity_memories.entity_id ... ON DELETE CASCADE` must not remove managed items.
- Legacy upsert, story reconciliation, and market consolidation mutate accepted prose in place. Persistence must prevent that for managed rows.
- Existing `SECURITY INVOKER` catalogue merge/rollback must keep working for unmanaged rows, and must **fail closed before mutation** for any managed participation.
- Exact UUID publication references and Story IDs must keep resolving.
- v1 readers filter on `entity_id`; the frozen `entity_id` anchor must be suppressed from the v1 current view when its anchor participation is invalidated — never quietly moved.

---

## 4. Staged delivery matrix mapped to concrete repo seams

Stage numbering follows the 2026-09-30 preparation checkpoint, which is the most recent owner-visible staging.

| Stage | Concrete repo seams | Depends on | Gate to start | Rollback |
|---|---|---|---|---|
| **0 — scope / contracts** | Effective owner instruction §0 and interfaces | Current scope | Revised for code-only parallel implementation. All downstream integration deferred. | Preserve legacy storage and publishing inputs. |
| **1 — source / intake durability** | News, Polymarket, source delivery outboxes, atomic intake units | Existing committed baseline | Implemented in baseline; no behavioral tests run in this coding pass. | Preserve acknowledged observations and frozen delivery obligations. |
| **2 — Research readiness / reuse** | Research worker, immutable artifacts, retrieval manifests, bounded assessments | Stage 1 and internal knowledge queries | Eligible evidence/result reuse and explicit retained-partial assessment implemented by Maya; behavioral validation deferred. | Disable new admission/reuse, preserve saved decisions, artifacts and holds. |
| **3 — novelty / controlled spend** | Existing gate/classification registry and source-local SQLite reservation ledger | Stage 2 | Novelty, bounded follow-up, saved responses and persistent aggregate assignment reservations wired by Maya. Explicit policies required; disabled by default. | Preserve all reservations; unknown dispatched outcomes cannot auto-repeat. |
| **4 — managed storage / Entity integration** | Private additive PostgreSQL writer, plans/holds/leases/receipts, shared Entity runtime | Packet/readiness contract | Private writer/migration, managed processor and receipt-first shared-worker recovery implemented by Leo. No migration application or SQL rehearsal. Managed records remain isolated from downstream publishing. | Disable managed mode, preserve receipts/history, do not restore legacy mutation over managed rows. |
| **5 — downstream readers / consumers** | No edits in this pass | Separate follow-up after #299 | **Deferred by owner.** No reader framework, checkpoints, projection, publishing, API or browser integration. | Keep managed items private and existing publishing inputs unchanged. |
| **6 — operational measurement / validation** | Runtime status and source-scoped reports | In-scope integration | Operational wiring implemented by Nora; real measurements, paid evaluation and pipeline validation deferred. | Preserve unknown-cost reporting and separate evaluation allowances. |
| **7 — ownership / recovery / rollback preparation** | Source-local authority, collector/intake/worker gates, operator commands | Stage 1 and managed/research integration | Persistent ownership, fences and evidence-bound operator paths implemented by Nora. No source cutover, restart, retirement or data deletion is executed. | Prepare compatible sole-owner rollback and retain all source/knowledge history. |

Coding order: agree contracts, run the three lanes in parallel, connect internal interfaces, then run the final collectors TypeScript check. No tests, builds or database/runtime checks during implementation. Compiling does not authorize activation. Runtime validation, database rehearsal, migration application, pipeline inspection and restart remain later work.

---

## 5. Design notes retained from the staged implementation

These notes preserve the original contracts and later validation cases. The current coding record is §9. Any test list here belongs to the deferred validation phase; no listed test or rehearsal is run in this coding pass.

### 5.1 Stage 1 remainder — collector-side observation/delivery obligations

*Status: delivery outboxes and atomic intake are in the baseline; source ownership fences and observation-preserving collector controls are implemented in the current pass. Behavioral validation is deferred.*

Use the existing source-local SQLite databases and a small shared outbox contract, not a new service:

- Shared contract/helper: `packages/collectors/src/signal-platform/source-delivery-outbox.ts`. An immutable obligation is keyed by canonical `signalId` and stores validated Signal JSON, a canonical digest of the immutable Signal fields (excluding poll-only `observedAt`, matching canonical intake's duplicate semantics), pending/delivered state, attempt count, timestamps, and a redacted last-error code. Reusing an ID with another semantic payload digest is a hard conflict. Delivery is at-least-once; canonical intake's stable identity makes exact replays idempotent. No database transaction spans source observation and canonical intake.
- News: extend `NewsStore` and its additive SQLite schema with an outbox table. In the same transaction that inserts each new/material `news_candidate_observations` row, insert its exact adapted Signal obligation. On each ingestion run, drain older pending obligations before processing the new feed, then deliver newly inserted obligations. `known_unchanged` is never used to infer that an older obligation was acknowledged. Do not create new obligations for historical rows during migration.
- Polymarket: extend `PipelineStore` and its additive SQLite schema with immutable market-observation/outbox rows. Add one store operation that, on its single SQLite connection/transaction, commits the fetched watchlist baseline together with all material observations and exact Signal payloads derived against the pre-update baseline. Drain saved obligations before fetching/committing the next baseline. Only after that commit may canonical intake run; legacy backlog/backpressure and candidate-thread writes stay downstream and cannot erase a canonical delivery obligation. Keep the existing file path shared by `SqlitePipelineStore` and `SqliteSignalPlatformStore`.
- A successful return from an `observe` or `active` intake acknowledges the source obligation, including an idempotent duplicate; `off`, a thrown intake, or a process exit before acknowledgement leaves it pending. Persist failures as redacted codes, not provider/database error text. Never mark delivered before intake returns. The legacy collector continues if canonical delivery fails, while the next run retries the frozen payload, not a reconstruction from a newer poll.
- These are internal SQLite migrations only. Additive defaults preserve old rows/readers; migration creates no obligations from old observations and performs no historical replay. Physical Supabase design remains separately conditional on the authorized rehearsal (§5.4).

Required tests: migration over a pre-outbox fixture without rewriting rows; exact replay after a failed intake and process/store reopen; same-ID/same-digest idempotency and same-ID/different-digest rejection; feature-off does not enqueue/replay; observation/outbox transaction rollback leaves neither half; source intake succeeds but a crash before source acknowledgement safely redelivers once by canonical identity; News unchanged polls cannot suppress pending delivery; Polymarket compares against prior baseline and commits baseline plus outbox atomically; old backlog gates do not suppress durable canonical observations; both pending outboxes survive backup/restore; legacy readers and candidate processing remain compatible.

Item 12 boundary, as required by scope: source adapters supply native identity, observation/provenance, and source policy/capabilities; shared workers own lifecycle. Register only News and Polymarket. `research-engine/run-shared-research.ts` currently holds source maps that must be accounted for.

### 5.2 Stage 2 remainder — shared knowledge context and cross-source reuse

*Status: bounded legacy/managed context, strict evidence/result eligibility, attribution-preserving cross-source reuse and shared-worker synthesis use are implemented. Behavioral validation is deferred.*

Proposed files:

- `packages/collectors/src/research-engine/retrieval-manifest.ts` — discovery + retrieval manifest recording required/optional sources, successful captures, failures, and the Research decision to proceed with limitations. **A nonempty evidence cache is not a completion marker.**
- `packages/collectors/src/research-engine/artifact-repository.ts` and additive tables/methods in `signal-platform/sqlite-platform-store.ts` — store-qualified `ArtifactRef`, producer retention pins, consumer usage decisions, and fail-closed resolution. The separate `sqlite-artifact-repository.ts` proposed earlier was not needed for this local slice.

Storage owner: the source-local SQLite store that produced the artifact. Consumer stores hold references and their own eligibility decisions.

Eligibility rules:

- Evidence identity = native identity or normalized URL + requested/final URL + capture/content digest + capture time + availability + restrictions. Changed bytes create a new version. A signal/headline hash is not a retrieved-document byte hash.
- Freshness thresholds are **unapproved proposals** (§3.3), not set values.
- Full research reuse requires compatible question/assignment scope, material evidence set, input digest, decision/policy version, applicability interval, correction context. Exact signature match may reuse the whole result; a changed window, question, material fact, or relevant correction may not. Same entity/event alone permits background reuse, not reuse of the conclusion.
- Partial research is reusable **as partial**: attributed claims, unsupported claims, unresolved questions, source availability, limitation reasons all preserved. A consumer records which contributions it reused and which gaps it investigated. It cannot promote an old limitation into a verified fact.
- The existing `WorkContractEvidenceReusePolicy` is deliberately tied to the same work's creation/deadline and source-material digest. It stays for same-work replay; a **distinct** cross-work eligibility policy is needed.

Novelty: reuse `gateSignal` and existing `research.novelty`. Add bounded relevant context — resolved candidate identities, item/citation/research references, filter/time coverage, truncation, lookup failures, digest/watermark. Legacy lookup by `(source, source_ref_id)` is insufficient: canonical `source_ref_id` is a signal ID while the legacy market gate uses a stable subject slug. An empty, failed, truncated, or unrelated lookup **cannot** justify `already_known`. A cheap title/summary check may choose to proceed but cannot discard an article whose unseen body may hold new information. `gateSignal` already normalizes reader/generic classification failures to `gate_unavailable`; reuse that behavior rather than rebuilding it. Live runners pass a classifier-enabled flag without a classifier port; `active-triage.ts` correctly throws when enabled without a port — register supported ports explicitly.

### 5.3 Stage 3 — Jev classification and the D2 reservation ledger

*Status: source-local persistent reservations, aggregate assignment exposure, saved responses and bounded novelty/follow-up dispatch are implemented. Policies remain explicit and activation remains disabled. Behavioral validation is deferred.*

Proposed files:

- `packages/collectors/src/research-engine/assignment-budget.ts` — the D2 reservation ledger.
- A versioned `research.followup_value` workload definition in the existing `inference-gateway/classification-definitions.ts`, with `worthwhile / not_worthwhile / uncertain`, compatible fallback, and evaluation.

Definition text that must be in the versioned definition:

> Assess whether one bounded follow-up could add information material to this research assignment beyond the supplied source and relevant saved knowledge. Unanswered details alone are not sufficient. Do not assert that any supplied claim is true. If the supplied context is insufficient to judge, return uncertain.

D2 ledger transitions, storage owner: the source-local SQLite store, one row per reservation attempt.

| State | Meaning | Next transitions |
|---|---|---|
| `reserved_not_dispatched` | Allowance claimed, maximum exposure reserved, nothing sent. | Releasable **only** while exclusive ownership and a persisted no-dispatch fact are both provable → `released`. Otherwise → `execution_outcome_unknown`. |
| `dispatch_intent` | Persisted **before** the request is handed to the transport. | `settled` on a valid saved result; `execution_outcome_unknown` on timeout, crash, lost lease, or lost response. A crash between intent and actual send is held conservatively. |
| `execution_outcome_unknown` | Outcome not established. An HTTP timeout is not non-execution evidence. | Reconcile via a provider-supported durable result handle or verified provider record → `settled` or `released`. Without a supported channel → **hold for intervention**, forever if necessary. |
| `settled` | Result saved against the exact attempt/request identity and digest, usage/cost provenance or `unknown` usage; reservation settled once. | Terminal. |
| `released` | Authoritative no-execution/no-charge finding recorded. | Terminal. |

Persisted before any external call: `(root assignment ID, follow-up allowance ID, attempt ID, request digest, provider route/version, approved limits, owner lease/fence, reservation and accounting status)`. A single conditional transaction claims the logical allowance and reserves its maximum exposure. Retry, continuation, fallback, and repair consult the same root ledger and **never mint a fresh allowance**.

An authoritative no-execution finding may release a reservation. A charged result without usable output records actual/unknown spend but **does not automatically authorize replacement**. Any later operator action needs explicit recorded authority and budget evidence; it is not an automatic retry. A lease expiry only lets a new reconciler acquire a higher fenced ownership epoch; it never makes an in-flight call disappear. Conditional updates reject the old owner's late save unless it is the same verified attempt result.

Existing inference budgets support measured cost limits but **fail closed when cost is unavailable**, and both traced historical executions recorded `costUsdMicros=null`. Do not report zero cost or promise an enforceable dollar ceiling before cost coverage and reservation are proved. Also propagate token limits explicitly: current shared synthesis copies call/repair/time limits but omits the work's input/output token ceilings — a targeted V4 contract fix, not control-plane consolidation.

Story matching, entity identity, roles, and broad importance are **not** activated in this scope.

### 5.4 Stage 4 — managed items/writer and operation receipts

*Status: the private PostgreSQL writer, additive migration and managed shared-worker integration are prepared. Migration application and database rehearsal remain deferred; code grants no rollout authority.*

Proposed files:

- `packages/collectors/src/entity-manager/progression-plan.ts` — bounded plan + validator.
- `packages/collectors/src/entity-manager/progression-processor.ts` — plan execution against the managed writer.
- `packages/collectors/src/entity-manager/knowledge-operation-store.ts` — writer port, in-memory reference store, operation receipt and fencing. `postgres-knowledge-writer.ts` implements the private PostgreSQL port; `managed-canonical-processor.ts` connects canonical work to it.

Logical contract (implementation draft; `ItemDraft` and `ExistingItemOperation` are specified by the local TypeScript contract, pending review):

```ts
type ProgressionPlanV1 = {
  contractVersion: 1;
  operationId: string;          // assigned by code for the logical operation
  workId: string;
  packetDigest: string;
  contextDigest: string;
  contextWatermark: string | null;
  policyVersion: string;
  promptVersion: string;
  decisionVersions: Record<string, string>;
  targetRevisions: Record<string, string>;
  outcome:
    | { kind: "apply"; drafts: ItemDraft[]; operations: ExistingItemOperation[] }
    | { kind: "retain_observation"; reason: string }
    | { kind: "hold"; reason: string; missingDependency: string };
};
```

One ordinary structured planner call should produce the bounded plan — not a call per entity, field, or stage. The model proposes supplied candidate IDs or validated local keys; **code assigns persisted identities**. Unresolved identity prevents apply; unresolved research details alone do not.

The reference store fails closed for new commits when an existing-item operation or managed-item entity link lacks a matching expected revision in `targetRevisions`; supplied revisions are checked against the current target at commit. Accepted receipt replays return before these write checks. This is a local contract check, not proof of production database CAS behavior.

Current contract details: `ProgressionSourcePacketEvidenceReader` reads the immutable Research packet by code-owned work ID, validates its full canonical digest and derives allowable `(claimId, evidenceId, sourceRef)` tuples from saved links. The managed canonical processor supplies the raw saved-packet adapter, bounded internal context and private SQL writer. Entity/item identities and expected revisions are grounded by code rather than accepted from model-proposed persisted IDs. Stable logical operation identity derives from code-owned `workId`; packet/context/policy/prompt/decision/target fingerprints belong to immutable attempts. Accepted receipt recovery precedes packet hydration and provider construction. Saved validated plans resume without another paid planner dispatch. Corrections/supersessions create linked successor items while preserving earlier prose; retractions, evidence attachments and membership changes retain history. Expected absence/revisions and lease owner/epoch are enforced by the prepared private writer transaction together with accepted effects and the terminal receipt. Conflicts, stale context, busy leases and unresolved dispatches retain work rather than silently completing it. None of these database guarantees has been behaviorally validated in this coding pass.

Caps: the previously proposed four items per packet, eight entity links per item, four outgoing continuity links, thirty-two evidence references, and six thousand characters per note remain **provisional evaluation inputs**, not approved calibrated limits and not targets to fill. The implementation also uses provisional safety caps of four existing-item operations per packet, 16 KiB per operation payload, 32 version entries, 1 MiB per plan/commit payload, eight committed effects, JSON nesting depth 32, 7 MiB per retained hold payload, and 8 MiB per serialized hold record. These are not calibrated limits; the saved-packet adapter and eventual SQL writer must enforce compatible bounds. Versioned caps must be explicitly reviewed before rollout. Any output repair must fit the existing provider-call and cost allowance.

The local reference keeps plan revisions and hold attempts append-only with no attempt-count pruning. Production storage must define bounded/paginated history without silently overwriting or discarding earlier attempts.

Overflow: durable hold, all unprocessed groups preserved, **zero partial knowledge commits from that plan**. No silent truncation, no parent completion while material overflow remains. A separately reviewed/admitted bounded continuation processes retained groups under an explicit revised work plan, retaining root assignment/allowance and allocated contribution identities. V4 has **no automatic deferred-work wakeup service**; operators resolve through supported controls. Continuations and retries cannot duplicate accepted contributions or reset follow-up limits.

Ordering rules:

1. Checkpoint the normalized validated plan and hash **before** downstream writes.
2. Keep immutable plan content separate from append-only execution outcomes.
3. Resolve an accepted terminal receipt for the logical operation **before** model/configuration-version checks — prompt/config fingerprints are audit metadata, not logical identity; accepted work replays its receipt regardless of those fingerprints.
4. For unfinished work, the supplied prompt/input fingerprints define an immutable plan attempt. Changed inputs may create a new plan revision under the same work ID; keep earlier plans/holds as history and resume only an unheld matching checkpoint after a failed commit. Never overwrite an attempt or repurpose accepted knowledge.
5. Serialize against any earlier in-flight attempt first: an already accepted receipt wins, a stale revision cannot commit later.
6. Lock target entities/items in deterministic order, check target/authority revisions and expected absence for newly derived item IDs at **commit** time, commit all effects plus the receipt in one transaction, then acknowledge local completion.
7. Stable operation identity + digest rejects conflicting replays. A stale target leads to targeted revalidation or a hold, never unconditional overwrite.

Semantic cross-source deduplication is a grounded validated decision, not an entity ID or prose hash.

### 5.5 Stage 5 — downstream readers and consumers: deferred

The owner explicitly removed this stage from #299 on 2026-10-03. Do not implement a production knowledge-reader framework, consumer checkpoints, managed V1 projections, Editor, Publisher, X Desk, API, or browser integration in this pass. Existing local helper/fixture files remain as prior work; they are not adopted or exposed.

Research's existing-knowledge consultation and Entity's bounded internal identity/context queries are allowed internal pipeline dependencies. They may consult private managed items through narrowly scoped named database functions; they are not a reusable downstream reader API.

New managed items remain isolated in private additive storage. Existing publishing paths continue on their supported legacy inputs. Adoption and exposed historical/current views belong to a separately scoped follow-up after #299; no worker restart implicitly enables downstream exposure.

### 5.6 Stages 6 and 7 — evaluation, cutover, retirement

Stage 6 must produce a reviewed direct-processing baseline and cover the whole crash/replay suite before any activation. Measure total provider calls, input/output usage, fallback/repair rates, repeated inference on retry, median/tail completion time, and cost where available. Track **both cost per correctly resolved input and cost per useful accepted item**, so cheap false discards are not disguised as efficiency. Charge shadow evaluation expense separately from production cost.

Local code-only preparation: `signal-platform/v4-evaluation.ts` aggregates supplied direct/shadow fixture measurements and reports pairing, coverage, costs and nearest-rank p95 latency. It does not gather real measurements, establish a reviewed baseline or decide activation. `v4-source-cutover-preflight.ts` reports **advisory** source-scoped checks; its result never authorizes an ownership change. A distinct source-level receipt, writer-fence verification and execution-time evidence binding are still needed; no queues or runtime flags are changed by this code.

The sample sizes, quality thresholds, cost-reduction targets, and latency targets proposed in the older comments are **proposals awaiting product approval, not measured results**. Require a reviewed baseline, explicit thresholds, and stated sample sizes before enabling Jev or managed production. If the savings target fails, retain correct direct processing and leave the classifier off. News first, then Polymarket. A source starts at a small bounded selection only after the gates pass, with its evaluation/canary allowance bounded separately.

Stage 7 inventories `news_candidate_observations`, `news_research_results`, `pipeline_candidates/research/editor` dependencies across dedupe, backpressure, recovery, maintenance, and backfill. Existing Research/Entity cutover receipts **exclude intake**, and the Research/Entity guards do not stop collector queue writes — record a source-level cutover rule/receipt separating retained observation capture from retired mutable queue bookkeeping, and prove no obsolete collector queue writes remain. Use backups, source-by-source parity checks, ownership receipts, a rehearsed rollback, and an agreed observation window. Retire obsolete admission/claiming only after the canonical path proves healthy and residual references are accounted for. Preserve observations, evidence, research, accepted knowledge, identity mappings, and retained history. Large pending counts do not establish that rows are disposable.

---

## 6. Historical implementation and verification record — 2026-10-01

Recorded 2026-10-01 from `codex/issue-299-v4`. The slices below are now committed on local `main`; headings retain their original commit boundary.

### 6.1 Committed: `efc12ae` "Make signal intake decisions and work recoverable"

The **first intake/admission durability slice only**. Its boundaries:

- New `packages/collectors/src/signal-platform/intake-admission.ts` — `AdmissionDispositionV1` (`myboon.admission_disposition.v1`), `IntakeMode` (`shadow | observe | active`), `AdmissionAuthorization`, `createActiveIntakeDisposition`, `createNoAdmissionDisposition`, `admissionWorkPayloadDigest`, `isActiveAdmissionIntake`, `admissionDispositionId`, `validateAdmissionDisposition`.
- `signal-intake.ts` / `source-intake.ts` — the canonical coordinator routes through one atomic operation; re-entry loads the accepted decision and saved disposition/payload before any new triage or work derivation; repair selects **proven, still-owed active admissions**, not every research-shaped decision lacking work; observe/no-admission and ambiguous legacy rows are excluded and reported for explicit assessment; today's configuration is never substituted for a missing original policy/payload; a later authorized admission of observed material is a distinct recorded event, not generic repair; an existing advanced work row is returned without resetting status, leases, attempts, or results.
- `sqlite-platform-store.ts` — one SQLite transaction owner with transaction-neutral internal helpers; the existing transaction-owning append/admit methods are not nested.
- `feed-v3-e2e.test.ts`, `signal-intake.test.ts`, `source-intake.test.ts`, new `intake-durability.test.ts` (694 lines).

What `efc12ae` does **not** do: it is not stage 1 in full. The subsequent `44f02d4` collector slice adds News and Polymarket source-local delivery obligations; the end-to-end Stage 1 work is implemented and committed locally. Active cross-source artifact reuse, managed items/writer, readers, cutover, and evaluation remain outstanding.

### 6.2 Committed in `44f02d4`: research readiness / atomic handoff and Entity handoff

18 modified files, 3 new files, +1521/−69.

**New:**

- `packages/collectors/src/signal-platform/research-readiness.ts` (851 lines) — `ResearchReadinessOutcome` = `ready_for_entity | resolved_without_new_item | blocked | failed | readiness_unknown`; `ResearchEntityAction` (`none | entity_item | evidence_attachment`) with a stable `actionId`; `ResearchContributionCoverage` with a measured `useful` flag; `ResearchReadinessV1`; `assessResearchReadiness`, `createBlockedReadiness`, `createResolvedWithoutNewItemReadiness`, `createReadinessUnknownReadiness`, `researchHandoffEntityClaim`, `researchHandoffWorkStatus`, `researchHandoffTerminalStatus`, `validateResearchReadiness`, `validateResearchReadinessLinkage`. Readiness has **no standalone public write** — only the atomic handoff may persist one, so a decision can never exist without the work status that admits it.
- `packages/collectors/src/signal-platform/research-readiness.test.ts` (461 lines, 14 tests).
- `packages/collectors/src/signal-platform/research-handoff-durability.test.ts` (723 lines, 23 tests).

**Modified:**

| Module | Change |
|---|---|
| `signal-platform/platform-store.ts` | `ResearchHandoffUnit` / `ResearchHandoffCommitResult`; `commitResearchHandoff`; `promoteResearchReadyWithReadiness`; `getResearchReadinessByWork` / `ByPacket`; `ImmutableRecordConflictError` gains `'readiness'`. |
| `signal-platform/sqlite-platform-store.ts` | New table `signal_platform_research_readiness` (FKs to work and packets) plus two indexes; private in-transaction append; stored-record linkage assertion; the single-transaction handoff; the bounded `research_ready` bridge. |
| `signal-platform/state-machine.ts` | `synthesis_leased` may now terminate directly into `entity_pending`, `complete`, or `dead_letter`; `research_ready` may finish as `entity_pending`, `complete`, or `dead_letter`. |
| `signal-platform/contracts.ts` | `ExecutionTraceEvent` gains optional `researchReadinessId`, `researchReadinessOutcome`, `researchReadinessPolicyVersion` — additive; legacy v1 events omit them. |
| `signal-platform/validation.ts` | Validates/normalizes those three provenance fields, defaulting to `null`. |
| `signal-platform/public.ts`, `research-engine/index.ts`, `entity-manager/public.ts` | Re-export the readiness surface and the new `EntityHandoffContext` / `EntityHandoffSource` types. |
| `research-engine/shared-worker.ts` | Commits packet + readiness + work status in one store transaction; re-entry reuses a saved decision verbatim and never re-runs synthesis or re-judges sufficiency; new `readiness_held` run outcome; bounded retry policy carried into the same transaction; readiness provenance recorded on packet replay. |
| `entity-manager/canonical-packet-adapter.ts` | Optional `EntityHandoffContext`; with a v2 decision the adapter validates linkage and consumes it instead of re-judging sufficiency; falls back to the legacy v1 rule (only `complete` admissible) when no decision exists; adapter version bumps to `myboon.entity_packet_adapter.v2`; the decision travels with the packet as `research_readiness`. |
| `entity-manager/canonical-processor.ts` | Re-adapts through the same decision; the `completion !== 'complete'` rejection applies **only** to the legacy path; `rejectUnsupportedEntityAction` fails closed. |
| `entity-manager/shared-worker.ts` | `EntityPacketWorkPort.readHandoffContext?`; loads work + signal + persisted evidence + readiness in one read; refuses to proceed when the decision exists but its linkage records do not. |
| `entity-manager/sqlite-entity-work-port.ts` | `SqliteEntityPacketWorkPort.readHandoffContext` implementation. |
| Associated tests | `canonical-packet-adapter.test.ts`, `canonical-processor.test.ts`, `entity-manager/shared-worker.test.ts`, `sqlite-entity-work-port.test.ts`, `research-engine/shared-worker.test.ts`. |

**Known incomplete behavior in this slice.** An owed `evidence_attachment` action has **no writer**. The processor's `rejectUnsupportedEntityAction` fails closed **before any planner, Entity, or memory write**, with a non-retryable `entity_resolution_failed` failure so the work becomes a held row rather than a retry loop. The readiness record keeps the owed action and its target for whoever performs it later. This is incomplete work, not a completed attachment capability.

Also incomplete in this slice: no cross-source artifact federation, no D1 admitted assessment runner, no Jev work, no managed writer, no reader change.

### 6.3 Committed in `44f02d4`: retrieval checkpoint / manifest

New `signal-platform/retrieval-manifest.ts` records each bounded retrieval attempt with its work/signal/source/contract linkage, plan identity and digest, planned and search-discovered URL coverage, successful/failed/skipped outcomes, evidence IDs/content hashes/final URLs/truncation, explicit limitations, and a proceed-or-hold verdict. `commitRetrievalCheckpoint` saves the evidence batch and immutable manifest in one source-local SQLite transaction. It is additive for existing databases and fabricates no historical manifest. The worker never infers completion from an evidence cache; it validates a saved manifest before replay. A held retry reuses eligible successful captures and only fetches unresolved URLs; reused captures are marked as such. Evidence retains its producer work ID.

Focused manifest/store/worker tests cover complete and partial retrieval, required-source hold, optional-source failure, truncation, source caps, atomic rollback, lease loss, conflicting immutable IDs, migration without replay, lost-ack reopen, and held retries that do not repeat successful fetches.

An additional local slice implements `research-engine/artifact-repository.ts`: a reference carries the producer store ID, source type, artifact ID, capture time, and SHA-256 digest of the immutable capture. A producer-owned SQLite pin acknowledges retention before the consumer saves its usage decision; the foreign key prevents deleting pinned evidence. The consumer stores the decision separately, and every read rechecks the owner pin and digest. Exact shared source hints can admit an artifact as background context only; a rejected or missing artifact cannot become evidence for the consumer. Focused artifact tests pass **4/4**, including replay, missing receipt/digest, and deletion protection. The worker does not yet discover or supply these references to synthesis; no live cross-source reuse is active.

### 6.4 Verification run in this session (2026-10-01)

| Check | Result |
|---|---|
| Targeted affected suites — `research-readiness.test.ts` (14), `research-handoff-durability.test.ts` (23), `entity-manager/canonical-packet-adapter.test.ts` (15), `canonical-processor.test.ts` (35), `entity-manager/shared-worker.test.ts` (27), `sqlite-entity-work-port.test.ts` (3), `research-engine/shared-worker.test.ts` (28) | **145 pass, 0 fail** |
| `signal-platform/sqlite-platform-store.test.ts` + `validation.test.ts` | 24 pass, 0 fail |
| `signal-platform/contracts.test.ts` | 5 pass, 0 fail |
| Combined targeted total for the changed surface | **174 pass, 0 fail** (the earlier session recorded 173/173 for its targeted set; the sets differ by one test file) |
| `pnpm --filter @myboon/collectors exec tsc --noEmit` | **passes, exit 0** |
| `pnpm run test:signal-platform` (full) | **271 pass / 274 total, 3 fail** |
| `git diff --check` | clean, exit 0 |

This turn's retrieval-specific set — `retrieval-manifest.test.ts`, `retrieval-checkpoint-durability.test.ts`, `retrieval-checkpoint.test.ts`, and `research-engine/shared-worker.test.ts` — passed **67/67**. `pnpm --filter @myboon/collectors build` passed after these changes.

Subsequent artifact-link checks passed: `artifact-repository.test.ts` **4/4**, `sqlite-platform-store.test.ts` **24/24**, and `pipeline-store/backup.test.ts` **16/16**. The collectors build and `git diff --check` also passed after the artifact schema addition. These are separate runs; the earlier totals above have not been recomputed as one combined suite.

The three full-suite failures are `live-load CLI is a dry-run plan by default and never calls the collector`, `checked-in live-load CLI execution fails closed without an injected collector` (both `signal-platform/live-load-command.test.ts`), and `bundle recomputes policy and raw artifact SHA-256 values` (`signal-platform/operational-evidence.test.ts`). All three are **unchanged** by this work and fail with `independently reviewed evidence policy is expired`: their fixture policies carry `expiresAt: '2026-09-30T00:00:00.000Z'` (reviewed `2026-08-24`), and `assertOperationalEvidencePolicyCurrent` rejects them after that date. They are a review-policy expiry, not a regression from this slice, and they must not be "fixed" by silently extending the policy.

Root `pnpm run test` is a placeholder that exits 1; it is not a passing gate.

### 6.5 Synthetic PostgreSQL 15 compatibility rehearsal (2026-10-01)

Ran only against an ephemeral `postgres:15-alpine` container with `--network none`, a 384 MB tmpfs, 512 MB memory limit, and no host data mounts. The database held synthetic rows only. Applied the Entity Manager V1 table/index migrations, the identity-key migration, the carousel column migration, and the current canonical-scope guard function/trigger from the later review-boundary migration. The existing `entity_manager_verify_migration_v1()` returned zero null/duplicate identity keys and all required identity indexes/functions present.

Observed compatibility boundaries:

- The full legacy unique index on `(source, source_area, source_research_id, entity_id, memory_type, title)` rejects two distinct managed identity keys when their legacy tuple is identical.
- Replacing it with a legacy-only partial unique index permits distinct managed identities, but PostgreSQL 15 cannot infer that partial index for an old `ON CONFLICT (source, source_area, source_research_id, entity_id, memory_type, title)` caller without a matching predicate. Therefore do not replace/drop the full index while any such binary may still run.
- `entity_memory_canonical_scope_guard_v1` rejects another row for the same canonical source-item/entity scope, so it cannot directly admit multi-item V4 plans.

Direction: keep legacy `entity_memories`, its full unique index, and its guard as the compatibility surface; place managed immutable items, links, receipts, and history in additive private tables. Expose a read-only V1 projection through a separate security-invoker view with stable projection UUIDs. Managed writes use a narrow private writer function and never rely on legacy upsert semantics. This is a design decision for local implementation, not a production migration approval. The complete migration chain, RLS/grant review, writer/receipt/rollback rehearsal, and explicit old-binary inventory remain required before any activation.

### 6.6 Isolation

`efc12ae` and `44f02d4` were fast-forwarded to local `main`; the documentation handoff update is a further local commit. Nothing has been pushed. The root checkout's unrelated user changes are untouched. No deployment, production database write, worker restart, paid provider call, historical replay, production deletion, or GitHub label change occurred.

---

## 7. Current code evidence and deferred validation

The revised coding scope is implemented locally. This table records code availability, not production readiness or measured behavior. Historical verification in §6 does not validate this new pass.

| Revised requirement | Code status | Implementation / later gate |
|---|---|---|
| Single scope and execution policy | Implemented | §0, §2, §4 and this current record; downstream work explicitly deferred. |
| Durable Scout/intake handoff | Baseline retained; ownership connected | Existing source outboxes and atomic intake; new source-local authority and collector/intake fences preserve observations. |
| Research-owned partial readiness and attachment action | Implemented | Existing readiness/handoff contract, explicit retained-partial assessment and private Entity attachment operations. Semantic validation deferred. |
| Bounded existing knowledge and eligible reuse | Implemented | Shared Research runner composes legacy/managed context, evidence reuse and strict full-result reuse with attribution and retention references. |
| Novelty, one follow-up and persistent spending | Implemented; disabled by default | Durable classification/synthesis/follow-up, SQLite reservations, root assignment caps, saved responses and unknown-outcome holds. Paid evaluation and policy approval deferred. |
| Saved Entity plans and terminal receipts | Implemented | Private writer, managed processor and shared-worker receipt-first recovery. Concurrency/crash/database guarantees require later rehearsal. |
| Private shared knowledge, immutable prose and history | Implemented as unapplied migration + client | Managed entities/items, memberships, evidence, developments, linked corrections/supersessions, retraction/history and atomic effects/receipts. No production schema change. |
| Downstream readers/consumers and V1 projection | Deferred by owner | No new reader framework, checkpoints, publishing adapters, API or browser integration. |
| Source ownership, rollback and retirement preparation | Implemented; not executed | Durable ownership/activity, native admission/claim fences and evidence-bound operator actions. Worker-stop/private-writer reconciliation, restore and healthy-window evidence remain later gates. |
| Internal operational reporting | Implemented; not executed | Source-local work/readiness/reservation/reuse/provider usage and optional private writer status. Unknown costs remain explicit. |
| D1 single retained-partial assessment | Implemented; not executed | Explicit source/packet/admission/operator command under paused ownership. No bulk replay or automatic promotion. |
| D2 reconciliation | Implemented; not executed | Exact Research reservation and Entity planning dispatch commands. Unsupported provider recovery stays held; no replacement paid call is authorized. |
| Current-pass verification | Final TypeScript only | Result in §9. Tests, SQL rehearsal, live pipeline checks and restart are deferred. |

Remaining activation work includes policy values and measured evaluation, migration/role provisioning with isolated SQL permission/concurrency/rollback validation, source-scoped ownership evidence, pipeline validation and an owner-directed restart. Historical held work remains preserved; no coding action authorizes replay or deletion.

---

## 8. Historical references

Retained, not competing V4 specifications. None of these currently exists at the referenced path in this worktree; they were referenced by the issue and by the earlier session's checkout.

- `docs/modules/entity-manager/PRDs/2026_09_29_entity_progression_items_PRD.md` — original progression direction and its three agent reviews. **Absent here.**
- `docs/modules/entity-manager/operations/2026_09_29_entity_pipeline_discussion_tracker.md` — discussion sequence, seventeen items, Research authority, one follow-up, cross-source reuse. **Absent here.**
- `docs/modules/entity-manager/operations/2026_09_29_pipeline_health_and_cleanup.md` — operational evidence, caveats, backups, cleanup record. **Absent here.**
- `docs/modules/entity-manager/PRDs/2026_08_26_feed_v3_signal_to_knowledge_platform_PRD.md` — existing signal/work platform and migration context. **Present.**
- `docs/modules/entity-manager/PRDs/2026_09_11_entity_knowledge_model_PRD.md` — existing knowledge and identity guardrails. **Present.**
- `docs/modules/inference-gateway/PRDs/2026_09_22_jev_default_classifier_PRD.md` — existing Jev lifecycle, evaluation, fallback, shadow boundaries.

Issue #299 remains the parent tracker. Any later revision of this PRD must also reconcile the parent issue's scope and acceptance criteria.

---

## 9. Current parallel implementation

The owner authorized the revised implementation on 2026-10-03. Leo owns managed storage/private writer and Entity integration; Maya owns Research reuse/gating/spending; Nora owns source authority, recovery and operations; the parent coordinates contracts and writes this record. File ownership is explicit and agents preserve each other's work. No tests, builds, rehearsals or runtime checks are performed during coding.

The private managed writer persists immutable plan attempts, leases, hold histories and accepted receipts in the same private PostgreSQL ownership domain as its effects. This adapts the original generic working-desk description to the existing `KnowledgeOperationWriterPort` transaction/fencing contract. Source-local SQLite remains the owner of observations, intake/research jobs, raw packets, evidence references, Research outcomes and spending reservations. Polling internal jobs does not move to PostgreSQL.

All three coding lanes are complete and frozen. The Research runners connect novelty, bounded follow-up, durable synthesis, exact result/evidence reuse, managed/legacy context and retained-partial assessment. The Entity runner connects the private writer, raw source packet validation, grounded memberships, saved plans, terminal receipt recovery and paid dispatch holds. Collector/intake/legacy/shared workers connect durable source ownership; prepared operator commands and status reports expose the retained recovery state.

**Final compiler result — 2026-10-03:** `pnpm exec tsc --noEmit` in `packages/collectors` passed with exit code 0 after fixing missing follow-up registry exports and Research reuse-owner interface narrowing. This was run only after all coding lanes froze. No tests, builds, SQL execution/rehearsal, pipeline/runtime checks or restart ran in this coding pass; no test files changed.

TypeScript success does not establish database concurrency, permissions, replay behavior, semantics, cost savings or production readiness. Features remain disabled by default; the private migration is unapplied and activation/validation are later work. No downstream readers/consumers are a completion dependency for this revised coding scope.

## 10. Validation follow-up — 2026-10-03

The subsequently authorized offline validation passed 1,417 collector tests with no failures, 67 API compatibility tests, 15 explicit private PostgreSQL tests and seven reported full internal pipeline rehearsal tests. The two opt-in PostgreSQL entries skipped by the combined ordinary suite were run explicitly. Final collectors `tsc --noEmit` passed. Lane commands overlap; these numbers should not be added as a count of unique tests.

Validation corrected private SQL/client admission and provenance defects, unknown-outcome deadlines, durable budget/result handling, source schema/backup/ownership issues and actual private-reader binding. Shared Research now honors a guarded complete `already_known` comparison: it rechecks captured source and current bounded context, retains evidence, manufactures no claims and atomically resolves no-item readiness only when no Entity action is owed. Incomplete or ambiguous comparisons proceed conservatively; stale saved no-item comparisons remain held.

Twenty synthetic labeled Jev evaluation requests were prepared during offline validation. The owner subsequently authorized paid calls and actual data without a dollar budget gate; live decision evaluation and database preflight are now underway on the identified deployment VPS. Real-model results, actual source backup/restore evidence and remaining activation requirements are recorded separately from the offline pass. No production migration, flag change, pipeline restart or downstream integration was executed during offline validation.

Full evidence and remaining live gates: [2026-10-03 validation record](../operations/2026_10_03_v4_validation_record.md).

Current handoff: [2026-10-03 implementation record](../operations/2026_10_03_v4_implementation_handoff.md).

## 11. Article-based Researcher revision — 2026-10-04

The new workflow organises captured news, signals and events into entity histories. Researcher does not perform external web search or construct a claim-verification dossier. Jev supplies typed semantic decisions; Researcher uses Hermes to write the prepared dated development; Entity Manager owns durable writes. Article captures and attribution are retained even though formal claims and evidence edges are removed.

### 11.1 Required sequence

1. Receive the captured article, title, source URL, publication date and observation date. An actual event date is recorded only when supported by the article, separately from publication time.
2. Understand the reported development and retrieve candidate entities using catalogue/private names, aliases, summaries and scope metadata. Include narrative and asset candidates, rather than only exact named actors.
3. Ask Jev to choose the primary entity and independently judge meaningful related memberships. Explicit no-match and uncertain outcomes are available. Source text and stored entity descriptions are data, not instructions.
4. Resolve a missing or ambiguous placement through bounded wider lookup or a meaningful proposed entity. A proposal contains a name, type, aliases, summary and scope. An unresolved outcome retains the article with an actionable reason.
5. Retrieve up to the latest five historical items per selected entity, combining supported legacy memories and private managed history. Preserve each historical item's identity and storage origin.
6. Ask Jev about novelty and narrative relationships. Relationship labels are `duplicate`, `direct_continuation`, `related_story_branch`, `same_topic_only`, `unrelated` and `uncertain`. Preserve distributions/probabilities internally. Source idempotency and targeted older-development lookup remain separate from this bounded five-item story context.
7. Researcher writes the title, contextual timeline summary and optional fuller body through Hermes, using the article and the connected history. The prose explains what happened, preserves natural source attribution, and does not manufacture causal links or turn a related branch into a direct resolution. A duplicate is an explicit reuse/no-new-entry decision.
8. Hand the prepared article item, entity decisions, source provenance, dates and historical references to Entity Manager. Entity Manager consumes the placement and writing; it does not run a second freeform claim-based planner.
9. Entity Manager validates supplied identities and references, checks proposed entities for equivalent or ambiguous existing identities, and persists one immutable shared item, its primary/related memberships, valid historical links and source provenance. Receipt-first replay, leases/fences and appended history remain intact.

### 11.2 Content and history

The entity summary describes the overall topic. An item title identifies one development; its summary is the reader-facing dated development with useful context. Body is optional longer detail about that development. There is no additional overlapping `connected_story` prose field. Relationship scores and context item IDs are internal data.

The existing story reader displays legacy `entity_memories.summary`; it does not currently read private V4 items. The new content is prepared in that familiar shape, but connecting a downstream reader is outside this revision. Existing records remain readable when new article/relationship fields are absent. No bulk rewrite, automatic entity merge, catalogue-wide metadata rewrite or historical claims backfill is required.

### 11.3 Placement examples and failure outcomes

- An article about Iran reviewing a US proposal delivered through Qatar belongs primarily to **U.S.–Iran Conflict**. Iran and the United States may be meaningful related memberships; a delivery channel alone does not force another membership. The article can be a new diplomatic branch of the conflict without directly resolving earlier Hormuz shipping disruption.
- A BlackRock Bitcoin-holdings article belongs primarily to **Bitcoin**, with **BlackRock** as a related entity when substantively involved. These are memberships of one shared item, not independently rewritten copies. An existing report of the same acquisition remains eligible for duplicate resolution even if outside the latest five timeline entries.
- An AI-investment outlook requires entity scope judgment; a broad AI bucket is not automatically created merely because the article mentions AI.
- A missing entity is a placement outcome, an ambiguous identity is an explicit hold, and a duplicate is a reuse outcome. These are distinguished from provider, capture and storage failures. Repeating the same unchanged placement problem must not be disguised as a transient database failure.

### 11.4 Acceptance evidence for this implementation pass

| Requirement | Evidence required before implementation is complete |
|---|---|
| Claims/evidence removed from new articles end to end | New discriminated packet contains article/source data and prepared content, with no formal claim/evidence arrays or tuple requirements; readiness, handoff, Entity processor and additive SQL writer accept that contract. The saved-evidence-reference rejection remains only in explicit legacy compatibility. |
| Candidate retrieval and Jev ownership | Active Research runner connects narrative/asset catalogue lookup, metadata-aware profiles, Jev primary/related decisions and explicit no-match/uncertain outcomes. Required Jev work cannot silently fall back to Hermes classification. |
| Story context and novelty | Actual placement feeds per-entity latest-five legacy/private context; Jev relationships retain valid historical IDs and raw probabilities; source and older-development deduplication remain available. |
| Researcher writing | Hermes writing receives the article, selected entity scope, connected history and relationship decisions; title/summary/body use the resulting context and dates. |
| Entity persistence | Active shared Entity runner consumes prepared article content, saves one shared immutable item and roles, validates historical links, checks new-entity equivalence and preserves replay/fencing/receipt guarantees. |
| Existing records and operations | Legacy records retain their compatibility path; applied migrations are not edited in place; an additive migration prepares the new database contract without executing it. API/UI, live processes, databases and source ownership are not modified during coding. |
| Honest verification | Source-level integration and diff audit is recorded. Tests, builds, TypeScript results, database behavior, model quality and production readiness are not claimed without the later authorized checks. |

Current status — 2026-10-05: the new article workflow has passed affected contract/decision tests, isolated PostgreSQL article persistence tests and the collectors TypeScript check. The additive migration is applied, and four internal pipelines are running with real accepted News articles. Research and Entity Manager remain News-only; Polymarket collection runs separately. The API is unchanged and downstream integrations remain excluded. The [article activation record](../operations/2026_10_05_article_pipeline_activation.md) records exact evidence, activation fixes, retained failures and semantic-quality limits; the [2026-10-04 implementation handoff](../operations/2026_10_04_article_researcher_implementation.md) remains the historical source-review record. Earlier passing checks in §§9–10 do not validate this new contract.
