# Feed V3 Signal-to-Knowledge Platform PRD

Status: approved architecture; implementation and production evidence in progress
Created: 2026-08-26
Owner: myboon pipeline
Module: entity-manager / shared research platform
Review branch: `codex/feed-v3-signal-to-knowledge-prd`
Supersedes: source-specific research and Entity Manager orchestration described by the existing pipeline PRDs
Related:

- [`2026_07_26_entity_pipeline_rebuild_PRD.md`](./2026_07_26_entity_pipeline_rebuild_PRD.md)
- [`2026_08_13_structured_news_feed_PRD.md`](./2026_08_13_structured_news_feed_PRD.md)

## Implementation Status and Release Rule

The architecture in this PRD is locked. The implementation is intentionally
incremental and remains **safe-off in production** until the source-specific
cutover gates below are satisfied. A green unit-test suite or an online PM2
process is not, by itself, evidence that a phase is complete.

As of 2026-08-26, the review branch contains the Phase 1 contracts; source-local
SQLite queue, shadow, and execution stores; append-only live Signal emission for
News and Polymarket; bounded rules-first triage; deterministic retrieval;
structured inference gateway; zero-mutation research and Entity shadow paths;
safe-off shared Research and Entity worker entrypoints; typed status,
backfill/recovery/trace commands; a versioned internal Entity Knowledge read
API; stable entity-memory identity and migration verifier; and the disabled
deep-containment foundation. The first implementation baseline is commit
`f59bfb6`; later changes on this branch remain uncommitted until the full
verification matrix is green.

Repository implementation is not production evidence. The remaining release
gates are:

- shadow parity and capacity measurements on current News and Polymarket data;
- adoption of the Entity Knowledge reader by product Surfaces;
- Supabase migration rehearsal, verifier output, and production approval;
- provider-outage, load, rollback, deep-containment, and 24-hour soak evidence;
- source-by-source ownership cutover followed by an observation window before
  any legacy code or compatibility index is removed.

No source-specific legacy claimer may be disabled until the corresponding
shared lane has passed shadow parity, rollback rehearsal, and its explicit
ownership guard. No migration, historical deletion, or retention cleanup is
authorized by this PRD alone.

## Purpose

Turn the current Feed V3 pipeline into a reusable Signal-to-Knowledge Platform.
New signal sources must plug into one shared triage, research, and Entity Manager
spine instead of creating another source-specific vertical pipeline. New product
surfaces must consume entity knowledge instead of reaching backward into
source-specific research tables.

The durable product model remains:

```text
entities + entity memories = accumulated MyBoon knowledge
```

This PRD changes the operational system that produces that knowledge. It does
not replace the entity/entity-memory concept.

The target is a pipeline that can run unattended, keep up with supply, degrade
explicitly when providers fail, recover work without manual database repair,
and prove its health from structured metrics rather than PM2 status alone.

```text
Signal Sources
  News / Polymarket / X / Market Calendar / future sources
                         |
                         v
                  Canonical Signals
                         |
                         v
             Shared Triage and Scheduler
                /        |         \
             skip      standard     deep
                         |           |
                         v           v
              Deterministic     Bounded Agent
                Retrieval        Side Queue
                         \         /
                          v       v
                 Canonical Research Packet
                          |
                          v
                  Shared Entity Manager
                          |
                          v
              Entities + Entity Memories
                          |
                          v
          Feed / Publisher / X Team / Calendar / Alerts
```

## Why This PRD Exists

Feed V3 solved an important product problem: published narratives change over
time, so MyBoon needs durable entities and chronological entity memories rather
than treating every research result as an isolated post.

The implementation still carries the older source-first worldview:

```text
News       -> News Researcher       -> News Entity Manager
Polymarket -> Polymarket Researcher -> Polymarket Entity Manager
Calendar   -> would require another researcher and manager
X          -> would require another researcher and manager
```

That duplication makes every new source a new operational system. Retry rules,
provider configuration, queue semantics, timeouts, prompts, and process cleanup
drift between lanes. A fix applied to one source does not automatically protect
the others.

The problem is therefore not one slow model or one broken runner. The missing
piece is a shared engineering platform between source collection and durable
knowledge.

## Production Evidence Snapshot

The design is grounded in the production audit performed on 2026-08-26. These
numbers are evidence for the architecture, not permanent product thresholds.

- All PM2 processes were online and the API was healthy, but the pipeline was
  operationally unhealthy.
- News ingestion admitted roughly 54 new candidates per hour while research
  completed roughly 8 per hour.
- The news research queue reached approximately 2,000 pending candidates.
- No currently pending candidate predated the clean 2026-08-24 restart; the
  backlog was created during the soak, not inherited from an older deployment.
- Successful research arrived 6.5 to 39.8 hours after ingestion, averaging
  21.6 hours. No audited result completed within six hours.
- Entity Manager was keeping up with completed research and was not the active
  bottleneck.
- The active OpenRouter OX Alpha model reported zero monetary cost, but news
  research consumed approximately 34.9 million input and 9 million output
  tokens after the restart.
- A news candidate averaged 16.2 provider calls, 19.7 tool calls, 49,000 input
  tokens, 12,600 output tokens, and 307 seconds.
- The supposed structured path inherited the general Hermes tool environment.
  It issued thousands of terminal, code-execution, web-search, web-extract, and
  browser calls.
- A Hermes-generated Python script escaped the parent process group, entered an
  infinite loop, and consumed almost one CPU core for more than seven hours.
- Circuit-open errors were recorded as terminal research failures even though
  the intended behavior was to skip the tick and leave work pending.
- The news Hermes state database grew to roughly 304 MB with 1,099 sessions,
  33,500 messages, and 240 unfinished sessions.

The production arithmetic is conclusive: queue technology and additional
concurrency cannot compensate for unbounded work per item and automatic
admission of every signal to deep research.

## Product and Engineering Vocabulary

The following terms are canonical for this platform.

### Signal Source

A source-specific adapter that observes external data and emits canonical
signals. Examples include Tokens.xyz, Polymarket, X, a market-calendar provider,
an RSS feed, or a manual analyst submission.

A Signal Source owns only:

- source authentication and fetching;
- source-specific cursor or polling behavior;
- normalization into the canonical signal contract;
- source-local provenance;
- source-local deduplication inputs.

It does not own research policy, provider routing, entity resolution, or
publishing behavior.

### Signal

