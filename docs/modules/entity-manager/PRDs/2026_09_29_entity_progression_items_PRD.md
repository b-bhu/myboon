# Entity Progression Items and Shared Knowledge Consumption PRD

Status: finalized product direction v1.0; implementation and rollout gates pending
Created: 2026-09-29
Finalized: 2026-09-29
Tracking: [Entity progression items and shared knowledge consumption](https://github.com/b-bhu/myboon/issues/299)
Owner: myboon product / Entity Manager
Scope: the durable knowledge produced by research and consumed through entities
Authorization: documentation, agent review, and GitHub issue creation; implementation is not part of this task

## 1. Product outcome

Following an entity should explain what happened, what changed since the
previous relevant development, and where that knowledge came from. Internal
research, Editor, Publisher, X Desk, and future teams should retrieve that
knowledge through a shared contract without understanding each scout's tables.

The input can be an article, X post, official announcement, market observation,
or another source-native record. Source diversity must not force everything
into the same prose template or create a separate downstream pipeline.

This is a focused evolution of entity memories. It does not authorize the full
feed-v4 audit backlog or a replacement of collection, research, and publishing.

## 2. Evidence and current behavior

- Entities already have stable identity, aliases, type, summary, and status.
- Memories already have readable title/summary/body, event and observation
  dates, evidence, metrics, provenance, and stable replay identity.
- The current canonical planner selects one primary entity and at most one
  retained memory per research packet. Other mentions are not equivalent to
  typed item-to-entity links.
- Existing persisted history is not constrained retroactively by current code.
  A read-only SEC sample on September 29 found seven recent research results
  with thirty memories, including repeated coverage and several details of the
  same tokenization storyline. This is an organization-of-records observation,
  not verification of the underlying financial or regulatory claims.
- Story reconciliation can merge sources and replace a memory's summary/body;
  reconciliation metadata does not itself preserve every earlier prose version.
- Several teams already consume EntityKnowledgeReader. This shared boundary
  should evolve; consumers should not acquire source-specific database access.

References: [Feed](../../../FEED.md),
[Source Blueprint](../../../FEED_SOURCE_BLUEPRINT.md),
[Feed V3](2026_08_26_feed_v3_signal_to_knowledge_platform_PRD.md), and
[Entity Knowledge Model](2026_09_11_entity_knowledge_model_PRD.md).

Implementation anchors (repository-relative):

- `packages/collectors/src/entity-manager/types.ts`: EntityRecord and
  EntityMemoryRecord establish what already exists.
- `packages/collectors/src/entity-manager/canonical-planner.ts` and
  `canonical-processor.ts`: current admission, one-memory planning, grounding,
  source provenance, and commit adapter.
- `packages/collectors/src/entity-manager/resolver.ts`:
  storyReconciliationPatch currently updates prose and retains bounded source
  and reconciliation metadata.
- `packages/collectors/src/entity-manager/entity-knowledge-reader.ts`:
  EntityKnowledgeReader and current mutable-row change cursor.
- `packages/api/src/entity-knowledge.ts`: publicMemory strips raw context,
  evidence, and provenance; a new source DTO requires deliberate allowlisting.
- `packages/collectors/src/editor-draft/supabase-store.ts`,
  `packages/collectors/src/publisher/supabase-store.ts`, and
  `packages/collectors/src/x-desk/source.ts`: current consumer seams.

This PRD extends the prior scoped Entity Knowledge work without changing its
restrictions on automatic ontology/relationship writes. Item participation
links here are a distinct contract from permanent entity-to-entity predicates.

## 3. Working product decisions

1. Entity remains the durable subject and consumer entry point.
2. A progression item is a coherent knowledge contribution, not an article
   section or a compulsory claim fragment. It may describe a development,
   attributed viewpoint, measurement, or unresolved claim.
3. One item may relate to multiple existing entities through evidence-backed
   roles. Source, publisher, venue, or incidental mention alone does not grant
   timeline membership.
4. Several sources may support one item; several meaningful developments may
   originate in one source. Neither one-item-per-source nor one-item-per-claim
   is the general product rule.
5. Meaningful later developments become linked items. Corrections preserve the
   earlier record and make its corrected/retracted status visible.
6. Continuity is scoped to a relevant story, not merely the previous row in an
   entity's timeline. SEC can participate in unrelated stories simultaneously.
7. Story continuity starts with typed links between items. A durable thread
   grouping is optional and must not become a requirement for retaining useful
   knowledge. These internal threads are distinct from published Stories.
8. Agentic interpretation proposes writes; deterministic validation and one
   persistence boundary enforce identity, evidence, replay, and authorization.
9. Editorial selection remains downstream. A non-publishable contribution can
   still be valuable knowledge.

## 4. Scope and exclusions

In scope: progression semantics, source attribution, item-to-entity roles,
continuity/corrections, bounded agent planning, durable commit behavior,
versioned read contracts, consumer handoff, migration and acceptance criteria.

Out of scope: new X/exchange collectors, broad ontology expansion, automatic
entity merges, historical data cleanup, public feed redesign, autonomous
publication, deep-research activation, and full model-gateway consolidation.
Existing identity/admission guardrails remain applicable.

## 5. Proposed logical records

Physical layout is an implementation decision after the compatibility rehearsal.
Prefer extending existing entity-memory storage and reader boundaries.

### Entity

Keep existing identity. An entity summary describes the subject; an optional
current-state synopsis is a derived view with its own evidence and as-of date.
Do not replace stable identity with the latest story's wording.

### Observation and source attribution

An observation preserves what was collected in its native form or a bounded
retained extract. Each source reference distinguishes original publisher,
author/account, original URL or native identifier, discovery provider,
collector, publication time, collection time, and retained artifact reference.
Unknown values remain unknown. A report found through X does not become an
official announcement merely because it mentions an authority.

An artifact reference includes capture time, content hash, and availability
(`snapshot`, `excerpt`, `reference_only`, or `unavailable`). Do not promise a
full saved original when only a URL or excerpt exists. Preserve numerical
units, venue, instrument, and observation interval for measurements.

### Progression item

Common metadata: stable item ID, title, readable note, broad contribution kind,
event time (nullable), first-known time, commit time, evidence references,
entity links, item links, lifecycle/correction status, and provenance of the
accepted plan. Structured source-specific measurements remain optional.

Time vocabulary must remain precise: publication time belongs to the source;
observation time is collection; acceptance/commit time is when a knowledge item
became available to consumers. An observation collected yesterday but accepted
today must not appear in yesterday's as-known knowledge view. Late-arriving
items may have older event times without rewriting their acceptance time.

An entity link contains a resolved entity ID, role, evidence references, and
brief relevance. Roles describe participation in this item, not permanent
relationships between entities. One primary entity may remain for legacy
compatibility; it does not restrict v2 retrieval to that entity.

Initial timeline-participation roles are `subject`, `actor`, `regulator`,
`respondent`, and `affected_party`. Every accepted link requires supporting
claim/evidence references and a relevance rationale. Publisher, quoted speaker,
discovery account, and execution venue are source/context roles by default;
they acquire timeline membership only through separately grounded involvement.
Role vocabulary is versioned and extensible after review, not model-invented.

An item link identifies an earlier item and a relation such as `continues`,
`responds_to`, `corrects`, or `contradicts`. Contradiction does not automatically
invalidate the earlier source. Mere chronological adjacency creates no link.

In the first slice, `continues` has at most one predecessor; responses may
branch. All links point to accepted earlier items or earlier local items in
the same validated plan, with cycle detection before commit. Corrections and
contradictions do not automatically merge story membership. Traversal has
explicit depth and item limits and reports truncation. Multiple-predecessor
story merges and durable thread objects remain deferred.

Separate contribution kind from evidence and lifecycle state. A viewpoint is
attributed even when accurately quoted; a claim may remain unverified or
disputed; an item may later be corrected or retracted. One source becoming
corroborated does not upgrade every assertion in its note. Preserve mixed
uncertainty in the prose and referenced support without requiring a new
claim-graph write for every sentence.

Measurement support includes value, unit, instrument, venue, observation
interval, and comparison baseline where a change is asserted. Reposts and
syndicated articles retain their native identities and discovery chains;
repetition is not independent corroboration. Evidence relations distinguish
support, attribution/quotation, contradiction, and contextual material.

### Knowledge change

Each committed item, source attachment, entity-link change, correction, or
retraction creates a durable change record. Consumers can resume from a cursor
and distinguish a new development from extra corroboration or metadata repair.
The change stream cannot be a scan of mutable latest rows that silently loses
intermediate changes.

## 6. Agentic processing

The working flow is:

```text
research packet + preserved source observations
  -> bounded existing-entity and relevant-item lookup
  -> source-aware knowledge proposal
  -> validate identity, attribution, evidence, and continuity
  -> checkpoint accepted plan
  -> atomic knowledge commit and change record
  -> independent consumer teams
```

The planner may propose: create item, attach evidence, append development,
record correction/contradiction, retain observation without a note, or hold for
additional context. It returns typed decisions plus grounded prose where useful.

Deterministic checks handle exact source repeats and replay first. Bounded
classifiers such as Jev may serve eligible decision steps after evaluation;
generative models write explanations where required. The design must not
require a model call per field, per entity, or per processing step.

Relevant context is bounded by entity identity, source references, likely story
continuity, and time. Do not send the complete entity history every time. A
truncated or failed lookup is explicit and cannot justify `already_known`.
Uncertain continuity can leave an item ungrouped. Unresolved entity identity
keeps the proposal pending rather than silently filing it under a broad parent.

Persist validated planning output before downstream writes. Reuse requires
matching input, policy, prompt/decision versions, and compatible target state.
Concurrent changes trigger targeted revalidation; they do not grant permission
to overwrite another accepted plan. Retries must not unnecessarily repeat paid
inference or create duplicate knowledge.

### Bounded proposal and execution contract

An additive `ProgressionPlanV1` replaces the current single-primary,
single-memory planner envelope only for sources enabled for this slice. It
contains input/work identity, decision version, context watermark/digest,
target revisions, and one of `apply`, `retain_observation`, or `hold`.

An apply plan contains bounded item drafts and operations to attach evidence
or relationships to accepted target items. Each draft has a stable local key,
contribution kind, title/note, assertion attribution, claim/evidence/source
references, entity participation links, and any continuity targets. Corrections
create a new item and a correction relation; they never replace accepted text.
Stable stored identities are assigned by the commit boundary, not invented by
the model. All referenced identities must be supplied candidates or validated
local draft keys. Unresolved identities remain explicit and prevent apply.

Proposed initial caps, versioned as policy and subject to fixture evaluation:
four new items per packet, eight entity links per item, four outgoing continuity
links per item, thirty-two evidence references per item, and six thousand
characters per note. These are limits on a coherent plan, not targets to fill.
One normal structured planner call may return the entire plan; one bounded
repair is available under the existing inference budget. No open-ended agent
loop or parallel planner call per candidate entity is required.

Overflow produces a durable hold with the unprocessed claim groups or a
continuation reference and zero partial knowledge commits. A separately
admitted bounded continuation can later process those groups. The parent work
is not marked successfully complete while material overflow is unresolved.
Retrying either work unit must not duplicate already accepted contributions.

A hold records its reason, missing dependency, and reconsideration trigger:
new evidence/context, identity resolution, an admitted continuation, or a
bounded scheduled retry for a transient failure. Unchanged unresolved work
must not repeatedly consume inference. Exhausted retries remain visible for
review rather than becoming either successful work or an endless paid loop.

The checkpoint stores normalized plan, plan hash, input/context digests,
policy/prompt/decision versions, and target revisions. Immutable accepted plan
content is separate from append-only execution outcomes. Commit first checks
for an existing receipt for the logical operation; finding it returns the
previous result regardless of subsequent model configuration changes. Otherwise
it validates the lease and target revisions and commits the entire item/link/
evidence/change batch transactionally. A stale target produces targeted
revalidation or a hold, never an unconditional overwrite.

Exact-repeat and replay checks precede inference. Jev's current novelty
definition is a narrow, optional capability; it is not proof that shared
progression classification is already wired or calibrated. This slice starts
with that capability off and may evaluate it in shadow. Future provider-neutral
role/grouping capabilities can be admitted through versioned decisions,
budgets, validation, and calibration without changing storage or reader code.
They are not required or activated by this PRD. Measure whether a classifier
avoids later work before adding it to the normal path.

### Using the model as a productive worker

Product direction from the ongoing discussion: optimize the useful work
completed with a model, not just the price of an individual call. Like a human
researcher, a model needs a clear task, relevant records, appropriate tools,
and a saved handoff. It should not repeatedly reconstruct its assignment or
redo work that another team has already accepted.

In the current implementation, Hermes is an execution/service route to the
generative model, not itself the model or the durable memory. Entity knowledge
provides shared memory; the work packet states the assignment; deterministic
code retrieves records and executes validated operations. Jev supplies a
bounded decision capability where evaluated performance makes it useful.

The following allocation is a proposed operating policy, not an assertion
that the progression workflow is already connected to these capabilities:

| Work to complete | Preferred handling | Why |
|---|---|---|
| Recognize an exact replay, resolve a saved commit, retrieve bounded context, validate IDs, persist links | Deterministic code | These operations do not require interpreting a new situation. |
| Judge whether a fully represented candidate adds knowledge to supplied prior items | Evaluate Jev novelty for eligible cases | A small decision can avoid unnecessary full planning when its result is sufficient to finish the work. |
| Interpret a new development, distinguish several developments, explain a contradiction, or write a grounded note | Generative model through the existing runtime | These require synthesis and may produce several related decisions in one plan. |
| Resume after a transport or persistence failure | Reuse the accepted plan/receipt and revalidate changed targets | A failed handoff should not automatically require the worker to think again. |
| Supply another team with accepted knowledge | Shared reader plus that team's bounded task | Teams can reuse facts and citations while retaining their own product judgment. |

Jev is not a mandatory extra step before every generative call. Route directly
to the planner when synthesis is clearly required or the classifier cannot
avoid meaningful work. Its current novelty capability distinguishes known,
new, and conflicting information; this does not establish factual truth,
editorial importance, entity identity, or final story placement.

For an eligible known-information result to bypass note generation, all
material contributions in the bounded candidate must be accounted for, the
prior target must be grounded, and the remaining action must be deterministic
such as attaching a validated source. A broad verdict over a mixed article is
insufficient to discard its other developments. Incomplete context, uncertain
coverage, or disagreement goes to bounded reasoning or an explicit hold.
Do not silently equate "already known" with "discard the new source."

For the fictional SEC–Acme example:

1. Collecting the identical saved source again resolves through its receipt;
   no model is needed for that replay.
2. A different article repeating only the known complaint may use eligible
   novelty classification and attach evidence without rewriting the note.
3. An article adding Acme's response requires a new attributed development;
   the planner receives the relevant complaint and source material together.
4. An article containing both repetition and a new response must retain the
   response. A cheap whole-article duplicate verdict must not suppress it.
5. Research, Editor, and X Desk read the accepted shared record rather than
   independently reconstructing the underlying complaint. Their own output
   selection and writing remain separate responsibilities.

Compare direct planning with selective Jev routing on the same reviewed input
set. Include classification, context retrieval, generative calls, fallbacks,
repairs, and retries in total cost. Shadow comparisons are an evaluation expense,
not a claim of production savings. A cheaper individual call is insufficient
if most requests still require the same downstream reasoning.

Measure cost per correctly resolved input alongside cost per useful accepted
item, meaningful-update recall, attribution/attachment errors, median and
tail completion time, and repeated inference on retry. Counting only accepted
items would hide cheaply discarded but valuable developments. Numerical savings
targets remain unclaimed until measured; critical missed corrections and
unsupported entity links remain quality failures regardless of cost.

Start by avoiding repeated work and supplying better bounded context. Enable
selective classification only where it reduces total work at the agreed
quality level. Future model substitutions change the capability policy and
evaluation results, not the entity/item or downstream consumer contracts.

### Concrete Jev example for discussion

Jev accepts supplied state and typed questions. Choice selects a declared
option, Score evaluates a declared rubric, and Noul returns a yes/no
probability. Independent questions sharing the same state can be evaluated
in one request; they cannot use each other's answers as hidden context.
Our application retrieves the records and combines the answers. See
[TypeSafe primitives](https://docs.typesafe.ai/primitives).

Fictional supplied state: a saved item says SEC filed a complaint against
Acme; a second supplied item concerns unrelated SEC rulemaking. The incoming
source contains Acme's first response denying the complaint's allegations.
The bounded source extract and existing item references accompany this state.

| Question | Answer shape | Illustrative result, not an executed model response |
|---|---|---|
| Does this source add information beyond the supplied prior items? | Choice: already known / new information / conflicts with prior record | New information: the response was not previously recorded. |
| Which supplied matter does the source concern? | Choice: Acme complaint / unrelated rulemaking / neither / unclear | Acme complaint. |
| Does the source explicitly attribute a response to Acme? | Noul: probability of yes | High probability of explicit attribution. |

These questions can share a request because each can be answered from the
original supplied state. The latter two are proposed capabilities, not existing
registered progression decisions. Code checks evidence/candidate identities
and consistency; acceptable results route a grounded packet to the generative
planner to write an attributed response item. The complaint remains in history.
A denial does not refute the stored fact that a complaint was filed and does
not itself prove that the allegations were false.

If the source only repeats the known complaint, an eligible known-information
result can instead lead to validated evidence attachment without new prose.
Ambiguous answers or inadequate context require reasoning or a hold. Jev does
not fetch our database, create evidence, or write the progression note.

Choice and Score include probabilities and a confidence statistic derived
from their distribution; confidence is not a second independent verification
of correctness. Action thresholds require evaluation against our inputs. See
[TypeSafe confidence](https://docs.typesafe.ai/confidence). This example is a
design illustration; no provider call or application change was made for it.

## 7. SEC example and dynamic-source cases

The SEC entity already exists. An incoming source adds evidence to its relevant
history; it does not require another SEC entity.

| Input | Proposed treatment |
|---|---|
| Reporting describing a policy, scope, and conditions | One coherent development when those details belong together. |
| Another outlet repeating the same development | Attach evidence; no automatic new progression item. |
| A meaningful later clarification | New linked item explaining the change. |
| A public figure's reaction | Attributed viewpoint, linked only to entities/storylines for which it adds meaningful context. |
| An unrelated SEC proceeding | Separate continuity within the SEC timeline. |
| Exchange time-series measurements | Retain structured observations; summarize a meaningful change or window, not each tick. |
| One source covering independent developments | Separate grounded items, with explicit bounded fan-out and an overflow/continuation path. |
| Rumour, deletion, or conflicting reports | Preserve attribution and uncertainty; append evidence/correction without retroactively manufacturing certainty. |

The fictional SEC–Acme proceeding can link one factual development to SEC as
regulator and Acme as subject. Entity timelines are views of shared items.
Entity-specific emphasis may be a derived view; it must not become independent
copies of the factual record that drift apart.

## 8. Shared consumption contract

Introduce a versioned extension alongside EntityKnowledgeReader v1, with
bounded reads for an entity timeline, item hydration, relevant research
context, optional story continuity, historical as-of context, and changes.
Page limits, stable ordering, query-bound cursors, and unresolved/missing
reference behavior must be explicit. Consumer DTOs expose source attribution
and evidence excerpts through an allowlist, never raw internal context blobs.

Historical queries distinguish when something happened from what the system
knew by a date. Late evidence and later corrections cannot leak into earlier
as-known views. Keep original item and evidence identities available to cite.

| Consumer | Reads | Owns |
|---|---|---|
| Research agents | Relevant entity/story context and evidence | Further investigation and proposed knowledge additions. |
| Editor | New substantive developments and prior context | Publish-worthiness and editorial angle. |
| Publisher | Exact referenced items and relevant corrections | Approved publication output; no independent knowledge rewrite. |
| X Desk | Selected changes, attribution, and context | Social treatment under its existing operating authority. |
| Future teams | Same versioned, bounded knowledge interface | Their own product decisions and processing checkpoint. |

Each consumer owns its cursor and idempotency. Knowledge production does not
wait for every team to finish. Changes include enough identity to deduplicate
an item encountered through multiple entity timelines. A correction is visible
to affected consumers but does not by itself authorize external posting.

For current consumers, compatibility includes behavior as well as DTO shape:
Editor must not independently review the same new item once per linked entity;
Publisher must revalidate cited item status before publishing; X Desk must
deduplicate incoming events by change identity rather than `(memory_id,
updated_at)`. Source-only attachments remain observable without automatically
requesting another editorial or social model call. Teams choose which change
kinds require action under their own operating policy.

### Proposed minimum reader surface

The names below specify capability boundaries, not a new network service or
permission to bypass the existing API authentication boundary:

```typescript
interface EntityKnowledgeReaderV2 {
  getEntityTimeline(input: EntityTimelineQuery): Promise<KnowledgeItemPage>
  getItemsByIds(input: ItemHydrationQuery): Promise<KnowledgeItemResult[]>
  getResearchContext(input: ResearchContextQuery): Promise<ResearchContextBundle>
  getItemContinuity(input: ItemContinuityQuery): Promise<KnowledgeItemPage>
  getChanges(input: KnowledgeChangesQuery): Promise<KnowledgeChangePage>
}
```

Common query semantics:

- Current-view entity resolution honors existing redirects. Item hydration is keyed by
  stable item identity, independent of which entity exposed it.
- Timeline queries declare their time basis: `event_time` for what happened
  around a date or `known_time` for what we had retained by a date. A fixed
  `known_before` watermark applies to all fields, links, and evidence in an
  as-known query. Unknown event times are not invented from collection times.
- Context bundles return relevant items, source attribution, uncertainty,
  cutoff, completeness/truncation flags, and citation identities. A partial
  bundle does not justify a confident negative answer.
- Pages bind cursors to filters and a fixed snapshot watermark, so new writes
  cannot reorder an already-started historical traversal.
- Change delivery is at least once. Consumers checkpoint only after durable
  local handling and deduplicate by change identity, not only by item ID:
  later evidence or correction changes to the same item must remain visible.
- A change watermark reflects durable publication order. A concurrently
  allocated lower sequence that commits late cannot be skipped because a
  higher sequence was already delivered; allocating an integer alone does not
  establish safe commit order.
- Link removal reports both prior and current affected entity identities;
  filtered subscribers must learn that a formerly visible item changed.
- Missing, withheld, or unavailable evidence is represented explicitly rather
  than being silently dropped or returned as an empty successful lookup.
- Historical entity identity and membership must honor the snapshot boundary.
  Current redirect resolution alone does not prove the same identity mapping
  existed at an older date. Until redirect history is available, as-known
  queries return stored accepted entity identities and disclose that historical
  redirect reconstruction is unavailable; they never apply a later merge as
  though it had always been known.

Consumer adoption can begin with a bounded internal reader. A hosted context
API or MCP surface may later expose the same capabilities; neither is required
for the first implementation.

## 9. Minimal implementation direction and migration

Working preference: keep `entities`; reuse `entity_memories` as the item body
where feasible; add normalized item/entity and item/source links, append-only
continuity/correction records, and a durable changes/outbox boundary. Avoid a
second independently writable knowledge system.

The first implementation should test the row-plus-links option. One existing
memory row remains the authoritative body, marked with an explicit managed
contract version. Reuse its existing UUID as the public `itemId`; a second UUID
is unnecessary. Add an entity-independent progression replay key or extend the
versioned replay-key contract for new managed rows. Existing `entity_id` is
frozen as a v1 compatibility anchor; all v2 participation, including the original
primary, is represented in the approved link relation. Adding or correcting a
secondary link cannot change the item identity or duplicate its body.

Current `deriveMemoryIdentityKey` includes the primary entity and, for news,
does not distinguish several developments from the same article for that
entity. Preserve its v1 semantics for legacy callers. New progression identity
must support multiple local draft keys from one immutable accepted plan,
independently of entity membership. A prompt/model change is not itself a new
logical contribution. Cross-source semantic deduplication selects an existing
item through validated planning; it is not inferred from equal wording hashes.

Existing schema constraints and store validators assume the old identity
format. An implementation must explicitly migrate those constraints or add a
separate compatible identity field; merely supplying a differently formatted
key to the current store is insufficient. A separate canonical item table is
an alternative only if the compatibility rehearsal proves reuse less safe or
more complex. If selected, its old-reader representation is a read-only
projection with a stable mapping, never a second writer.

Preserve a primary entity projection for existing v1 readers and stable memory
IDs for historical references. New readers see all approved entity links. Do
not fabricate historical links, source snapshots, dates, or thread assignments.
Legacy rows can remain ungrouped and explicitly identify unavailable history.
Historical fidelity starts at the managed cutover for records lacking older
versions; the reader reports that boundary instead of claiming reconstructed
as-known history. Existing public Story routes and publication records retain
their meaning and identities throughout the internal reader migration.

The cutover must define a single authoritative writer for each item and prevent
legacy in-place updates on items managed by the new append-only contract.
Rollback can disable new planning and preserve new data; it must not silently
resume incompatible writes. Source evidence and queue admission require a
durable handoff; successful plans/commits must be discoverable on retry.

Enforce managed-row ownership at the persistence boundary, including legacy
upsert, story reconciliation, and market-consolidation paths. Checking only the
new planner's behavior is insufficient. Every accepted managed item has a
grounded primary compatibility link at creation. If that link is later found
wrong, an appended link-correction event changes v2 membership; the frozen
legacy anchor is not silently reassigned or treated as continuing proof of
membership. The v1 current-view projection suppresses an invalid anchor or
retracted item. Exact-ID publishing reads fail explicitly for withdrawn or
superseded references until the consumer handles the replacement, rather than
quietly dropping references and proceeding with partial evidence.

Old reader shapes can remain stable, but managed-item production cannot be
enabled for a publishing path until its status/retraction checks are compatible.
Rollback from this reader behavior requires keeping managed rows isolated from
older writers/consumers that cannot honor it. The legacy projection is a
compatibility view, not a promise of full v2 multi-entity or historical semantics.

Suggested slices:

1. Fixtures, contracts, and read-only prototype with current SEC-shaped data;
   reuse row IDs and test the v1 compatibility projection before choosing SQL.
2. Managed-row ownership, provenance, links, immutable plans, atomic commits,
   durable changes, and bounded v2 timeline/hydration/change reads behind a flag.
3. Shadow agent planning; compare grouping, attribution, fan-out, and consumer
   outputs without committing live knowledge. No Jev activation is implied.
4. Adopt one read-only internal research consumer, verify independent replay,
   then update Editor/Publisher/X Desk correction and deduplication handling
   before enabling managed production for their input sources.
5. Add richer context/continuity query helpers over the same records as needed;
   optional durable threads and historical backfill require separate evidence.

Safe minimal operation still records correction and membership history from
the first managed write. Deferring richer query helpers must not discard the
events required to implement truthful historical reads later.

## 10. Acceptance and evaluation

- A development appears once in each legitimately linked entity timeline and
  once in cross-entity consumer results after item-ID deduplication.
- A second publisher reporting the same fact attaches evidence without
  automatically creating a new development.
- A later material change and a correction remain traceable to prior items;
  as-known queries exclude sources and changes learned after their cutoff.
- Source publisher, discovery channel, scout, and artifact availability remain
  distinguishable across news, X, and exchange fixtures.
- A publisher-only/venue-only mention does not become an entity timeline link.
- A long source may yield several independent developments without silently
  dropping overflow or fragmenting every sentence into an item.
- Replayed inputs, lost leases, and failures after plan persistence or database
  commit do not duplicate items or lose downstream change notifications.
- Two consumer teams independently replay changes and recover from interruption
  without blocking knowledge production or each other.
- Legacy reader contracts remain compatible during the staged rollout.
- Legacy update/upsert attempts cannot mutate managed item prose, and an
  invalidated primary link does not leave a stale item visible through the v1
  current-view projection.
- Consumers receive evidence-backed, allowlisted context with uncertainty and
  truncation visible; source text is treated as data rather than instructions.

Compare reviewed fixtures for coherent development grouping, missed meaningful
updates, incorrect entity/story attachment, attribution preservation, source
coverage, historical fidelity, and consumer usefulness. Measure provider calls,
input/output usage, fallback rate, database operations, processing delay, and
cost per accepted useful item when cost data exists. Do not assert savings from
a smaller model name alone. Quality thresholds and rollout sample sizes must
be agreed before activation, using the new failure cases above as hard gates.

### Review fixture matrix

| Fixture | Required result |
|---|---|
| Fictional SEC–Acme complaint, repeated coverage, response, and clarification | One shared initial item, evidence attachment for a repeat, later linked developments, same item ID across legitimate entity timelines. |
| X allegation, official denial, later source retraction | Speaker attribution retained; denial is evidence, not automatic proof of falsehood; explicit retraction is visible after acceptance and absent from earlier as-known views. |
| Exchange measurements over a defined window | Values/units/venue/instrument/window/baseline retained; selected meaningful change yields one coherent item; numerical ticks do not automatically create notes. |
| Four independent developments with a configured cap of three | Durable overflow/continuation, no partial knowledge commit or silent loss, replay without duplicates. |
| Two consumers interrupted at different change positions | Each resumes independently; repeated delivery is harmless; evidence-only changes do not force publication. |
| Concurrent writes whose sequence allocation and commit order differ | Published watermark never skips a late committed change. |
| Evidence learned late, later correction, and later entity redirect | Earlier snapshot contains only accepted information and identity membership available at that cutoff, with explicit legacy limitations. |
| Old writer attempts to update managed prose | Persistence rejects the mutation; existing accepted item and change history remain intact. |

## 11. Remaining product decisions

These do not block the finalized product direction; they must be settled in the implementation slice
that depends on them:

1. Materiality and relevance examples per source: which reactions, measurement
   windows, and small developments deserve timeline membership for our users?
2. Reviewed grouping/attribution quality thresholds and sample sizes for moving
   from shadow to production; no threshold is claimed as calibrated today.
3. Final storage DDL and rollout mechanics after the compatibility rehearsal,
   including how long legacy consumers and historical artifacts are retained.
4. Which input classes benefit from selective novelty classification versus
   direct planning, with measured end-to-end cost/latency and quality budgets.

The product direction is finalized for issue handoff. Jev starts with
new-versus-repeated information; story matching remains a later evaluated
improvement. Numerical accuracy, cost, and speed targets must be agreed before
rollout. Finalization is not implementation authorization or a claim that those
evaluation thresholds have already been calibrated.

Default first-slice direction is typed links, reused memory body/UUID, an
entity-independent replay key, one writer, and bounded internal readers. A
mandatory thread table and wholesale historical rewrite are not prerequisites.

## 12. Agent review synthesis

Three read-only agents reviewed the draft. The main author mediated the
cross-review discussion, checked consequential findings against code, and
integrated the resulting decisions. The agents did not modify files, activate
providers, or change production data.

| Review | Main challenge | Integrated decision |
|---|---|---|
| Product and temporal semantics | A flat timeline cannot explain independent stories, attribution, or knowledge at an earlier date. | Typed continuity first, explicit participation roles, separate event/acceptance time, immutable accepted prose and historical limitations. |
| Agent workflow and extensibility | The current one-memory plan and entity-derived replay key cannot represent the proposed shared bounded output safely. | Additive bounded plan, explicit overflow, checkpoint/revalidation, entity-independent progression replay, optional evaluated classifier capabilities. |
| Persistence and consumer adoption | Mutable-row polling and unaware consumers can lose corrections or act repeatedly on the same shared item. | Atomic durable changes, safe publication watermark, independent cursors, v1 projection and consumer-specific correction/deduplication gates. |

The material storage disagreement was resolved during review. The Agent
Workflow reviewer initially preferred a new canonical item table. After
considering a single existing row with immutable ownership and normalized
links, that reviewer agreed entity-based replay-key coupling alone does not
require a new table. The Consumer reviewer independently preferred reuse for
the first slice. The parent further clarified that the existing row UUID can
be the shared item identity; the missing piece is an entity-independent replay
contract and multi-entity relationships, not another public identifier.

The agreed minimal direction defers durable thread objects, broad ontology
writes, historical backfill, new collectors, and broad consumer rewrites.
Necessary consumer correctness changes remain in scope. This document defines
proposed behavior and test fixtures; earlier audit tests do not certify that
these new contracts are implemented or production-ready.
