# Entity Pipeline Improvement Discussion — Resume Here

Date: September 29, 2026  
Status: discussion checkpoint; not a new PRD or implementation plan  
Purpose: preserve the seventeen-item exploration and resume the decisions later.

## Where we are going

We are exploring how to improve the Scout → Research → Entity Manager pipeline
for a future Feed upgrade: easier extension, less repeated model work, reliable
completion, and knowledge that different teams can reuse.

The next step is to finish gathering evidence and discussing the remaining
items. Once enough decisions are settled, design the ecosystem and migration
as a coherent whole, then organize coordinated GitHub issues. **No new issues,
migration implementation, or formal PRD are requested at this checkpoint.**

This note distinguishes discussion progress from delivered software. None of
the seventeen improvements was implemented during this review. The separate
audit did create verified backups and archive unused Mac experiment copies;
those actions did not fix the processing workflow.

## Existing work to keep intact

- [Entity Progression Items and Shared Knowledge Consumption PRD](/Users/bibhu/Desktop/projects/myboon/docs/modules/entity-manager/PRDs/2026_09_29_entity_progression_items_PRD.md)
  records the finalized product direction for shared progression items,
  provenance, historical continuity, reusable plans, and independent consumers.
- [GitHub issue #299 — Entity progression items and shared knowledge consumption](https://github.com/b-bhu/myboon/issues/299)
  contains that PRD and remains open. It explicitly excludes the separate
  unfinished-job/dead-letter investigation. No issue edits were made here.
- [Feed pipeline: how it works, why work fails, and what to clean](/Users/bibhu/Desktop/projects/myboon/docs/modules/entity-manager/operations/2026_09_29_pipeline_health_and_cleanup.md)
  is the user's intended second companion document. It is an **operations
  audit**, not a second formal PRD. It preserves the verified failure findings,
  system explanation, backups, and cleanup record.

Those documents remain the references for their respective scopes. This note
adds a place to resume the wider conversation; it does not rewrite them or
make one issue depend on another.

## A simple way to remember the system

**Scouts find → triage chooses → research explains → Entity Manager files →
Editor selects → Publisher delivers.**

Think of each stage as a team checking a shared task board. Timers remind the
teams to check; saved work records tell each team what is ready and what needs
to resume. A successful Entity-stage outcome is not necessarily a published
story: deliberate no-action decisions and publication are separate concepts.

For the current server setup:

- **SQLite is the internal working desk:** source observations, work tickets,
  ownership, evidence, research, retries, and next actions. News and Polymarket
  already have separate local database files under shared worker contracts.
- **Supabase is the durable knowledge store:** accepted entities and memories,
  plus the product's published output. It does not need to host internal job
  polling for this proposal.

Existing workers already use database queues, timed loops, leases, recovery,
artifact reuse, and memory identities. The proposal improves particular gaps
between those pieces. It is not a move from a queue-free system to a new one.

## Seventeen-item discussion tracker

**Current tally: 7 have a direction recorded, 5 are partially discussed, and
5 still need dedicated discussion. That is 12 touched out of 17.**

“Direction recorded” means we have a product or architectural approach, not a
finished technical design, implemented feature, or proven production result.
Items 1 and 2 moved into this group after the handoff conversation; before
that, only 7, 9, 13, and 17 had direction in the progression PRD. Item 10 now
also has user-approved direction: reuse appropriate saved evidence and research
across the existing news and Polymarket pipelines.

| # | Original improvement | Discussion status | What remains to settle |
|---|---|---|---|
| 1 | Ensure Scout discoveries reliably reach shared intake | **Direction recorded:** save the observation and durable delivery obligation together. | Exact ownership, deduplication/replay behavior, and recovery when delivery fails. |
| 2 | Save intake decisions and queued work together | **Direction recorded:** commit the decision and required next action atomically within the local store. | Research, defer, no-work, and failure outcomes; compatible state and transaction boundaries. |
| 3 | Wake deferred signals when they become eligible | **Partial:** Jev should handle relevant semantic judgments; code owns mechanical eligibility, capacity, and retry limits. | Reconsideration triggers and business expiry/catch-up policy; neither always-process nor blanket discard-old was agreed. |
| 4 | Check existing knowledge before research spend | **Partial:** check relevant entity knowledge before additional research; Jev may assess new-versus-known contributions, while code safely reuses appropriate saved material. | Gate placement, sufficient context, and research-value criteria; the proposed additional-research decision is distinct from Jev's existing novelty capability. |
| 5 | Finish Jev integration into the shared pipeline | **Partial:** suitable bounded semantic judgments belong to Jev; the full decision map follows the remaining requirements discussion. | Shared-pipeline wiring, precise decision definitions, fallback, evaluation, and activation; no end-to-end integration is claimed. |
| 6 | Share inference configuration and operating controls | **To discuss.** | Common provider routing, capacity, circuit handling, budgets, and reporting without duplicating infrastructure. |
| 7 | Separate narrow decisions from prose generation | **PRD direction:** reinforced in discussion—Jev for suitable semantic judgments, code for mechanical limits, the generative model through Hermes for investigation/interpretation/writing. | Full decision mapping and budgets; the user approved one automatic bounded follow-up when Jev judges it worthwhile, not implementation. |
| 8 | Define decision rules once across models | **To discuss.** | Common definitions for Jev questions and generative fallback so labels and policy do not drift. |
| 9 | Reuse Entity Manager plans and commit receipts | **PRD direction:** save validated plans and resolve accepted work on retry. | Concrete replay/receipt boundaries and compatibility with the handoff design; provider changes must not duplicate accepted knowledge. |
| 10 | Reuse evidence across different jobs | **Direction recorded:** news and Polymarket share appropriate saved evidence and research by default, retaining their own source context and investigating new information. | Exact identity, freshness, invalidation, storage, and retention mechanics; the same event need not mean the same research question or independent corroboration. |
| 11 | Retire legacy queue bookkeeping after verified cutover | **Partial:** the audit demonstrated confusing parallel counts. | Ownership cutover, compatibility readers, reconciliation, and when old bookkeeping can safely retire. |
| 12 | Make sources easy to plug in | **Partial:** articles, X posts, and exchange data were discussed. | Source registration, source-specific policies, and how new inputs avoid changes throughout central workers. |
| 13 | Separate content meaning from collection provenance | **PRD direction:** preserve content kind, original source, discovery channel, and collector distinctly. | Adapter/schema details for the different inputs; no automatic entity membership from a source or venue mention. |
| 14 | Use controlled Entity-job concurrency | **To discuss.** | Capacity, correctness, and cost limits when several independent jobs progress together. |
| 15 | Consolidate repeated entity-memory lookups | **To discuss.** | Which reads overlap, what must stay fresh, and how identity changes affect reuse. |
| 16 | Make incremental maintenance inspect relevant changes | **To discuss.** | How to avoid full-catalogue/pairwise work while preserving identity and maintenance safeguards. |
| 17 | Keep deferred capabilities outside the first upgrade | **PRD direction:** broad expansion, new collectors, and deep research stay outside this slice. | Define the eventual combined upgrade's first useful boundary after the remaining discussion. |

## Handoff discussion: what we agreed in principle

Keep each stage independent. Retain timed collection and worker wake-ups. The
database is the work list; correctness should not depend on two schedules
lining up or one team being available when another finishes.

**Core rule: finishing a stage includes safely recording its result and its
next required action, or an explicit reason why there is no next action.**

The proposed flow is:

```text
Scout observes an item
  → save observation and obligation to reach intake
Intake decides what to do
  → save the decision and required research job or other outcome together
Research processes eligible work
  → own the research judgment, preserve attribution/uncertainty, and save the handoff
Entity Manager organizes the research handed over
  → organize, summarize, link, and save coherent knowledge in Supabase
  → confirm the save before closing the local task
```

Within one SQLite database, save the stage result and next obligation in one
transaction. Where delivery crosses a boundary, the suggested mechanism is a
**durable outbox**: a saved obligation that remains until the destination
confirms receipt. This is a proposed implementation pattern, not an approved
schema or a requirement to create a separate queue for every stage.

Workers claim jobs with temporary ownership that can be recovered after an
interruption. Repeated delivery recognizes the same logical work and reuses
valid saved results where possible. Repeated execution can happen; the design
must prevent duplicate accepted effects rather than promise exactly-once
execution.

SQLite and Supabase cannot be treated as one transaction. If a remote save
succeeds but its reply is lost, recovery needs a stable identity/receipt or an
equivalent safe replay mechanism. The local task must not falsely declare
success, blindly write another copy, or redo accepted reasoning to guess what
happened. Exact receipt and legacy-writer mechanics remain open design work.

Complete, incomplete, failed, and deferred work still need explicit treatment,
but the earlier suggestion that all incomplete results should be held was too
narrow. **Research owns the research judgment and what it hands over.** Entity
Manager treats that output as its authoritative research input; it does not
independently reassess research sufficiency or request another investigation
merely because questions remain unanswered.

Entity Manager may organize, summarize, link, and save coherent progression
items while preserving the meaning, attribution, and uncertainty Research
supplied. Structural, identity, and write-correctness checks still apply. This
does not promote attributed assertions into independently verified facts or
turn instructions embedded in source content into workflow instructions.

The progression PRD already permits attributed viewpoints and unresolved
claims. The current blanket rejection of a packet labelled `partial` therefore
needs alignment with that product direction. The detailed Research-owned
readiness and failure outcomes remain open; they must not reintroduce Entity
Manager as a second research-quality judge. Deferring admission is distinct
from a saved research packet's completion label.

### Research and model roles: later user decisions

**Research adapts to the available content and relevant entity knowledge.** A
substantive article collected through Tokens.xyz may already support a useful
handoff despite unanswered details. A thin Polymarket observation may benefit
from targeted investigation. These are examples, not fixed rules that every
article is sufficient or every market signal needs further research.

The intended allocation of work is:

- **Jev:** suitable bounded semantic judgments, such as whether further
  research is worthwhile or whether information is new/relevant.
- **Code:** mechanical eligibility, capacity, retry, and follow-up limits.
- **The larger generative model through Hermes:** actual investigation,
  interpretation, and writing.

**Approved default for the proposed design:** when Jev judges further research
worthwhile, Research may automatically perform **one bounded follow-up**. Code
enforces that limit. This approval concerns that default only; it does not
authorize implementation or approve every other recommendation in this note.
The monetary, token, and time budgets, and what Research does when the follow-up
adds nothing useful, remain unspecified.

Jev's existing novelty capability is not an implemented research-sufficiency
or research-value capability. Its full decision map should be designed after
gathering the remaining system requirements, in alignment with the progression
PRD and issue #299. No activation or end-to-end integration is claimed here.

For stale/deferred work, an earlier voice paraphrase incorrectly inferred
“always process everything.” The user did not choose that policy. Semantic
judgments belong to the appropriate Jev decision; deterministic constraints
belong to code. The finer business policy for expiry and catching up is open.

The meaning of **“weightage”** also remains open: evidence strength and product
importance are distinct possibilities. No numerical confidence formula was
agreed.

### Cross-source reuse: approved direction

The user explicitly selected reuse across both existing sources: **news and
Polymarket should share appropriate saved evidence and research by default**.
Each pipeline keeps its source context and investigates any new information.
This moves item 10 from undiscussed to direction recorded, with detailed design
still open.

Before additional research, check relevant existing entity knowledge. Jev may
judge whether the incoming contribution is new or already known; code owns
safe reuse of suitable saved material. Two inputs about the same event may ask
different research questions, and repeating the same underlying source does
not create independent corroboration. Evidence/research identity, freshness,
invalidation, storage across the current local databases, and retention remain
design questions. This decision does not authorize implementation or a blanket
skip of research whenever an event is already known.

### Handoff questions still open

- What durable record proves Scout has handed over responsibility, including
  unchanged observations whose earlier delivery failed?
- Which decisions create research work, which deliberately create none, and
  which need a reconsideration trigger?
- How does Research express its handoff readiness while preserving useful
  attributed or unresolved information, without a blanket partial-result hold?
- What budgets bound the one follow-up, and what should Research hand over
  or record when that follow-up produces no useful additional information?
- What business expiry/catch-up policy applies to deferred and stale work?
- Does “weightage” mean evidence strength, importance, or distinct fields?
- How do current queue states represent waiting, held, expired, and uncertain
  remote outcomes honestly, including older records and consumers?
- What replay proof can the existing Entity writer supply, and how will that
  align with the progression PRD's accepted-plan and receipt design?
- What must be compatible before each migration slice runs, and how do we
  resume or roll back without losing obligations or accepted knowledge?

## How this relates to the other work

The progression PRD determines what knowledge means: one sourced contribution
can appear under multiple legitimate entities, with linked developments,
preserved history, and reuse by different teams. Handoff reliability determines
whether the processing responsibility reaches the next stage and can recover.
These overlap at accepted plans, explicit holds, and write confirmation, but
remain separate topics. Their precise implementation order is not decided.

A compatibility check identified useful boundaries to carry into later design:

- Reuse the progression writer's plan/receipt authority rather than inventing
  another owner for the same accepted operation.
- A transport retry must not change the accepted note, its knowledge date, or
  whether other teams have processed its changes.
- Required job delivery differs from Jev's optional shadow comparison work.
  The existing Jev design allows shadow handoff failure without stopping live
  processing; that rule should not be confused with required delivery.
- Preserve structural, identity, provenance, and write-correctness checks;
  align the blanket partial-packet rejection with Research's ownership and the
  progression PRD's support for attributed/unresolved knowledge. This does not
  authorize model activation or new ontology work.

These are compatibility observations, not approval of a new combined design.
The older Feed V3, Entity Knowledge Model, and Jev specifications remain
supporting context; they do not replace the two companion documents above.

## Separate processing-reliability findings to remember

The operations audit, based on the September 29 inspection, established:

- 3,503 historical dead letters corresponded to partial/failed packets being
  rejected at the Entity handoff.
- All 111 pending canonical jobs were past their deadlines; legacy queue
  counts were not a reliable measure of additional actionable work.
- Publisher redirects, budget/repair inconsistencies, and insufficient entity
  failure detail were other significant findings requiring separate decisions.
- Some failed jobs already held research worth inspecting for reuse. A saved
  packet does not automatically mean complete, valid, or recoverable research.
- Workers were stopped at inspection. Why the stop was requested was not
  established. No restart or production backlog correction was performed.

Those findings are retained as evidence. They do not mean every failure is a
handoff bug or that implementing this proposal will resolve all dead letters.
The audit contains the fuller counts, limitations, and cleanup receipts.

### Concrete case: Ethena/USDe

A read-only inspection in the continued discussion traced the September 27
job for [“Ethena Looks Beyond Crypto to Support USDe”](https://coindoo.com/ethena-looks-beyond-crypto-to-support-usde/).
It used light research with no external sources allowed. The saved packet
contained 13 attributed claims, zero `verifiedFacts`, and limitations/open
questions about allocation and risk boundaries. It was labelled `partial`,
with valid output schema, one provider call, and no recorded budget overrun.
The job ended in `dead_letter` with `invalid_structured_output`.

The inspected code path explains that outcome: synthesis preserves the
model's completion label; it does not force `partial` solely because there are
zero verified facts. The shared research worker forwards the saved packet
without branching on completeness. The Entity packet adapter rejects
`partial` before processor reasoning, marks that error non-retryable, and the
Entity worker dead-letters the job. **That path does not request follow-up
research. Open questions in the packet are data, not executable tasks.**

These are saved pipeline records and code-path findings, not independent
verification of the article's underlying assertions. They illustrate why the
handoff contract needs alignment; they do not establish that every partial
packet should be accepted without structural validation.

Trace reference: work `work_46975ccb5301df07963a8fc6cb80db7a` in the VPS backup
`/home/ubuntu/myboon/packages/collectors/.data/backups/news-2026-09-29T08-36-40-889Z.sqlite`.

## Practical order for the next discussions

1. **Finish reliable responsibility transfer — 1, 2, 3.** Clarify when each
   stage is finished, how Research expresses readiness, and what follows an
   unhelpful bounded follow-up. Set deferred/stale policy without inventing an
   always-process or blanket-discard rule. This supplies the common lifecycle
   for a later migration.
2. **Decide where model work adds value — 4, 5, 7, 8, 9.** Agree when existing
   knowledge is enough and which accepted results survive retries. Preserve
   the agreed Jev/code/generative-model roles; finish the full Jev decision
   map after remaining requirements are gathered. This prevents repeated spend.
3. **Make inputs and infrastructure reusable — 6, 10, 12, 13.** Discuss shared
   inference controls, the mechanics of the approved news/Polymarket evidence
   and research reuse, and source adapters without flattening all source types
   into one content template.
4. **Address throughput and operating cost — 14, 15, 16.** Use the agreed
   lifecycle and identity boundaries to evaluate concurrency, repeated reads,
   and maintenance work.
5. **Choose the combined delivery boundary — 11, 17.** Once the above is clear,
   decide what belongs in the first upgrade, how old and new paths coexist,
   the migration order, and what can retire.

Then consolidate the ecosystem design and create a coordinated issue structure
with explicit ownership, dependencies, and rollout boundaries. That is a later
step, not something completed or authorized by saving this checkpoint.

**Resume point:** define Research-owned readiness and the outcome of the one
follow-up, then settle how deferred work wakes up in item 3. Retain the unresolved
expiry and weightage questions while gathering the remaining requirements.
Keep the existing progression PRD and operations audit available as references.

Review note: an independent read-only reviewer checked the initial note's
fidelity, its then-current 6/5/6 tracker count, companion-document references,
and obvious compatibility boundaries and found no material issues. The later
user decisions and Ethena case above were added in this bounded documentation
update without another agent review. Neither review nor update constitutes
implementation verification or formal PRD approval. The current tally is
7/5/5 after the explicit cross-source reuse decision for item 10.