An immutable observation from a Signal Source. A signal records what was seen,
where it came from, and when. It is not automatically a promise to research or
publish anything.

### Research Work Item

A signal admitted to research with an explicit priority, depth, freshness
deadline, budget, policy version, and retry state.

Legacy `candidate` terminology may remain in storage during migration, but new
shared contracts use `ResearchWorkItem` to distinguish an observation from a
decision to spend research capacity.

### Retrieved Evidence

Bounded content collected deterministically from approved URLs. Retrieval is a
code-controlled operation and never grants a model general terminal or file
system access.

### Research Packet

A source-neutral, versioned record of source claims, verified facts, unresolved
claims, evidence, entity hints, limitations, and provenance. It is the only
input accepted by the shared Entity Manager.

### Entity Memory

Durable MyBoon knowledge associated with a canonical entity. Entity Manager is
the only component authorized to select durable entities and write entity
memories.

### Surface

A consumer of entity knowledge, such as the application feed, published
narratives, an X content team, the market calendar, alerts, or future products.
A Surface does not read source-specific queue tables.

## Locked Architectural Decisions

1. **The architecture is horizontal by stage, not vertical by source.** A new
   source adds a Signal Source adapter, not another researcher and Entity
   Manager implementation.
2. **The entity/entity-memory model remains the durable knowledge core.** This
   PRD improves the path into it.
3. **Raw observation and research admission are separate decisions.** Signals
   may be retained for audit or analytics without consuming research capacity.
4. **The default path is deterministic retrieval followed by one tool-less,
   schema-constrained model call.** A general agent loop is never the default.
5. **Deep agentic research is an explicit side queue.** It is reserved for
   material ambiguity that cannot be resolved through bounded retrieval.
6. **Budgets are executable policy.** Provider calls, tokens, tool calls,
   sources, wall time, processes, memory, and CPU are enforced outside prompts.
7. **The model does not control the workflow.** Code selects tools, URLs,
   providers, retry policy, and termination conditions.
8. **Entity Manager remains the sole authority for durable entity identity.**
   Research may return hints and deterministic shortlist references, but it
   cannot create or select the final entity home.
9. **Intermediate state remains local.** Source observations, queue state,
   retrieval artifacts, research packets, retries, and audit events stay in the
   appropriate VPS SQLite stores. This platform adds no temporary Supabase
   tables.
10. **Supabase writes remain bounded to durable product outputs.** For the scope
    of this platform, Entity Manager continues writing final `entities` and
    `entity_memories` through the existing store boundary. Existing publishing
    storage remains outside this redesign.
11. **SQLite remains the queue implementation at current scale.** Shared
    interfaces must permit a future backend, but Redis, pgmq, Kafka, and a new
    hosted queue are not prerequisites.
12. **Queue delivery is at least once and every processor is idempotent.** No
    correctness assumption depends on exactly-once execution.
13. **Failures are typed state transitions.** Runners do not reconstruct
    provider health or permanence by matching error strings.
14. **Freshness is a product constraint.** Old work cannot silently block new,
    market-moving signals.
15. **Provider choice is configuration owned by one shared gateway.** Individual
    runners do not carry independent model defaults and fallback chains.
16. **Structured inference is ephemeral.** It does not create reusable Hermes
    sessions or accumulate per-item agent memories.
17. **Agent processes run inside operating-system containment.** Linux cgroups
    owned by transient systemd services, not command-pattern sweeping alone, define the cleanup
    boundary.
18. **No destructive cleanup is part of initial adoption.** Existing SQLite or
    Supabase data is retained until a separately reviewed retention operation.

## Non-Goals

- Redesigning the user-facing feed, Story UI, or calendar UI.
- Replacing the entity and entity-memory schemas without evidence that their
  product semantics are insufficient.
- Making every raw signal publishable.
- Allowing an LLM to assign its own trustworthy confidence score.
- Building a general-purpose distributed task platform.
- Introducing Redis, pgmq, Kafka, Kubernetes, or horizontally scaled databases
  before measured load requires them.
- Migrating all source lanes in one deployment.
- Deleting the current backlog or historical failure rows.
- Choosing permanent product relevance thresholds without a historical replay
  evaluation.
- Letting downstream content agents bypass entities and entity memories.

## Platform Components

### 1. Signal Source SDK

The platform exposes one source adapter interface. Adapters may be separate PM2
processes because source polling schedules and credentials differ, but they all
emit the same contract.

```ts
interface SignalSource {
  readonly sourceType: string
  collect(context: CollectionContext): Promise<SignalBatch>
  normalize(raw: unknown, context: CollectionContext): Signal | null
}
```

Canonical Signal v1:

```json
{
  "schemaVersion": "myboon.signal.v1",
  "signalId": "sig_...",
  "sourceType": "news",
  "sourceId": "tokens_xyz:article:...",
  "contentKind": "article",
  "observedAt": "2026-08-26T14:30:00Z",
  "publishedAt": "2026-08-26T14:20:00Z",
  "canonicalUrl": "https://example.com/item",
  "title": "...",
  "visibleSummary": "...",
  "media": {
    "imageUrl": "https://example.com/image.jpg",
    "attribution": "Example"
  },
  "sourceHints": {
    "entities": [],
    "assets": [],
    "eventId": null,
    "deadline": null
  },
  "provenance": {
    "provider": "tokens_xyz",
    "upstreamSource": "Example",
    "rawPayloadRef": "source-local-row-id"
  },
  "idempotencyKey": "source-scoped-stable-key"
}
```

`contentKind` is a discriminant, not a free-form label. The v1 registry starts
with `article`, `market_event`, `calendar_event`, and `social_thread`. Every
kind has a separately versioned `content` payload owned by its Signal Source
adapter. The shared envelope, provenance, identity, and scheduling fields stay
stable; source-specific facts do not get flattened into an article-shaped
contract. New content kinds require a registered schema and contract tests, not
changes to the shared scheduler or Entity Manager orchestration.

The queue carries a reference to the source-local raw payload rather than
duplicating an unbounded opaque payload into every stage.

### 2. Normalization and Deduplication

This stage is deterministic and source-aware through adapter policies. It owns:

- canonical URL and stable source identity;
- tracking-parameter removal;
- exact and material-change fingerprints;
- same-fetch collapse;
- explicit unchanged/material-change decisions;
- provenance preservation;
- schema validation.

Deduplication does not decide market relevance and does not merge distinct
events merely because they mention the same entity.

