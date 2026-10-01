# Entity Manager V4 — Working PRD

Date: 2026-10-01
Status: working implementation record. Local implementation authorized in this session; activation gates remain closed.
Parent: [#299 — Entity Manager V4 implementation](https://github.com/b-bhu/myboon/issues/299)
Local implementation: `main` in `/home/ubuntu/myboon` (prepared on `codex/issue-299-v4` in `/home/ubuntu/myboon-issue-299-v4`)
Owner: myboon product / Entity Manager

This is the canonical working document for V4. It consolidates the #299 issue body, the reviewed PRD snapshot embedded in it, the four chronological issue comments (investigation, owner decisions D1/D2, phase labels, preparation checkpoint), and the current local implementation. Where older text conflicts with this document, this document defines V4.

---

## 0. Authorization state and what this document is not

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

Complete useful work with less repeated reasoning, preserve Research's authority over its handoff, and expose reusable entity knowledge with reliable provenance and history.

### 1.3 Storage model (unchanged from the reviewed snapshot)

- **SQLite is the working desk.** Observations, jobs, ownership, saved research, evidence references, plans, retries, required next actions. News and Polymarket keep separate local database files under shared worker contracts. V4 does not move internal job polling into Supabase.
- **Supabase is the knowledge library.** Accepted entities and items, their sources, history, durable changes. It already serves product output.
- **A timer is a reminder to check the desk.** A stage finishes only when its result and required next action, or a deliberate no-action outcome, are saved safely.

### 1.4 Scope decisions against the original seventeen items

| # | Original improvement | V4 decision |
|---|---|---|
| 1 | Scout discoveries reliably reach canonical intake | **Include.** Persist delivery responsibility with the observation; recover an unchanged observation whose earlier delivery failed. |
| 2 | Intake decision and required research work saved together | **Include.** One local transaction, or a durable acknowledged handoff where a boundary is crossed. |
| 3 | Wake deferred signals when they become eligible | **Exclude.** No new automatic reconsideration, stale-work catch-up, or deferred-signal scheduler. Existing bounded transport retries and lease recovery remain. |
| 4 | Check existing knowledge before research spend | **Reuse and connect.** `research-gate/gate.ts:gateSignal` exists in the older Polymarket route; connect it to shared News/Polymarket Research with bounded context. Not complete end to end today. |
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

Separate redirect/auth/runtime findings, historical backlog replay, production data deletion, new X/exchange collectors, deep activation, broad ontology work, and public feed redesign remain outside this issue. Nothing in this session authorizes any of them.

### 1.6 Responsibilities

**Research owns research judgment and what it hands over. Entity Manager treats that as authoritative research input.** Entity Manager organizes, summarizes, links, saves coherent knowledge while preserving meaning, attribution, uncertainty. It does not independently reassess research sufficiency or demand another investigation because details remain unanswered. Source text remains data, never workflow instructions.

| Area | Current verified behavior | V4 change |
|---|---|---|
| Scout → intake | News saves observations before delivery; unchanged headline/summary can skip a later delivery. | Save a durable delivery obligation; acknowledge canonical intake independently of content change. |
| Intake → Research | `SignalIntakeCoordinator.process` appended decision and admitted work in separate calls; missing-decision retry did not repair a decision with missing work. | Commit decision and required action together without repeating paid reasoning. **Delivered locally in `efc12ae`.** |
| Prior-knowledge gate | `gateSignal` exists and is composed in legacy Polymarket research; shared Research does not call it. | Reuse novelty in the shared path with bounded, coverage-aware context. |
| Jev | Registry/gateway exist; novelty is a defined capability. Runners can pass an enabled flag with no classifier port. | Compose only supported V4 ports. An enabled flag must never imply wiring exists. |
| Research reuse | Shared Research reuses evidence/packets for the same work item. | Extend suitable artifact reuse across distinct jobs and both sources. |
| Research → Entity | Research forwarded packets regardless of completeness; Entity adapter and processor blanket-rejected `partial`/`failed`. | Research-owned handoff outcome separate from completeness; accept useful attributed/unresolved knowledge. **Contract landed locally; attachment writer not built.** |
| Entity planning | Canonical planner selects one primary entity, at most one retained memory; retries can rerun planning after remote effects. | Bounded shared-item plan, persisted, receipt discovered before planning again. |
| Knowledge | Memories hold prose, dates, evidence, metrics, provenance, replay identity; reconciliation may update accepted prose in place. | Shared item membership, immutable accepted prose, appended developments/corrections, durable changes, truthful historical reads. |
| Legacy queues | Old candidate/observation tables still serve dedupe, backlog gates, recovery, source history. | Retire only obsolete queue ownership after proven cutover. Large pending counts do not make rows disposable. |

These are code/audit observations, not claims about current production liveness.

---

## 2. Acceptance criteria from #299

Verbatim from the issue. The full agreed scope is preserved here — this list is **not** narrowed to what has already been implemented. Each criterion's actual status is tracked separately in §7; only AC1, which is itself a documentation obligation, is currently satisfied.

1. Implementation design records the outstanding gates in the single PRD and preserves the explicit exclusions.
2. Scout/intake crash fixtures recover one logical job with its saved decision; no admitted action is lost between saves.
3. Research-ready attributed partial output reaches Entity without a second research sufficiency judgment; unusable output has an explicit failure/blocked outcome.
4. Shared News and Polymarket demonstrably consult bounded relevant knowledge and reuse eligible evidence/research without hiding new information or inventing corroboration.
5. Jev activation meets reviewed quality/cost/latency gates; the one-follow-up allowance and budgets survive retries and continuation.
6. Lost remote replies and concurrent/delayed attempts resolve through saved plans/receipts without duplicate accepted effects or unnecessary replanning.
7. Shared item identity, immutable prose, provenance, correction history, and earlier as-known views pass the PRD fixtures.
8. Independent consumers resume without skipped changes, handle removals/retractions, and do not automatically republish evidence-only updates.
9. Managed-row persistence and v1 compatibility prevent old writers or unaware publishing consumers from violating the new contract.
10. Source cutover and rollback establish one active owner and preserve observations, research, evidence, and accepted history before obsolete queue ownership retires.
11. Relevant package tests and migration/rollback rehearsals pass for the implemented slices; operational improvement and total model cost are measured rather than assumed.

The full fixture table in the reviewed snapshot (Ethena-shaped attributed partial, SEC complaint/response/clarification, mixed repeated/new coverage, overflow, as-known history, redirects, legacy writer denial, independent cursors, publisher status handling, ownership cutover) remains the acceptance surface. See §9 for per-requirement status.

---

## 3. Owner decisions

### 3.1 D1 — Older, incomplete research: preserve and assess

From the 2026-09-30 owner decision comment, still binding.

Older validated complete packets retain the supported legacy path. Older **incomplete** packets without a new readiness decision are held as `readiness_unknown`, Research-owned, and not automatically schedulable for Entity. Engineering defines the assessment and readiness transitions.

Explicitly forbidden: auto-promoting to ready, permanently rejecting, or bulk-rerunning the historical backlog. Some older work may remain waiting for assessment indefinitely. D1 does not change the supported validation path for older complete results, and it does not authorize replay.

A bounded, explicitly admitted assessment reads retained material and its provenance, validates linkage and evidence availability, records assessment identity/reason/version atomically with a new action or hold, and never rewrites the original packet. It may conclude ready-with-limitations, resolved-without-item, blocked, or failed. An absent capture or inability to assess stays unknown/held — never a fabricated result. Local implementation status: `createReadinessUnknownReadiness` and the non-claimable hold routing are committed; the *admitted assessment runner* does not exist yet.

### 3.2 D2 — Unknown outcome of a paid provider dispatch: recover or hold, never auto-replace

Also from the 2026-09-30 owner decision comment, still binding.

A timeout is not proof the provider did no work or charged nothing.

- Preserve the spending reservation and the **same logical assignment/allowance**.
- Attempt recovery only through a mechanism the provider actually supports.
- If the outcome stays unknown, **hold the item for intervention**.
- Never automatically issue a replacement paid call. Never reset the allowance.

The owner accepts this per-item delay to prioritize avoiding duplicate spend. This is a recovery policy, not a guarantee that provider charges can always be recovered or prevented. Local status: **not started.** The ledger belongs to the Jev/reservation slice (§5, stage 3).

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
4. **Compatibility-first readers.** Additive v2 capabilities on the existing internal `EntityKnowledgeReader`. Preserve v1 DTOs/routes with documented reduced semantics; add a safe read-only v1 projection where a legacy reader must keep querying `entity_memories`. No new hosted API or MCP surface. No public feed redesign.

**The physical schema is conditional.** Whether `entity_memories` body + UUID reuse is viable, versus the single-body-table alternative with stable UUID mapping and a read-only v1 projection, is decided by the authorized isolated rehearsal — not decided in advance here. This PRD is not migration SQL.

### 3.5 Physical-schema constraints the rehearsal must settle

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
| **0 — contracts / compatibility** | `signal-platform/platform-store.ts`, `store-adapter-contract.ts`, `triage-contracts.ts`; `entity-manager/types.ts`, `canonical-packet-adapter.ts`, `entity-knowledge-reader.ts`. Rehearsal covers `supabase/migrations/*`, `entity-manager/supabase-store.ts`, `entity-knowledge-reader.ts`, `publisher/supabase-store.ts`, `editor-draft/supabase-store.ts`, `x-desk/source.ts`. | Technical decisions only | **Synthetic PostgreSQL 15 rehearsal run locally** (§6.5). It rules out replacing the legacy memory table/index in a rolling deployment and points to additive managed tables plus a read-only V1 projection. Migration-specific rehearsal remains to be added. | No production changes. Keep the legacy table/index; managed data stays in separate tables behind the controlled writer. |
| **1 — observation / intake durability** | `news/ingestion.ts` (observation + outstanding delivery obligation); `polymarket/markets-data-engineer.ts` (prior-baseline-derived observation, atomic baseline+observation+delivery); `signal-platform/signal-intake.ts`, `source-intake.ts`, `sqlite-platform-store.ts`, `store-adapter.ts`. | Minimal result/action contract | **Intake + both local collector outboxes implemented, committed locally, and passing focused tests.** | Disable new source composition with a compatible binary; retain obligation tables and pending deliveries; never run two intake owners. |
| **2 — Research checkpoints / readiness / reuse** | `research-engine/shared-worker.ts`, `run-shared-research.ts`; `signal-platform/research-readiness.ts` (new, local); discovery/retrieval manifests; producer-owned artifact references. | Stage 0 readiness/artifact contract; stage 1 for integrated admission | **Readiness, retrieval checkpoints, and source-owned artifact links are committed locally.** Candidate discovery and synthesis use are outstanding, so cross-source reuse is not active. | Turn cross-work reuse and v2 admission off for new jobs; keep version-aware readers and reconciliation for saved outcomes; retain all artifacts/refs and legacy packet readability; no replay of historical partials. |
| **3 — novelty / controlled spend** | `research-gate/gate.ts`, `types.ts`, `supabase-reader.ts`; `research-engine/shared-worker.ts`, `run-shared-research.ts`; `inference-gateway/classification-definitions.ts`, `classification-types.ts`, `classification-configuration.ts`; `signal-platform/active-triage.ts`; `news/run-news-feed-ingestor.ts`; `polymarket/run-markets-data-engineer.ts`. | Stage 2 | **Not started.** Conservative `uncertain` and no-addition behavior is selected (§3.3); exact numerical limits and measured activation gates remain open. Implement disabled-by-default and test without paid dispatch. | Disable the new workload/reuse gate, return to bounded direct Research. Keep outcome/budget audit and reservations; config rollback does not reset an assignment's allowance. |
| **4 — saved plans / managed writer** | `entity-manager/canonical-planner.ts`, `canonical-processor.ts`; `entity-manager/supabase-store.ts`, `entity-service.ts`, `resolver.ts`; reviewed `supabase/migrations/`; private writer schema/function. | Stage 0 isolated compatibility rehearsal + stage 2 readiness | **Physical direction selected from the synthetic rehearsal:** additive managed-item storage and a safe read-only V1 projection; exact DDL/function grants and migration rehearsal remain to implement. Managed production stays off regardless. | Stop managed writes and fence authority; keep receipts, data, guards, readers. Revert to a compatible V4 binary or pause claims. Never restore legacy mutation over managed rows, never drop history, never recreate an incompatible full-tuple index over managed duplicates. |
| **5 — readers / consumers** | `entity-manager/entity-knowledge-reader.ts`, `supabase-entity-knowledge-reader.ts`; `packages/api/src/entity-knowledge.ts`; `editor-draft/supabase-store.ts`; `publisher/supabase-store.ts`; `x-desk/source.ts`. | Stage 4 commit contract; fixture work may overlap | **Not started.** Consumer support is a managed-exposure gate. | Keep publishing paths on their prior supported inputs or pause them. Never reconnect an incompatible publishing reader; never hide existing receipts/corrections. |
| **6 — evaluation / canary** | `signal-platform/cutover-receipt.ts` (currently does not cover intake), shadow evaluation, cost/latency measurement. | Integrated 1–5 plus approved thresholds and activation decisions | **Not started.** Activation gate. | Source/workload kill switches plus writer epoch fence; reconcile committed operations; pause unsafe paths; preserve data and consumer cursors; no automatic backlog replay. |
| **7 — ownership cutover / legacy queue retirement** | `research-engine/legacy-ownership-guard.ts`, `entity-manager/legacy-ownership-guard.ts`; `signal-platform/operator-backfill-sqlite.ts`, `pipeline-store/failure-recovery.ts`, News observations, Polymarket candidate paths. Extend ownership receipts to collector/intake queue writes, which existing receipts exclude. | Healthy stage-6 source window + retention/restore evidence | **Not started.** Requires separate authorization. | Restore a compatible sole owner from reviewed receipts/config; keep canonical receipts/artifacts/history and fences; reconcile outstanding deliveries. Retirement is logical — physical deletion needs separately authorized inventory/retention work. |

Suggested order: **0 → 1 → 2/3 and compatible 4/5 development → 6 → 7**. B/C-style later stages are not blanket prerequisites for every earlier development task; their contracts must agree before integration. Reliable new work must be demonstrated before separately considering historical recovery.

---

## 5. Implementation design per next slice

### 5.1 Stage 1 remainder — collector-side observation/delivery obligations

*Status: concrete local design, reviewed against current source and SQLite boundaries; implementation not started.*

Use the existing source-local SQLite databases and a small shared outbox contract, not a new service:

- Shared contract/helper: `packages/collectors/src/signal-platform/source-delivery-outbox.ts`. An immutable obligation is keyed by canonical `signalId` and stores validated Signal JSON, a canonical digest of the immutable Signal fields (excluding poll-only `observedAt`, matching canonical intake's duplicate semantics), pending/delivered state, attempt count, timestamps, and a redacted last-error code. Reusing an ID with another semantic payload digest is a hard conflict. Delivery is at-least-once; canonical intake's stable identity makes exact replays idempotent. No database transaction spans source observation and canonical intake.
- News: extend `NewsStore` and its additive SQLite schema with an outbox table. In the same transaction that inserts each new/material `news_candidate_observations` row, insert its exact adapted Signal obligation. On each ingestion run, drain older pending obligations before processing the new feed, then deliver newly inserted obligations. `known_unchanged` is never used to infer that an older obligation was acknowledged. Do not create new obligations for historical rows during migration.
- Polymarket: extend `PipelineStore` and its additive SQLite schema with immutable market-observation/outbox rows. Add one store operation that, on its single SQLite connection/transaction, commits the fetched watchlist baseline together with all material observations and exact Signal payloads derived against the pre-update baseline. Drain saved obligations before fetching/committing the next baseline. Only after that commit may canonical intake run; legacy backlog/backpressure and candidate-thread writes stay downstream and cannot erase a canonical delivery obligation. Keep the existing file path shared by `SqlitePipelineStore` and `SqliteSignalPlatformStore`.
- A successful return from an `observe` or `active` intake acknowledges the source obligation, including an idempotent duplicate; `off`, a thrown intake, or a process exit before acknowledgement leaves it pending. Persist failures as redacted codes, not provider/database error text. Never mark delivered before intake returns. The legacy collector continues if canonical delivery fails, while the next run retries the frozen payload, not a reconstruction from a newer poll.
- These are internal SQLite migrations only. Additive defaults preserve old rows/readers; migration creates no obligations from old observations and performs no historical replay. Physical Supabase design remains separately conditional on the authorized rehearsal (§5.4).

Required tests: migration over a pre-outbox fixture without rewriting rows; exact replay after a failed intake and process/store reopen; same-ID/same-digest idempotency and same-ID/different-digest rejection; feature-off does not enqueue/replay; observation/outbox transaction rollback leaves neither half; source intake succeeds but a crash before source acknowledgement safely redelivers once by canonical identity; News unchanged polls cannot suppress pending delivery; Polymarket compares against prior baseline and commits baseline plus outbox atomically; old backlog gates do not suppress durable canonical observations; both pending outboxes survive backup/restore; legacy readers and candidate processing remain compatible.

Item 12 boundary, as required by scope: source adapters supply native identity, observation/provenance, and source policy/capabilities; shared workers own lifecycle. Register only News and Polymarket. `research-engine/run-shared-research.ts` currently holds source maps that must be accounted for.

### 5.2 Stage 2 remainder — shared knowledge context and cross-source reuse

*Status: retrieval checkpoints and the first source-owned artifact link are implemented locally. Candidate discovery and synthesis use remain to design and wire.*

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

*Status: proposed names/schema, not yet reviewed. Update before coding.*

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

*Status: proposed names/schema, not yet reviewed, and physically conditional on the rehearsal. Update before coding.*

Proposed files:

- `packages/collectors/src/entity-manager/progression-plan.ts` — bounded plan + validator.
- `packages/collectors/src/entity-manager/progression-processor.ts` — plan execution against the managed writer.
- `packages/collectors/src/entity-manager/knowledge-operation-store.ts` — private-writer client, operation receipt, fencing.

Logical contract (from the reviewed snapshot; `ItemDraft` and `ExistingItemOperation` remain placeholders to be specified in the implementation contract):

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

Caps: the previously proposed four items per packet, eight entity links per item, four outgoing continuity links, thirty-two evidence references, and six thousand characters per note remain **provisional evaluation inputs**, not approved calibrated limits and not targets to fill. Versioned caps must be explicit before rollout. Any output repair must fit the existing provider-call and cost allowance.

Overflow: durable hold, all unprocessed groups preserved, **zero partial knowledge commits from that plan**. No silent truncation, no parent completion while material overflow remains. A separately reviewed/admitted bounded continuation processes retained groups under an explicit revised work plan, retaining root assignment/allowance and allocated contribution identities. V4 has **no automatic deferred-work wakeup service**; operators resolve through supported controls. Continuations and retries cannot duplicate accepted contributions or reset follow-up limits.

Ordering rules:

1. Checkpoint the normalized validated plan and hash **before** downstream writes.
2. Keep immutable plan content separate from append-only execution outcomes.
3. Resolve an existing receipt for the logical operation **before** model/configuration-version checks — changing a provider or prompt cannot cause accepted knowledge to be written again.
4. For an uncommitted plan, changed material inputs, decision/policy versions, or target revisions require explicit targeted revalidation or a new validated plan revision. Never overwrite an accepted plan or repurpose its operation identity.
5. Serialize against any earlier in-flight attempt first: an already accepted receipt wins, a stale revision cannot commit later.
6. Lock target entities/items in deterministic order, check target/authority revisions at **commit** time, commit all effects plus the receipt in one transaction, then acknowledge local completion.
7. Stable operation identity + digest rejects conflicting replays. A stale target leads to targeted revalidation or a hold, never unconditional overwrite.

Semantic cross-source deduplication is a grounded validated decision, not an entity ID or prose hash.

### 5.5 Stage 5 — readers and consumers

*Status: proposed, not yet reviewed. Update before coding.*

Proposed: `entity-manager/knowledge-reader-v2.ts` plus a Supabase adapter, or additive v2 capabilities on `entity-manager/entity-knowledge-reader.ts` directly.

Required reader properties: stable item identity across all legitimate entity views and cross-entity deduplication; pagination ordering stable within a defined snapshot; current-view entity resolution honoring existing redirects and membership/status corrections; historical views using only identity knowledge available at the cutoff and disclosing unavailable redirect history; explicit filters/limits/source availability/uncertainty/status/truncation; missing/withheld/unavailable evidence never masquerading as an empty successful lookup; event-time and as-known modes with cutoffs applied to links, evidence, and corrections as well as item creation; cursors binding the filter and snapshot.

Changes are **immutable append-only records** committed with the effects. Polling mutable `updated_at` rows cannot preserve intermediate changes. A **safe durable publication watermark** is required: a bare sequence or application timestamp does not prove commit ordering, because a lower number can commit after a higher one was delivered. Use one transactionally locked knowledge-clock row, held to commit/rollback, allocating and exposing the visible watermark atomically with the changes and receipt. Consumers never read beyond that watermark.

At-least-once delivery, independent durable consumer checkpoints, dedupe by change identity. An evidence-only change to an already-seen item must not vanish. Link removals/corrections identify prior **and** current affected entities so a filtered subscriber learns the item left its timeline.

Consumer obligations:

| Consumer | Required behavior |
|---|---|
| Internal Research | Bounded accepted knowledge + citation hydration with limitations visible; same authoritative item IDs; a failed/truncated/unrelated lookup is never complete coverage. |
| Editor | Deduplicate one item across entity lanes; track processed changes/revisions in addition to item IDs (reviewed-ID suppression would hide later evidence/corrections); new evidence may invalidate a selection without forcing prose generation; retain editorial selection. |
| Publisher | Preserve existing source memory UUIDs and Story IDs; check **every** exact reference's status/revision; missing hydration must not be silently omitted; recheck support/status at the publication commit to close the read/write race; pause invalid drafts for explicit replacement rather than auto-republishing a superseded draft. |
| X Desk / other teams | Move dedupe from `(memoryId, updatedAt)` to change ID/revision; handle evidence-only, removal, correction, retraction events; invalidate unsent stale candidates; keep its own cursor and output selection. |
| API / internal browser | Allowlisted provenance/evidence/limitations/status DTOs under existing authorization; v1 API currently excludes provenance/evidence/context; adapt direct `entity_memories` browser/profile reads to the safe projection. RLS/permissions and service-only RPC execution apply to new storage; raw private research/context never crosses the API. |

Start with a read-only internal research consumer and reviewed fixtures. Adopt publishing consumers before they receive managed production items. Evidence-only events are not compulsory paid rewrites. One slow consumer cannot block accepted knowledge or other teams.

### 5.6 Stages 6 and 7 — evaluation, cutover, retirement

Stage 6 must produce a reviewed direct-processing baseline and cover the whole crash/replay suite before any activation. Measure total provider calls, input/output usage, fallback/repair rates, repeated inference on retry, median/tail completion time, and cost where available. Track **both cost per correctly resolved input and cost per useful accepted item**, so cheap false discards are not disguised as efficiency. Charge shadow evaluation expense separately from production cost.

The sample sizes, quality thresholds, cost-reduction targets, and latency targets proposed in the older comments are **proposals awaiting product approval, not measured results**. Require a reviewed baseline, explicit thresholds, and stated sample sizes before enabling Jev or managed production. If the savings target fails, retain correct direct processing and leave the classifier off. News first, then Polymarket. A source starts at a small bounded selection only after the gates pass, with its evaluation/canary allowance bounded separately.

Stage 7 inventories `news_candidate_observations`, `news_research_results`, `pipeline_candidates/research/editor` dependencies across dedupe, backpressure, recovery, maintenance, and backfill. Existing Research/Entity cutover receipts **exclude intake**, and the Research/Entity guards do not stop collector queue writes — record a source-level cutover rule/receipt separating retained observation capture from retired mutable queue bookkeeping, and prove no obsolete collector queue writes remain. Use backups, source-by-source parity checks, ownership receipts, a rehearsed rollback, and an agreed observation window. Retire obsolete admission/claiming only after the canonical path proves healthy and residual references are accounted for. Preserve observations, evidence, research, accepted knowledge, identity mappings, and retained history. Large pending counts do not establish that rows are disposable.

---

## 6. Exact current implementation state in this worktree

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

## 7. Evidence table

Status per requirement. **Nothing here claims #299 is complete.**

| #299 requirement | Status | Evidence / blocker |
|---|---|---|
| Single working PRD preserving full scope and exclusions | **Complete** | This document. |
| Owner decisions recorded (D1, D2) | **Complete** | §3.1, §3.2. |
| Conservative Jev activation and recovery policy recorded | **Complete** | §3.3. |
| Stage matrix with dependencies, rollback and activation gates | **Complete** | §4. |
| AC1 — implementation design records gates, preserves exclusions | **Complete** | §3, §4. Executed tests as designed are a separate matter. |
| AC2 — scout/intake crash fixtures recover one logical job with its saved decision | **Complete locally** | `intake-durability.test.ts`, News outbox retry/reopen/lost-ack tests, Polymarket baseline/outbox rollback and failed-intake recovery tests. |
| AC3 — research-ready attributed partial reaches Entity without a second sufficiency judgment | **In progress** | Landed and passing locally. The owed `evidence_attachment` has no writer and fails closed. |
| AC4 — shared News/Polymarket consult bounded knowledge and reuse eligible artifacts | **Not started** | §5.2. |
| AC5 — Jev activation meets reviewed gates; allowance and budgets survive retries | **In progress** | Conservative uncertain/no-addition policy selected (§3.3); reservation implementation is not started. No numerical budget or activation thresholds approved; Jev stays off until measured gates pass. |
| AC6 — lost remote replies resolve via saved plans/receipts, no duplicate accepted effects | **Not started** | §5.4. |
| AC7 — shared item identity, immutable prose, provenance, history, as-known views | **Not started** | §5.4. |
| AC8 — independent consumers resume without skipped changes or forced evidence-only republishing | **Not started** | §5.5. |
| AC9 — managed-row persistence and v1 compatibility fence old writers and unaware publishing consumers | **Not started** | The isolated PostgreSQL rehearsal rules out modifying the legacy unique-index surface during rolling deploy; additive managed tables and a read-only V1 projection are the local design direction, not implemented or deployed. |
| AC10 — source cutover and rollback establish one owner and preserve history before retirement | **Blocked by activation gate** | Stage 7 needs a healthy stage-6 window plus retention/restore evidence; separate authorization required. |
| AC11 — relevant package tests and migration/rollback rehearsals pass; cost measured not assumed | **Partial** | Local package tests pass except the three unrelated expired-review-policy failures (§6.4). The initial synthetic PostgreSQL experiment is recorded in §6.5; the proposed Stage 4 migration/rollback rehearsal has not run. Nothing measured yet. |
| D1 assessment runner for `readiness_unknown` material | **Not started** | `createReadinessUnknownReadiness` exists; the explicitly admitted bounded assessment does not. |
| D2 reservation ledger and recovery transitions | **Not started** | §5.3. |
| Stage 0 isolated PostgreSQL compatibility rehearsal | **Partial** | Synthetic PostgreSQL 15 run completed; it did not apply the full migration chain or the proposed V4 migration. Follow-on SQL/RLS/writer receipt/rollback tests remain. Production schema/data access is not authorized. |
| Historical packet-local handoff rejections (3,216 partial / 287 failed), 111 past-deadline pending jobs | **Not addressed — inventory only** | Historical findings. Explicitly not a replay recommendation, and D1 forbids bulk rerun. |

### Known blockers

1. **Follow-on isolated compatibility rehearsal** — the initial compatibility experiment is complete, but Stage 4 SQL does not yet exist and has not been rehearsed against synthetic rows/roles/RLS. This does not block local stages 1–3 work.
2. **No approved numerical budgets or evaluation thresholds** — Jev/follow-up stays feature-gated and off until limits are selected and measured.
3. **Three expired-review-policy test fixtures** — needs an owner review decision, not a code workaround.
4. **Evidence limit on D1 repair** — proven, reconstructable legacy admissions may be few or none. Repaired and held/ambiguous records must be reported separately; never claim the slice can auto-repair all old decision-without-work rows.

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

## 9. Immediate next coding slice

**Recommendation: stage 2 — shared Research checkpoints, readiness, and cross-source reuse.**

Rationale: Stage 1 now has durable source-side obligations for both current collectors, retries frozen payloads across unchanged polls/restarts, and commits Polymarket's source baseline with its obligations. The checks passed locally: News 94/94, Polymarket collector 16/16, pipeline-store 90/90, focused adapter 6/6, and TypeScript build. No production schema or data was touched. The next work is to define the exact artifact/retrieval-manifest contracts and source-store ownership in §5.2 before implementing them. Stage 3 remains disabled by default pending measurements and approved limits; Stage 4's physical design awaits the authorized isolated rehearsal; Stages 5–7 depend on Stage 4.

Proposed tests for that slice: injected failure around each observation save and delivery boundary; recollection of unchanged content still reaching intake; a crash after the Polymarket baseline save preserving the original move; exactly one accepted decision and one logical job on duplicate delivery; retained observation/native identity until delivery acknowledgement; and a rollback check that a compatible sole intake owner resumes without deleting obligations.
