# Issue 299 — internal pipeline implementation

> Historical record for the 3 October implementation/validation phase. For the current article contract, scope and operating checkpoint, use the [working PRD](../PRDs/v4_prd.md) and [5 October handoff](2026_10_05_v4_entity_manager_checkpoint_handoff.md). These dated results do not establish the current profile/model settings or new article semantic quality.

Date: 2026-10-03

Working specification: [V4 PRD](../PRDs/v4_prd.md)

## Effective scope

Scout → Intake → Research → Entity Manager → private durable shared knowledge.

The owner deferred all downstream integration: production knowledge-reader frameworks, independent consumer checkpoints, managed V1 projection, Editor, Publisher, X Desk, API and browser changes. The existing Research novelty gate and Entity's bounded grounding/context queries are internal pipeline work. Managed knowledge must remain isolated from existing publishing inputs.

## Implementation ownership

| Lane | Responsibility |
|---|---|
| Leo | Additive private PostgreSQL storage/functions, dedicated writer client, durable plans/leases/holds/receipts, shared Entity worker integration |
| Maya | Research artifact/result reuse, existing-knowledge gate, explicit old-incomplete assessment, bounded follow-up and durable SQLite reservations |
| Nora | Source-local ownership/fencing, collector/intake/worker controls, recovery/operator commands and operational reporting |
| Parent | Shared interface coordination, classification dispatch tightening, environment documentation, integrated handoff |

## Storage and dispatch contracts

Source-local SQLite owns source observations, canonical delivery obligations, intake/research jobs, immutable evidence/packets, Research outcomes and paid-call reservations. Private PostgreSQL owns managed item effects and their transaction domain: immutable plan attempts, fenced leases, append-only holds and terminal accepted receipts. Existing memory storage and indexes are preserved.

A managed operation resolves an accepted receipt before planning. A new or resumed attempt uses code-owned work identity, immutable packet/context fingerprints, grounded item/entity identities, expected absence/revisions and a live owner/epoch fence. Effects and the accepted receipt commit together. Overflow and unknown work retain their full material; they do not silently complete.

V4 classification requests tighten the gateway to one provider call and hold unknown dispatch outcomes. This also suppresses a second fallback or shadow call under the same reservation. Primary synthesis and Entity planning persist dispatch exposure before paid reasoning and use the structured gateway's hold-on-unknown policy. Known invalid-output repairs remain within the admitted provider allowance. Existing callers retain their prior behavior. A transport timeout cannot release a reservation or create a new follow-up allowance.

## Configuration preparation

The example environment keeps every V4 feature disabled. Activation requires explicitly selected `news`/`polymarket` sources and persistent source ownership. Managed writing uses `MYBOON_MANAGED_KNOWLEDGE_DATABASE_URL` and optional `MYBOON_MANAGED_KNOWLEDGE_DATABASE_CA` for an operator-provisioned dedicated LOGIN; the example does not contain credentials. TLS must validate the server certificate.

Reuse, primary synthesis and follow-up require explicit policy versions and limits. Example environment values are blank; this document approves no numeric freshness, spending, sample-size or quality threshold. Unknown cost remains unknown and must not be reported as zero.

The root assignment policy reserves aggregate provider/token/cost exposure across V4 paid stages. Per-stage reservations cannot create another assignment budget on retry or continuation. Source ownership receipts bind the secret-free configured policy values; stale policy evidence cannot authorize an ownership action.

Managed Entity planning imports the existing canonical Entity planning ceilings rather than introducing another set of numerical limits. Its durable dispatch record still prevents another paid plan when execution is unresolved.

Source ownership receipts also bind the current executed receipt ID and ownership revision. Sole-owner switches and retirement require worker-stop, private writer lease/fence and held planning-dispatch reconciliation evidence approved by the operator. Source SQLite authority is not itself a PostgreSQL writer fence; private writer epochs and unresolved dispatches must be independently reconciled before those artifacts are approved.

The writer role receives only named private-function execution, not direct managed-table mutation. Public API roles and `service_role` do not receive private writer execution. Private item storage is not a publishing projection.

The prepared `entity-v4:ownership` and `entity-v4:status` package scripts provide source ownership/recovery preparation and internal reporting. They have not been executed in this coding pass. Ownership actions require separately recorded source-scoped evidence and authority; a previously returned advisory result is not activation permission.

`entity-v4:research-assess-partial` admits an explicit bounded assessment of one retained work item. `entity-v4:research-reconcile` inspects or reconciles one exact reservation using retained code-owned evidence. These commands do not authorize historical bulk replay or pretend unsupported provider-result recovery exists. They are not run during this coding pass.

`entity-v4:planning-reconcile` prepares a resolution for one operation, attempt and request digest. Preview opens no database. Applying requires an attributable provider execution artifact confirming no execution and no charge, verified operator identity, and an expired operation lease checked by the private writer. No free-form release or unsupported recovery handle is accepted. Current transport outcomes without such evidence remain held; the command does not call a replacement paid planner.

## Execution boundary

The owner's current instruction is implementation only. No tests, builds, TypeScript checks, database rehearsals, runtime probes or pipeline checks are run while coding. Once all implementation is connected, the parent runs the collectors TypeScript check and resolves compiler errors. No test files are changed in this pass.

Database migration application, role provisioning, permission/concurrency/rollback rehearsals, semantic tests, paid evaluation, live pipeline inspection, deployment and restart remain later work. Prepared operator commands are code, not evidence that those actions occurred. Source retirement is logical and must preserve observations, research, evidence, receipts and history; this pass deletes no data and replays no backlog.

## Final implementation record

All three implementation lanes finished and froze their source changes before the final compiler phase.

| Lane | Saved implementation |
|---|---|
| Research | Active shared-worker novelty, bounded follow-up and durable synthesis; aggregate assignment reservations; strict evidence/result reuse with producer attribution; legacy/private managed context; saved-result/unknown-outcome recovery; explicit retained-partial assessment and reconciliation commands. |
| Entity | Additive private migration and function-only writer; grounded shared entities/items; immutable prose and appended history/corrections/attachments; durable plans, context, leases, holds and receipts; receipt-first shared-worker recovery; planning dispatch holds and proof-bound reconciliation; legacy ownership/final-write guards. |
| Operations | Durable source-local ownership/activity, native claim/admission fences, observation-preserving collector controls, intake authority, evidence-bound operator paths, explicit default-off policies, PM2 configuration propagation and internal operational status. |

The migration is `supabase/migrations/20261003090000_entity_manager_v4_private_knowledge.sql`. It is saved only: no role provisioning, migration application or SQL rehearsal occurred. `pg` and its TypeScript types were added to the collectors package and lockfile; the operator script names above are connected to their source files.

**Final TypeScript result:** `pnpm exec tsc --noEmit` from `/home/ubuntu/myboon/packages/collectors` passed on 2026-10-03 with exit code 0. The first final compiler pass identified missing follow-up exports and Research owner-port narrowing; those source errors were fixed before the successful rerun. No tests, test-file edits, builds, database checks, provider calls, pipeline checks, deployment, restart, replay or deletion occurred in this coding pass. Changes remain local and uncommitted.

The revised implementation goal is complete. Behavioral validation and activation remain deferred. Compiler success establishes TypeScript compatibility only; it does not establish database behavior, cost savings or production readiness. All downstream integration remains outside this implementation.