### 3. Triage and Admission Controller

Triage converts a Signal into one of the following outcomes:

```text
archive       retained signal; no research work created
defer         eligible later when capacity or context changes
light         source retrieval + one structured synthesis call
standard      bounded deterministic external evidence + one synthesis call
deep          bounded browser/fetch agent side queue
```

Triage is rules-first. It may use a cheap, tool-less structured classifier only
for ambiguous cases. It must never invoke a general research agent.

Initial triage inputs include:

- source authority and content kind;
- exact and material-change dedupe outcome;
- freshness and event deadline;
- relation to the entity canon or active entity memories;
- novelty versus recent research packets and memories;
- asset, market, regulatory, macro, security, or calendar relevance;
- official/primary-source status;
- source-specific materiality indicators;
- current queue capacity and provider health.

Absence from the existing entity canon is not sufficient to archive a signal.
An authoritative or materially novel signal must retain a path to research so
the system can learn new entities.

Tier percentages are not hard-coded. A historical replay establishes the
baseline distribution and the false-negative cost of triage decisions.

### 4. Shared Scheduler and Durable Queue Contract

The platform defines one logical queue contract. Physical rows may remain in
`news.sqlite` and `pipeline.sqlite` during migration. Registered store adapters
allow one scheduler and shared worker pool to lease across those stores by
priority without first consolidating the databases.

Research Work Item v1:

```json
{
  "schemaVersion": "myboon.research_work.v1",
  "workId": "work_...",
  "signalId": "sig_...",
  "sourceType": "news",
  "researchDepth": "standard",
  "priorityClass": "P1",
  "priorityScore": 0.82,
  "freshnessDeadline": "2026-08-26T16:30:00Z",
  "policyVersion": "triage-2026-08-26.1",
  "researchContractVersion": "myboon.research_packet.v1",
  "retrievalPlan": {
    "sourceUrl": "https://example.com/item",
    "allowedDomains": ["example.com"],
    "maxExternalSources": 3
  },
  "budget": {
    "maxProviderCalls": 1,
    "maxRepairCalls": 1,
    "maxInputTokens": 15000,
    "maxOutputTokens": 3000,
    "maxToolCalls": 0,
    "maxWallTimeMs": 90000
  },
  "attemptCount": 0,
  "nextAttemptAt": null,
  "traceId": "trace_..."
}
```

Minimum durable fields:

```text
work_id
signal_id
source_type
research_depth
priority_class
priority_score
freshness_deadline
status
attempt_count
next_attempt_at
lease_owner
lease_expires_at
failure_category
failure_detail
policy_version
research_contract_version
trace_id
created_at
updated_at
```

Registered stores implement one source-neutral adapter contract. No
cross-database transaction is assumed:

```ts
interface ResearchWorkStoreAdapter {
  readonly sourceType: string

  peekEligible(input: {
    now: string
    priorityClasses: PriorityClass[]
    limit: number
  }): Promise<WorkCandidate[]>

  tryClaim(input: {
    workId: string
    leaseOwner: string
    leaseTtlMs: number
    expectedState: ResearchWorkState
  }): Promise<WorkLease | null>

  heartbeat(lease: WorkLease, extendByMs: number): Promise<WorkLease | null>
  transition(lease: WorkLease, transition: WorkTransition): Promise<void>
  release(lease: WorkLease, reason: ReleaseReason): Promise<void>
}
```

Each adapter returns only a bounded eligible head. The shared scheduler merges
those heads by priority class, freshness deadline, priority score, and age,
then uses transactional compare-and-set claims. If another worker wins a
claim, the scheduler selects the next eligible item. Store adapters never
attempt to order work from another store, and source-specific SQL does not leak
into scheduler policy.

Queue ordering uses priority class, freshness deadline, and age. It is not
oldest-created-first across all work.

### 5. Deterministic Retrieval

The retrieval worker is code, not an agent. It receives an approved retrieval
plan and returns bounded evidence artifacts.

Responsibilities:

- validate public URL and every redirect destination before a request reaches
  the destination;
- use HTTP extraction first;
- use Agent Browser rendering only for pages that require it;
- enforce domain allowlists, response byte limits, redirect limits, and wall
  time;
- convert HTML into bounded readable text;
- preserve final URL, content hash, retrieval method, timestamp, and errors;
- retrieve only the number of sources allowed by the work budget;
- never expose terminal, code execution, arbitrary file access, or general web
  search to the synthesis model.

Retrieved evidence is immutable and addressable by evidence ID. Retries reuse
successful evidence when it is still within its freshness policy.

The retrieval plan may contain URLs from exactly three code-owned authorities:

1. the canonical source URL;
2. related URLs supplied and normalized by the Signal Source adapter; or
3. results returned by a registered deterministic Search Connector.

A synthesis model cannot invent, approve, or expand the retrieval plan. Search
Connectors have their own provider budget, query builder, domain policy,
result limit, timeout, and typed failure behavior. General search controlled by
an agent is available only to admitted deep work.

Evidence reuse is controlled by a versioned policy selected by content kind and
source class:

```ts
interface EvidenceFreshnessPolicy {
  policyVersion: string
  maxAgeMs: number
  maxArtifactBytes: number
  invalidateOn: Array<
    | 'content_hash_changed'
    | 'final_url_changed'
    | 'source_material_change'
    | 'retrieval_became_blocked'
    | 'manual_invalidation'
  >
}
```

Calendar and market-event policies may additionally expire evidence at an
event deadline. Exact TTLs and storage budgets are configuration approved from
historical replay and disk-capacity measurements; they are not embedded in
worker code. The retention job reports a dry-run artifact inventory before any
separate deletion approval.

### 6. Structured Research Synthesizer

The common case is one provider request:

```text
validated Signal + bounded Retrieved Evidence + response schema
  -> tool-less structured generation
  -> deterministic schema validation
  -> optional one-call JSON repair
  -> Research Packet
```

This path does not use an interactive Hermes agent session. It calls the shared
Inference Gateway in `generateStructured` mode with no tools and a hard turn
limit. If Hermes remains an implementation detail, the wrapper must provide a
provably tool-less, ephemeral execution mode. A direct provider SDK is allowed
and preferred when it gives stronger guarantees.

The synthesizer separates:

- source claims;
- externally verified facts;
- unresolved or contradicted claims;
- evidence references;
- entity hints;
- limitations;
- open questions;
- provenance and budget usage.

