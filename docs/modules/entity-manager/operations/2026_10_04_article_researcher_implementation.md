# Article-based Researcher implementation — 2026-10-04

> Historical implementation-only record. The [current PRD](../PRDs/v4_prd.md) and [5 October checkpoint handoff](2026_10_05_v4_entity_manager_checkpoint_handoff.md) describe the subsequently validated and activated workflow; tests are no longer deferred.

Status: implementation complete; production composition and compatibility reviewed in source. Behavioral, TypeScript, database and model validation remain deferred. This record supersedes the prior claim/evidence contract for new articles, not the historical validation results of that earlier contract.

Later operating status: the owner requested activation on 2026-10-05. The [article pipeline activation record](2026_10_05_article_pipeline_activation.md) records the subsequent checks, additive database migration, runtime fixes and successful restart. It supersedes the deferred status above; the remaining text describes the earlier implementation-only pass.

The owner approved the [article-based revision](../PRDs/2026_10_05_v4_prd_pre_checkpoint_snapshot.md#11-article-based-researcher-revision--2026-10-04) and requested `gpt-5.6-terra` at high reasoning with the parent orchestrating. The agent service accepted that configuration. Separate agents own Researcher/decision code and Entity persistence/the additive migration; a read-only agent audits packet and readiness compatibility. The parent owns the internal legacy reader, store compatibility, this record, the PRD and integration review. Existing uncommitted work is preserved.

## Required result

New Researcher work uses the captured article as its source: article text, source identity/URL and publication/observation dates. Formal claims, verified-fact arrays, evidence edges and evidence-reference validation are removed from the new output, readiness, handoff, Entity Manager and database writer path. Existing captures remain durable source provenance. Legacy packets remain explicitly readable; new articles are not disguised as empty legacy packets.

Researcher retrieves catalogue/private entity profiles with names, aliases, summaries and scope; Jev selects the primary entity and independently evaluates related memberships. Selected entities determine the latest-five story context. Jev supplies novelty and narrative-relationship judgments; Researcher uses Hermes to write a dated title, contextual summary and optional fuller body. Last-five context is bounded story context, with source and targeted older-development deduplication maintained separately.

Entity Manager consumes the prepared development, checks identities and any proposed entity for equivalence/ambiguity, and saves one immutable shared item, primary/related memberships, valid historical links, dates and source provenance. It does not repeat placement through a freeform claim planner. Durable receipts, fenced leases, source ownership and replay safety remain required. A duplicate, missing entity or ambiguous placement has an explicit outcome rather than an unexplained transient-storage retry.

## Scope and execution

- Production code scope: collectors Research, signal-platform contract/readiness/handoff, internal research context, typed Jev inference workloads, managed Entity processing and private writer support.
- Database changes are prepared in an additive migration; previously applied migrations are not edited in place. No migration or data mutation is executed in this pass.
- No API/UI, downstream readers, publisher/X Desk, broad adapters or historical rewriting is included. The current story UI reads legacy memory summaries; this pass prepares content and private persistence only.
- Existing pipelines stay stopped and `myboon-api` is untouched.
- No tests, builds, TypeScript checks, live provider evaluations, database rehearsals or runtime restarts are run in this implementation pass. Source and diff review are the available verification evidence.

## Implementation and review evidence

The updated work list is:

1. Remove claims/evidence end to end, including Entity Manager's rejected-evidence-reference requirement.
2. Retain full captured article text, source identity/URL and dates.
3. Use Jev for primary/related placement, duplicates, novelty and story relationships against each selected entity's latest five entries.
4. Let Researcher write the dated title, contextual summary and optional body using Hermes after those decisions.
5. Let Entity Manager persist one shared immutable item, its memberships and valid earlier-development links.
6. Explicitly handle missing, ambiguous and conflicting entity/duplicate decisions.
7. Preserve older records, chronology, source provenance and replay/lease protections.

| Requirement | Connected production implementation |
|---|---|
| New contract and readiness | `signal-platform/contracts.ts`, `validation.ts`, `research-readiness.ts`: distinct `myboon.research_packet.article.v1` packet and article readiness with source coverage, no claims/evidence placeholders. Stable readiness IDs and outcome/action invariants remain enforced. |
| Durable handoff and compatibility | `platform-store.ts`, `sqlite-platform-store.ts`, `entity-manager/sqlite-entity-work-port.ts` retain packet/readiness unions. Explicit legacy validators, reuse/follow-up narrowing and legacy shadow exclusions prevent article packets entering old claim processing. |
| Internal retrieval | `research-gate/supabase-reader.ts`, `managed-context-reader.ts` retain actual legacy IDs and profiles, bounded metadata/alias-aware candidate retrieval, per-entity recent history and separate targeted older duplicate lookups. Failed context coverage holds rather than fabricating an empty catalogue. |
| Jev decisions | `inference-gateway/classification-*`, `research-engine/article-placement.ts`, `durable-classification.ts` register Jev-only article placement, proposal validation, batched related memberships, relationships and novelty. Raw choice distributions, durable historical targets and conflicting-judgment holds are retained. |
| Researcher writing and proposal | `structured-synthesizer.ts`, `durable-article-proposal.ts`, `durable-synthesis.ts`, `shared-worker.ts`, `run-shared-research.ts` connect source-grounded creation proposals and post-decision prose. Whole capture plus connected history feeds writing; source URL retrieval replaces web search/deep dispatch in the configured new flow. Saved responses and unknown dispatches retain durable protection. |
| Deterministic Entity persistence | `entity-manager/article-persistence.ts`, `managed-canonical-processor.ts`, `postgres-knowledge-writer.ts` consume prepared article content before the legacy planner. `20261004103000_entity_manager_article_private_knowledge.sql` adds private article content, history links, source attachments and named context/writer functions. Previously applied migrations are unchanged. |
| Operator recovery | Retained partial assessment accepts the readiness union; reservation reconciliation supports saved article synthesis and saved creation-proposal responses without starting paid work or promoting queue rows. |

The parent and compatibility agent reviewed the production composition and source boundaries. Defects found during source review included old union consumers, missing readiness invariants, deep routing into a rejected synthesis path, raw probability validation, ungrounded duplicate targets and incomplete context handling. These were repaired without executing the program. The final persistence audit repaired CTE scope, candidate-ID deduplication, narrow grants, existing private-entity reuse, SQL JSON-null handling, duplicate memberships, accepted-receipt fields and scoped revision fencing. The parent also made hold branches explicitly return, retained ambiguous-identity holds, scoped history to requested entities and preserved event/publication/observation chronology and redirect URL matching in the internal reader.

Both implementation lanes are frozen. No new test files were written in this pass, and pre-existing test/dependency/configuration work was preserved. Agent diff-whitespace reviews were clean; the parent performed source integration review without invoking a compiler, test runner, SQL engine or runtime.

No passing test, compiler, SQL, provider-quality or production-readiness result is claimed for the new article contract.

## Prepared activation requirements and current limits

- The new path is guarded by `ENTITY_V4_ARTICLE_WORKFLOW_ENABLED=1` with the existing managed writer, persistent ownership and explicit V4 policies configured. `ENTITY_V4_ACTIVE_SOURCES=news`; Polymarket remains excluded.
- Apply the new additive migration through the later database-validation step before activating the flag. No deployment flags or secrets were changed in this pass.
- Jev article workloads must be explicitly active. An empty lifecycle map `{}` disables them and produces a hold; Hermes does not substitute for semantic decisions.
- Whole article capture is retained. The current Jev decision admission limit is 16,000 source characters and 128,000 serialized state bytes; oversized input is explicitly held rather than silently truncated. Novelty uses declared bounded history excerpts while prose writing receives the captured text and connected entries.
- `article.timelineSummary` is the prepared reader-facing development; `article.body` is optional detail. No downstream timeline/API wiring or duplicate `connected_story` field is introduced.
- Duplicate reuse requires a durable target and a compatible novelty judgment. A related-only duplicate does not suppress a materially new primary development. Uncertain novelty without a target retains the captured development and its uncertainty; uncertain duplicate reuse is held.
- Existing managed duplicates can gain missing memberships without rewriting old prose. A legacy duplicate that needs additional memberships is retained with an explicit resolution hold; this pass does not rewrite public historical memories or manufacture a duplicate private item to satisfy a foreign key.

## Later validation

After implementation is connected, validate the article handoff and persistence contract, the Iran-conflict and Bitcoin/BlackRock placement examples, duplicate handling outside the latest five, entity ambiguity/creation, legacy history references, append-only chronology, replay/fencing recovery and disabled-Jev behavior. Configuration, additive migration application and pipeline restart remain separate execution steps; no earlier validation result proves those steps for this revision.