It does not score publishability, give trade recommendations, select durable
entities, or decide the final narrative.

### 7. Deep Research Side Queue

Deep research is used only when triage or standard synthesis identifies a
material unresolved question that justifies the cost.

Admission requires at least one typed escalation reason:

```ts
type DeepEscalationReason =
  | 'conflicting_primary_sources'
  | 'insufficient_primary_evidence'
  | 'rendering_required_for_material_fact'
  | 'entity_identity_ambiguous'
  | 'regulatory_interpretation_required'
  | 'manual_analyst_request'
```

Free-form uncertainty or model self-confidence cannot enqueue deep work. Each
reason is emitted with evidence references, the unresolved question, and the
policy rule that admitted it. A deterministic policy may decline escalation
when freshness, capacity, or budget cannot justify the work.

Allowed capabilities:

- browser navigation to approved public domains;
- bounded search through an explicitly configured provider;
- bounded HTTP fetch;
- evidence capture.

Forbidden capabilities:

- shell or terminal;
- code execution;
- arbitrary local file system access;
- package installation;
- worktree or repository modification;
- broad browser profiles shared across jobs;
- unbounded session continuation.

Deep work executes inside a dedicated transient systemd service and its Linux cgroup with CPU,
memory, PID, and wall-time limits. `KillMode=control-group` or equivalent must
terminate descendants even if a tool creates a new process session.

The deep queue cannot silently fall back to a weaker model mid-investigation.
Retryable provider failure returns the item to `retry_wait`; permanent budget
exhaustion produces a partial packet or dead letter according to policy.

### 8. Shared Inference Gateway

One local gateway owns model/provider behavior for every lane. Workers do not
carry independent model configuration or circuit breakers.

Gateway modes:

```text
classify            cheap tool-less structured decision
generateStructured  one tool-less schema-constrained result
repairStructured    one bounded schema repair
investigate         contained deep-research execution
```

The gateway owns:

- provider and model routing by workload;
- reasoning effort;
- global and per-lane concurrency;
- rate and cost budgets;
- timeout policy;
- typed retryable/permanent errors;
- circuit breaker state and recovery probes;
- usage accounting;
- model, prompt, and policy version capture;
- per-call tracing.

Initial routing intent for review:

```text
structured classify/synthesis/entity extraction
  primary: Ollama Cloud deepseek-v4-flash
  fallback: explicitly approved OpenRouter model
  reasoning effort: low

deep investigation
  primary: separately selected browser-capable model
  fallback: none mid-flight; requeue instead
```

Retired or availability-unknown free models such as OX Alpha are not valid
routes. Any OpenRouter fallback must be named explicitly, reviewed, and bounded;
free pricing is never a reason to accept unbounded calls, latency, or invalid
output.

When all providers for a workload are unhealthy:

- no worker claims new work for that workload;
- claimed retryable work returns to `retry_wait` without becoming terminal;
- collection and raw Signal storage may continue;
- triage may continue deterministically;
- the gateway emits one state-transition alert, not one error per skipped tick;
- recovery permits one controlled probe before normal traffic resumes.

### 9. Shared Entity Manager

All source adapters converge on one Research Packet contract and one Entity
Manager implementation.

Research Packet v1:

```json
{
  "schemaVersion": "myboon.research_packet.v1",
  "packetId": "research_...",
  "workId": "work_...",
  "signalId": "sig_...",
  "sourceType": "news",
  "observedAt": "2026-08-26T14:30:00Z",
  "sourceSignal": {
    "title": "...",
    "canonicalUrl": "https://example.com/item",
    "publishedAt": "2026-08-26T14:20:00Z",
    "provenance": {}
  },
  "claims": [],
  "verifiedFacts": [],
  "unresolvedClaims": [],
  "evidence": [],
  "entityHints": [],
  "limitations": [],
  "openQuestions": [],
  "completion": "complete",
  "budgetUsed": {
    "providerCalls": 1,
    "inputTokens": 8200,
    "outputTokens": 1400,
    "toolCalls": 0,
    "wallTimeMs": 12000
  },
  "execution": {
    "provider": "...",
    "model": "...",
    "policyVersion": "...",
    "traceId": "trace_..."
  }
}
```

Entity Manager owns:

- deterministic shortlist construction;
- canonical entity selection;
- new entity creation when justified;
- memory type and role assignment;
- same-story reconciliation;
- idempotent entity-memory writes;
- durable provenance;
- source-specific memory adaptation through small registered policies, not
  separate runners.

Durable memory idempotency cannot depend on a model-generated title. Every
write carries a stable `memoryIdentityKey` derived from the Research Packet
identity, canonical entity ID, memory type/role, and the sorted claim/evidence
IDs represented by that memory. Replaying the same packet may update the same
memory slot but cannot insert another row merely because wording changed. A
new packet version remains linked to the prior packet and follows explicit
same-story reconciliation policy.

The admission boundary is explicit:

```ts
interface EntityAdmissionInput {
  packet: ResearchPacket
  canonicalEntityShortlist: CanonicalEntityRef[]
  entityHints: EntityHint[]
  evidenceSpans: EvidenceSpan[]
  shortlistPolicyVersion: string
}
```

The shortlist builder is code-owned and reproducible from versioned alias,
exact-identity, and similarity policies. A model may select among the bounded
shortlist or propose `create_new`; deterministic thresholds and evidence rules
validate that proposal before a durable write. Entity Manager must not ask a
model to search the full entity corpus or accept an unreferenced entity ID.
If the authoritative canon cannot be loaded, automated new-entity creation
fails closed with `storage_transient` and retries; availability pressure is not
permission to create an identity without a complete duplicate check.

The Research Packet may carry known-entity hints and evidence spans. Those are
inputs, not final identity decisions. Model self-confidence is not accepted as
proof of identity or evidence quality.

Entity Manager writes through `SupabaseEntityMemoryStore`. Processing cursors,
leases, attempts, and failure markers remain in local SQLite and never become
`source_marker` memories.

### 10. Product Surfaces

Downstream systems read entity knowledge, not source-specific research rows.

Examples:

- Feed requests recent entity memories and published narratives.
- Publisher selects and writes narratives from entity context.
- X content agents propose posts from eligible entity-memory updates.
- Market Calendar presents event-linked entity memories by effective date.
- Alerts subscribe to high-priority entity-memory events.

Adding a Surface must not require modifying Signal Sources or the research
engine.

Surfaces depend on a versioned read service rather than issuing bespoke
Supabase queries:

```ts
interface EntityKnowledgeReader {
  getEntityMemories(input: {
    entityId: string
    since?: string
    limit: number
    memoryTypes?: string[]
    cursor?: string
  }): Promise<EntityMemoryPage>

  getRecentEntityMemories(input: {
    priorityClasses?: PriorityClass[]
    since?: string
    limit: number
    cursor?: string
  }): Promise<EntityMemoryPage>

  getEntityMemoryChanges(input: {
    afterCursor: string
    limit: number
  }): Promise<EntityMemoryChangePage>
}
```

Polling, Supabase Realtime, or another delivery mechanism may implement change
delivery later; the contract is cursor-based and does not require an in-process
callback or a specific transport.

## Research Depth and Default Budgets

Initial defaults are guardrails for implementation and load testing. Final
values require historical replay and quality review.

| Depth | Intended use | Retrieval | Provider calls | Tools | Wall time |
| --- | --- | --- | --- | --- | --- |
| archive | duplicate, stale, low-product-value observation | none | 0 | 0 | none |
| light | source can support a useful factual packet | source document | 1 + optional repair | 0 | 90s |
| standard | material item needs bounded corroboration | source + up to 3 approved evidence URLs | 1 + optional repair | 0 | 120s |
| deep | material ambiguity or conflict remains | bounded browser/fetch investigation | <=5 | <=10 browser/fetch steps | 300s |

A budget breach is a typed outcome. It is not permission for the model to
continue, and it is not automatically retryable.

## Durable State Machine

Canonical work states:

```text
signal_observed
  -> triage_pending
  -> archived | deferred | research_pending

research_pending
  -> retrieval_leased
  -> synthesis_pending -> synthesis_leased          (light/standard)
  -> deep_pending -> deep_leased                    (deep side queue)
  -> research_ready

research_ready
  -> entity_pending
  -> entity_leased
  -> complete
```

Cross-cutting states:

```text
retry_wait   retryable failure with next_attempt_at
expired      freshness deadline passed according to policy
dead_letter permanent failure or exhausted attempts
```

Every lease has an owner and expiry. A crashed worker cannot strand work. A
recovery pass atomically returns expired leases to the appropriate pending state
and emits an audit event.

Allowed failure categories are typed constants, including:

```text
provider_unavailable
provider_rate_limited
provider_timeout
provider_authentication
circuit_open
retrieval_timeout
retrieval_blocked
retrieval_unsafe_url
budget_exceeded
invalid_structured_output
schema_version_mismatch
permanent_source_error
entity_resolution_failed
storage_transient
storage_permanent
```

Required semantics:

- `circuit_open` does not increment per-item attempts and does not become a
  terminal failure;
- provider timeout, connection failure, or 429 uses bounded exponential backoff;
- malformed structured output permits at most one repair call before normal
  retry/dead-letter policy;
- unsafe or non-public URLs are permanent unless source metadata changes;
- expired work remains visible and countable;
- dead letters are queryable by source, stage, category, and age;
- replay clears only the relevant failure state and remains idempotent.

## Idempotency and Replay

Every stage has an explicit identity:

```text
Signal             source-scoped idempotency key
Research Work      signal ID + policy version + research depth
Research Packet    work ID + research contract version
Entity Memory      code-owned stable memory identity key
```

Feed V3 replaces the legacy title-bearing Entity Memory tuple with the
code-owned `memory_identity_key` (`myboon.memory_identity.v1:<sha256>`). The
identity is derived from canonical packet/work/entity/evidence provenance and
does not depend on model-generated titles or prose. Existing rows are
backfilled one-for-one with a legacy compatibility identity; they are never
merged or deleted during this migration.

Replaying a work item may create a new attempt and packet version, but it cannot
silently duplicate the same entity memory. Every final result records the input
signal, work item, packet, policy, model, and attempt that produced it.

The reusable recovery command remains dry-run by default, bounded by batch
size, backs up the affected SQLite database before `--apply`, and prints every
row touched.

## Backpressure and Freshness

Backpressure controls research admission rather than stopping source
observation.

When queue pressure rises:

1. Raw Signals continue to be stored and deduplicated.
2. P0 official, security, regulatory, event-deadline, and material signals keep
   their reserved capacity.
3. Lower-priority ambiguous signals are deferred rather than automatically
   promoted to research.
4. Deep admissions tighten before light/standard admissions.
5. Work past its freshness deadline transitions visibly to `expired` or is
   re-triaged; it does not remain invisible `pending` work.

Priority is not an LLM importance score. It is a deterministic policy output
based on source class, product rules, deadlines, freshness, and measured queue
capacity.

The scheduler reserves capacity by class so a large low-priority backlog cannot
starve urgent work.

The control plane exposes research-capacity utilization to Signal Sources for
telemetry and operator visibility, but ordinary research pressure does not
authorize a source to skip polling or discard observations. Collection may be
throttled only by an explicit source-rate-limit or storage-emergency policy.
Bounded raw-signal retention, deduplication, and compaction protect disk usage;
the expensive control point remains research admission.

## Storage Boundary

The initial implementation preserves current physical ownership:

```text
packages/collectors/.data/news.sqlite
  news signals, queue state, evidence, research packets, attempts, audit events

packages/collectors/.data/pipeline.sqlite
  Polymarket signals, queue state, evidence, research packets, attempts, audit events

Supabase
  final entities and entity memories written by Entity Manager
  existing publishing/product tables outside this PRD remain unchanged
```

The shared platform depends on store interfaces and common contracts rather
than identical physical table names. A future unified local database remains
possible, but is neither required nor assumed.

SQLite requirements:

- WAL mode;
- transactional compare-and-set claims;
- indexed pending/priority/freshness queries;
- bounded transactions that never include provider calls;
- online status/count queries;
- backup and restore verification;
- retention and vacuum operations separated from live processing;
- no deletion of existing data during migration.

## Process and Resource Isolation

Structured inference runs in-process or as a tightly bounded child with no tool
execution and no persistent session.

Deep research runs in an operating-system containment boundary. Each job is
tagged with `trace_id` and `work_id` and receives:

- CPU quota;
- memory limit;
- PID limit;
- wall-clock deadline;
- isolated temporary directory;
- controlled network policy;
- `KillMode=control-group` or equivalent;
- guaranteed cleanup verification before the lease is released.

The orphan sweeper remains a safety net, not the primary lifecycle mechanism.
It discovers jobs from registered execution metadata/cgroups instead of broad
process-name patterns. It separately audits stale browser profiles, sandbox
executors, and temporary directories.

No agent-generated code is executed in the normal research path.

Before Phase 6, an implementation ADR and checked-in deployment artifact must
define whether the VPS uses a transient systemd service or a service template,
including the exact CPU, memory, task, runtime, filesystem, privilege, network,
and control-group kill properties. The PRD does not mandate a sample unit name
or `--scope` invocation: verification of the isolation properties and complete
descendant cleanup is the contract.

## Observability and Control Plane

Every work item carries one `trace_id` through:

```text
collection -> triage -> queue -> retrieval -> synthesis -> Entity Manager -> memory write
```

Each stage appends an immutable event containing:

```text
event_schema_version
event_id
trace_id
work_id
stage
attempt
started_at
finished_at
status
failure_category
queue_wait_ms
wall_time_ms
provider
model
provider_calls
input_tokens
output_tokens
tool_calls
budget_exceeded
```

Inference events additionally record configured primary provider/model, actual
provider/model, fallback invocation and reason, output-schema validity, and
usage/cost. Downstream packet acceptance and Entity Manager acceptance are
separate correlated events on the same trace rather than claims made by the
gateway itself. This permits fallback quality to be compared without coupling
provider routing to downstream business decisions.

Required aggregate status:

- signals observed and deduplicated by source;
- triage outcomes by source and depth;
- pending, leased, retrying, expired, and dead-letter counts;
- oldest and p95 queue age by priority/depth;
- completed packets and entity-memory handoffs;
- end-to-end p50/p95/p99 latency;
- provider success rate and latency;
- circuit state and next probe time;
- tokens and cost per completed packet;
- budget breaches;
- active contained jobs and orphan cleanup results;
- SQLite size, unfinished execution count, and write errors.

PM2 `online` is process availability only. Platform health requires queue age,
throughput, success, and downstream handoff to be within SLO.

Initial alerts:

1. P0/P1 oldest pending age exceeds its SLO.
2. Five-minute provider error rate exceeds 10% or a provider circuit opens.
3. Rolling research completion rate remains below admission rate for 30 minutes.
4. Any contained job survives its termination deadline.
5. Dead-letter or storage-error rate exceeds its reviewed threshold.

Alerts must state the affected stage, source, provider, queue age, and suggested
runbook command without exposing secrets or prompt contents.

## Service-Level Objectives

Final numbers require review, but the implementation must be measured against
explicit objectives rather than “workers are online.”

Priority semantics are versioned product policy. Product owns the meaning and
false-negative tradeoff; the platform team owns deterministic enforcement,
capacity reservation, and measurement. The Phase 0 baseline is:

- **P0:** an active security incident, market halt, official release/event at
  or near its effective deadline, or immediate regulatory action whose value
  materially decays within minutes;
- **P1:** authoritative, materially market-relevant information whose product
  value materially decays within the same day;
- **P2:** useful current context without an immediate deadline;
- **P3:** background, low-confidence, or deferrable context.

Source policies must translate their native facts into this common taxonomy and
contract tests must prove that a source cannot label all work P0/P1. The exact
deadline windows and category rules are approved in `PriorityPolicy.v1` before
SLO enforcement or production cutover.

Proposed initial SLOs:

- P0 end-to-end Signal-to-Research-Packet p95 under 15 minutes.
- P1 end-to-end p95 under two hours.
- Light research p95 under 90 seconds of execution time.
- Standard research p95 under 120 seconds of execution time.
- Light/standard provider calls average no more than 1.1 per successful item,
  excluding the separately reported repair rate.
- Light/standard interactive tool calls equal zero.
- Sustainable research capacity is at least twice the rolling admitted arrival
  rate during a load test.
- Circuit-open events create zero terminal item failures.
- Expired leases recover without manual repair.
- Entity-memory replay creates zero duplicate durable memories.
- Orphaned live processes after timeout equal zero.
- Queue age and completion metrics remain queryable even when providers are
  unavailable.

## Evaluation Before Production Policy

Triage and research-depth policy must be evaluated against at least 1,000
historical signals sampled across News and Polymarket.

The review set includes:

- signals that produced useful entity memories;
- duplicates and cosmetic changes;
- official announcements;
- novel entities absent from the canon;
- security, regulatory, macro, earnings, market, social, and unrelated content;
- source failures, blocked pages, and conflicting claims;
- time-sensitive items that became worthless when stale.

Measure:

- archive/defer/light/standard/deep distribution;
- false negatives for product-relevant signals;
- entity-memory usefulness judged without seeing the tier decision;
- provider calls, tokens, tools, and wall time;
- evidence completeness and attribution;
- invalid output and retry rate;
- estimated capacity at production arrival rates.

No target such as `80/15/5` is accepted until the replay demonstrates it.

## Contracts Appendix

These are the implementation seams that must be versioned and tested before a
source is cut over. TypeScript definitions are authoritative in code; this
table defines ownership and compatibility expectations.

| Contract | Initial version | Owner | Compatibility proof |
| --- | --- | --- | --- |
| Signal envelope and content-kind registry | `myboon.signal.v1` | Signal Source SDK | fixtures for every registered source/kind |
| Research work and budget | `myboon.research_work.v1` | Triage/Scheduler | schema, ordering, and budget tests |
| Store adapter and lease transitions | `myboon.work_store.v1` | Scheduler | shared conformance suite against every SQLite adapter |
| Retrieved evidence and freshness policy | `myboon.evidence.v1` | Retrieval | redirect, hash, TTL, byte-cap, and invalidation tests |
| Research Packet | `myboon.research_packet.v1` | Research | schema fixtures and backward-compatibility tests |
| Deep escalation request | `myboon.deep_request.v1` | Triage/Research | typed-reason and admission-policy tests |
| Entity admission input | `myboon.entity_admission.v1` | Entity Manager | shortlist, evidence-span, and identity fixtures |
| Entity knowledge read model | `myboon.entity_knowledge.v1` | API/Surfaces | pagination, filtering, and cursor contract tests |
| Execution event | `myboon.execution_event.v1` | Control Plane | append-only schema and old-event parsing tests |
| Provider route policy | `myboon.provider_route.v1` | Inference Gateway | primary/fallback/degraded routing tests |

Compatibility rules:

1. Producers persist their emitted schema version; consumers reject unknown
   major versions with `schema_version_mismatch` rather than guessing.
2. Additive optional fields are permitted within a major version. Required
   field removal or semantic change requires a new major version and adapter.
3. Queue/store migrations use expand-read-write-contract sequencing and never
   require destructive cleanup for rollback.
4. Every store adapter runs the same lease, heartbeat, expiry recovery,
   idempotency, and ordering conformance suite.
5. Events are append-only. Corrections append a new event referencing the prior
   event ID; historical rows are not rewritten.

## Verification Strategy

### Contract tests

- Every Signal Source passes the canonical Signal contract suite.
- Every Research Packet adapter passes the shared packet schema suite.
- Unknown fields remain forward-compatible while required fields fail loudly.
- Schema and policy versions are persisted through the full trace.

### State-machine tests

- Atomic claim prevents two workers from owning one lease.
- Crash after claim returns work after lease expiry.
- Circuit open leaves work pending/retryable without incrementing attempts.
- Retryable failures apply bounded backoff.
- Permanent failures and exhausted attempts become visible dead letters.
- Freshness expiry remains visible and countable.
- Replay is idempotent at research and entity-memory boundaries.

### Budget tests

- Light/standard modes cannot call terminal, code, browser, web search, or file
  tools.
- Structured inference terminates after the configured call and token limits.
- Deep mode rejects forbidden tools and excess domains.
- Artificial infinite-loop descendants are killed by cgroup termination.
- No live process, browser profile, lock, or temporary directory survives a
  timed-out test job.

### Security tests

- Public URL redirecting to private IP is blocked before the private request.
- DNS rebinding and IPv4/IPv6 private ranges are rejected.
- Retrieved documents remain untrusted evidence and cannot change tool policy.
- Logs and traces never contain credentials or full prompts.
- Deep network policy permits only approved public destinations.

### Quality and load tests

- Historical replay compares current and proposed packets blind to cost.
- Two-times observed arrival load maintains stable queue depth.
- Provider outage injection demonstrates deterministic degraded behavior.
- Invalid JSON, timeout, 429, connection reset, and storage-lock scenarios are
  separately classified.
- A 24-hour soak has no rapid restarts, no SQLite/FTS write errors, no orphan
  processes, and bounded state growth.

### End-to-end tests

For each adopted source:

```text
realistic raw input
  -> canonical Signal
  -> triage decision
  -> bounded retrieval
  -> Research Packet
  -> shared Entity Manager
  -> final entity memory
  -> eligible downstream Surface read
```

The test records the trace, budget, queue transitions, and durable memory ID.

## Migration Plan

Migration is incremental. Every phase has a measurable shadow or rollback path.

### Phase 0 — Approve contracts and SLOs

- Review vocabulary, storage boundary, state machine, budgets, and open
  questions.
- Approve `PriorityPolicy.v1`, evidence freshness/retention policies, deep
  escalation reasons, and the registered content-kind schemas.
- Capture the current production baseline and back up both SQLite databases.
- Rotate any exposed provider credentials before further production tests.
- Build the historical evaluation set.

No production behavior changes.

### Phase 1 — Shared contracts and execution ledger

- Add Signal, ResearchWorkItem, RetrievedEvidence, ResearchPacket, typed error,
  budget, and trace contracts.
- Implement and prove the adapter contract against News first, then add the
  Polymarket adapter after the scheduler/lease contract passes failure-injection
  tests against one store.
- Add the execution ledger and aggregate status queries.
- Preserve existing runners while validating contract compatibility.

### Phase 2 — Shadow triage

- Begin append-only canonical Signal writes beside legacy candidate writes.
  Mutable Polymarket candidate threads remain a legacy projection; they are not
  the authoritative history. Research backpressure may suppress work admission
  but cannot suppress the canonical Signal write.
- Run triage against live Signals without changing research admission.
- Compare proposed decisions against eventual research/memory outcomes.
- Tune rules using the historical and shadow evaluation sets.
- Publish queue-capacity projections before enforcement.

### Phase 3 — Tool-less structured research

- Implement deterministic retrieval and the shared Inference Gateway.
- Run the new light/standard path in shadow on a bounded sample.
- Compare packet quality, evidence, tokens, calls, and latency against the
  current Hermes path.
- Prove forbidden tool-call count is zero.

### Phase 4 — News cutover

- Admit News work through the shared scheduler.
- Keep raw News signals and all current SQLite data.
- Feed canonical Research Packets to the existing Entity Manager boundary.
- Enable backpressure, freshness priority, typed retry, and circuit semantics.
- Run a controlled 24-hour soak before retiring the old News researcher.

### Phase 5 — Shared Entity Manager

- Replace source-specific Entity Manager runners with one worker and registered
  source adaptation policies.
- Add source-scoped ownership controls (`legacy` or `shared`) and hard-fail
  startup if two active workers can claim the same source. Shadow validation
  may read and measure but cannot claim, advance cursors, or write memories.
- Preserve `SupabaseEntityMemoryStore` as the final write boundary.
- Introduce a stable memory identity key independent of generated titles and
  backfill it non-destructively before relying on replay idempotency.
- Prove idempotent replay and same-story reconciliation for each source.
- Retire source-specific orchestration only after parity.

### Phase 6 — Deep research containment

- Introduce the deep side queue only after light/standard throughput and quality
  meet SLO.
- Deploy cgroup isolation through a transient systemd **service** and failure
  injection tests. The exact unit properties and the reason a service is used
  instead of a scope are owned by the Deep Research containment ADR.
- Start with one concurrent deep job and expand only from measured demand.

### Phase 7 — Polymarket and future sources

- Migrate Polymarket through adapters without changing the shared spine.
- Add Market Calendar and X as Signal Sources and Surfaces as appropriate.
- A new source is accepted only if it implements the Signal contract and
  source-specific normalization/retrieval policy without introducing another
  researcher or Entity Manager runner.

### Phase 8 — Retire legacy paths and approve retention

- Remove source-specific research orchestration after a successful soak and
  replay audit.
- Produce a dry-run inventory of obsolete queue rows, sessions, and temporary
  artifacts.
- Handle any deletion or archival through a separately approved cleanup plan.

## Operational Runbook Requirements

The completed platform provides commands for:

- aggregate and per-source status;
- queue counts and oldest age by priority/depth;
- provider and circuit health;
- trace inspection by signal/work/packet ID;
- dry-run/apply recovery by time range, source, stage, category, and ID;
- dead-letter counts and oldest item;
- SQLite backup and restore verification;
- contained-process and orphan audit;
- controlled drain, restart, and resume;
- retention preview without deletion.

The normal runbook must not require direct SQL updates.

## Risks and Mitigations

### Triage hides a valuable novel signal

Mitigation: retain raw Signals, provide an authoritative/novelty override,
sample archived work for audit, and evaluate false negatives before enforcing
thresholds.

### Shared infrastructure creates a larger blast radius

Mitigation: source-aware quotas, per-lane budgets, typed isolation boundaries,
contract tests, and incremental cutover. A failure in one adapter cannot consume
all provider or worker capacity.

### SQLite becomes the next bottleneck

Mitigation: WAL, indexed lease queries, short transactions, measured load at two
times arrival, and backend-neutral store interfaces. Migrate only after evidence.

### Tool-less research reduces evidence quality

Mitigation: bounded deterministic evidence connectors, blind packet evaluation,
and explicit escalation to deep research for material unresolved questions.

### Provider fallback changes output quality

Mitigation: route by workload, persist model/version, validate every schema,
track fallback quality separately, and never silently switch a deep job
mid-flight.

### Entity Manager becomes the later bottleneck

Mitigation: preserve its own queue and budgets, measure packet-to-memory latency,
keep writes idempotent, and partition only when observed throughput requires it.

### Migration duplicates or loses work

Mitigation: shadow operation, stable idempotency keys, immutable audit events,
dual-read comparison without dual-writing durable memories, backups, and
phase-specific rollback.

## Open Product and Architecture Questions

1. What are the reviewed P0 and P1 freshness SLOs for News, Polymarket, and
   Market Calendar signals?
2. Which signal categories are always admitted even when no canonical entity is
   currently known?
3. May light/standard research emit a visibly `partial` packet during provider
   degradation, or must it always wait?
4. How long are archived raw Signals, Retrieved Evidence, execution events, and
   dead letters retained?
5. Which registered Search Connector and domain policies are approved for the
   first standard-research production cutover?
6. What packet-quality rubric determines whether tool-less research matches the
   existing path?
7. Is `deep` research automatically selected by policy, manually approved, or
   both?
8. Which approved model is the OpenRouter fallback when Ollama Cloud is primary?
9. Should urgent capacity be reserved separately for each source or globally by
   priority class?
10. How should the existing backlog be handled during cutover: finish, re-triage,
    expire by policy, or preserve without execution?
11. Is the long-term product/platform name `Signal-to-Knowledge`, `Research
    Platform`, or another name? Feed V3 remains the product-generation context,
    not necessarily the package name.

## Acceptance Criteria

Checked items below have repository-level evidence from the 2026-08-26
verification run: Signal Platform 91/91, Inference Gateway 28/28, shared
Research/Deep/Hermes 153/153, Entity Manager 157/157, News 86/86, Polymarket
markets 16/16, legacy Polymarket researcher 14/14, pipeline store 76/76,
editor/publisher 17/17, and API Feed/Entity Knowledge 24/24; shared,
tx-parser, and collectors builds passed. Unchecked items require historical,
VPS, Supabase rehearsal, product-adoption, load, or soak evidence and must not
be inferred from unit tests.

- [x] A new source can enter the pipeline by implementing the Signal Source and
      store-adapter contracts without adding a new researcher or Entity Manager
      runner.
- [x] Every source-local store passes the shared lease/heartbeat/expiry,
      ordering, transition, and idempotency conformance suite.
- [x] Evidence reuse obeys a versioned freshness policy and invalidates on
      material content, URL, source, or retrieval-state changes.
- [x] News and Polymarket can both produce the same versioned Research Packet
      shape.
- [x] Light/standard research performs zero interactive tool calls.
- [ ] Light/standard research averages no more than the approved provider-call,
      token, and latency budgets on the historical evaluation set.
- [ ] Deep research is isolated by a transient systemd service/cgroup and cannot leave a live
      descendant after timeout.
- [x] Every deep admission carries a typed escalation reason, supporting
      evidence, unresolved question, and policy version.
- [x] Triage retains a reviewed path for authoritative signals and novel
      entities absent from the canon.
- [x] Raw Signals remain stored when research admission is deferred or denied.
- [x] The queue uses transactional leases, typed failures, bounded retry, visible
      expiry, and queryable dead letters.
- [x] Circuit-open behavior claims no new work and produces zero terminal item
      failures.
- [x] Fresh P0/P1 work is not blocked by a low-priority historical backlog.
- [x] Shared provider routing, budgets, concurrency, circuits, and usage are
      observable from one gateway.
- [x] Entity Manager remains the only writer of final entity identity and entity
      memories.
- [x] A temporary canon-read failure cannot create a new entity, and replaying
      identical packet evidence with different generated wording cannot create
      a duplicate memory.
- [x] Startup rejects dual active ownership for a source; shadow mode performs
      no claims, cursor transitions, or durable memory writes.
- [x] Replay creates no duplicate research result for the same version and no
      duplicate durable entity memory.
- [x] Aggregate status reports arrival, admission, completion, queue age,
      failures, provider health, budget use, and entity-memory handoff.
- [x] Immutable execution events carry a schema version and distinguish primary
      routing, fallback use, schema validity, and downstream acceptance.
- [ ] Product Surfaces read entity knowledge through the versioned cursor-based
      read contract rather than source-specific research tables.
- [ ] The proposed system sustains at least twice the measured admitted arrival
      rate in load testing.
- [ ] A 24-hour production soak meets the reviewed freshness and failure SLOs
      without manual SQL repair, rapid PM2 restarts, orphan processes, or
      unbounded Hermes state growth.
- [x] Existing SQLite and Supabase data is not deleted during migration.
- [x] Legacy source-specific research and Entity Manager orchestration is removed
      only after source-by-source parity and rollback verification.

## Definition of Done

This initiative is complete when MyBoon operates one observable,
source-independent path from admitted Signal to durable Entity Memory; the
normal path is deterministic and bounded; deep agent work is exceptional and
contained; queue health stays within freshness SLO under measured load; provider
outages do not lose work; and adding Market Calendar or X requires adapters and
policies rather than another vertically duplicated pipeline.
