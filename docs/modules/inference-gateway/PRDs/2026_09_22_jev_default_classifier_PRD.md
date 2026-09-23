# Jev-First Classification Gateway PRD

Status: Phase 0 foundation implemented; all workloads safe-off by default, no Jev-authoritative production activation authorized
Created: 2026-09-22
Last revised: 2026-09-23
Owner: myboon pipeline / inference gateway
Module: inference-gateway
Decision: use Jev as the default provider for bounded classification, with the existing Hermes route as the automatic fallback
Implementation boundary: shared registry/adapters plus disabled workloads first; downstream decomposition requires child PRDs

Implementation note (2026-09-23): the shared contracts, source-controlled
registry, direct one-attempt Jev adapter, same-definition Hermes fallback,
linked audit records, SQLite deployment-wide capacity/circuit control,
immutable shadow outbox/worker, Entity identity reference fixtures, and
`research.novelty` consumer adapter are implemented. Entity identity remains
shadow-only, `research.novelty` is only canary-capable, and both definitions
default to `disabled` (Hermes authoritative with no Jev call).

Related:

- [`2026_08_26_feed_v3_signal_to_knowledge_platform_PRD.md`](../../entity-manager/PRDs/2026_08_26_feed_v3_signal_to_knowledge_platform_PRD.md)
- [`2026_09_11_entity_knowledge_model_PRD.md`](../../entity-manager/PRDs/2026_09_11_entity_knowledge_model_PRD.md)
- [TypeSafe models](https://docs.typesafe.ai/models)
- [TypeSafe primitives](https://docs.typesafe.ai/primitives)
- [TypeSafe confidence](https://docs.typesafe.ai/confidence)
- [TypeSafe knowledge-graph entity alignment](https://docs.typesafe.ai/cookbooks/entity_alignment)
- [TypeSafe JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)
- [TypeSafe JavaScript request options](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RequestOptions)
- [TypeSafe JavaScript retry policy](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy)

## Executive Summary

MyBoon is a conveyor belt:

```text
Scout -> Triage -> Research -> Entity Manager -> Editor -> Publisher / X Desk
```

Every hand-off contains small judgment calls: Is this relevant? Is it new? Which
known Entity does it concern? Is it the same event? Should a memory be kept,
updated, or dropped? These are classification decisions, not open-ended research
or writing tasks.

This PRD makes Jev the default engine for those bounded decisions. Jev receives
a compact dossier and a fixed set of allowed answers. If Jev is unavailable,
returns an invalid answer, or is not confident enough for that workload, the
same decision is sent through the currently configured Hermes path. The rest of
the pipeline does not need to know which provider answered.

Hermes is not being replaced. Hermes remains responsible for work that needs
open-ended reasoning or generation: browsing, research, synthesis, new Entity
descriptions, memory prose, editor drafts, publisher copy, and X posts.

The intended result is:

- faster movement between pipeline stages;
- less token and compute use for simple decisions;
- more consistent classification contracts across sources;
- Hermes capacity reserved for the work that actually needs it; and
- no loss of service when Jev or TypeSafe is unavailable.

Jev never writes to a database, creates an Entity, merges an Entity, publishes
content, or skips work by itself. Code-owned validation and policy remain the
authority for every side effect.

## CEO-Level Mental Model

Think of Jev as the sorting desk between departments.

Today, many packages are carried to a senior analyst just to decide which tray
they belong in. Under this design, Jev reads the label and sorts the package
quickly. Hermes is still the senior analyst: it investigates difficult cases,
writes the report, and handles anything the sorting desk cannot safely decide.

If the sorting desk closes, packages automatically go to the senior analyst.
The conveyor belt slows down but does not stop and does not change its safety
rules.

## Problem

MyBoon already has a shared structured-inference gateway, but classification is
not yet a first-class cross-application capability:

- the gateway's `classify` mode uses the same prompt-shaped adapter contract as
  structured generation;
- the configured adapter is currently Hermes-backed;
- several modules call Hermes directly for bounded judgments;
- some mixed prompts combine classification, Entity selection, and prose
  generation in one expensive call;
- fallback and confidence behavior are not defined per classification family;
- classification output probabilities are not available through one common
  contract; and
- there is no central registry showing where model judgment is allowed and
  where deterministic code must remain authoritative.

This creates avoidable latency, inconsistent behavior, and excess use of a
general-purpose model for narrow decisions.

## Evidence From the Scoped Experiment

A local, read-only Entity-identity shadow test compared Jev with the configured
Hermes/GLM route on four reviewed boundary cases:

| Measure | Jev | Hermes/GLM |
|---|---:|---:|
| Expected outcomes | 4 / 4 | 3 / 4 |
| Total wall time | 1.864 s | 85.533 s |
| Measured input tokens | 4,978 | not compared on the same API basis |
| Estimated Jev input cost | $0.000209076 | not compared |

The important case was `Solana` the network versus `SOL` the asset. Jev kept
them separate; the Hermes/GLM route incorrectly classified the legitimate
network alias as polluted. Both routes handled the known GPT-5.6 alias
pollution and duplicate SEC examples correctly.

This experiment supports further implementation and evaluation. Four cases are
not production certification and must not be used to set global confidence
thresholds.

## Goals

1. Make Jev the default provider for every suitable bounded classification
   workload in the complete signal-to-knowledge application.
2. Fall back automatically to the existing configured Hermes route without
   requiring source workers to implement provider logic.
3. Keep deterministic rules, schema validation, evidence grounding, and
   mutation policy in application code.
4. Split classification from generation where one prompt currently mixes the
   two.
5. Send compact, task-specific dossiers rather than complete articles,
   research pages, memory bodies, or catalogues.
6. Record provider-native answer evidence, model, fallback reason, latency, and
   usage for every inference attempt, then link it to the consumer-owned final
   policy outcome by `decisionId`.
7. Roll out by workload in shadow mode before allowing Jev results to affect
   live routing.
8. Preserve current behavior through a global kill switch and per-workload
   route controls.

## Non-Goals

This PRD does not authorize Jev to:

- replace Hermes chat, research, or tool use;
- browse the web or retrieve sources;
- write summaries, memory bodies, editor drafts, or social posts;
- invent new Entity names, aliases, descriptions, or relationships;
- bypass Entity grounding or admission checks;
- directly merge, archive, quarantine, delete, or create database records;
- replace deterministic deduplication, arithmetic, rate limits, leases, or
  queue policy;
- become a public/mobile API dependency; or
- activate every proposed workload in one release.

## Product Principle: Classify First, Generate Only When Needed

Every AI-assisted operation must first be assigned to one of three modes:

| Mode | Owner | Examples |
|---|---|---|
| Deterministic | Application code | exact duplicate, numeric threshold, URL normalization, schema validation, queue capacity |
| Bounded classification | Jev first, Hermes fallback | relevant/not relevant, existing candidate choice, same/different Entity, keep/update/drop |
| Open-ended work | Hermes | external research, synthesis, new Entity proposal, summaries, drafts, post text |

We must not add a model call where code already has a reliable answer. Jev is
used only when a real semantic judgment remains after deterministic checks.

## Target Architecture

```text
Pipeline stage
    |
    | compact, versioned classification request
    v
Classification Gateway
    |
    +-- deterministic request validation
    +-- workload registry and policy lookup
    +-- timeout / concurrency / rate-limit / circuit checks
    |
    v
Jev provider adapter (default)
    |
    +-- valid and accepted by registry policy -> normalized result
    |
    +-- unavailable / invalid / any answer not accepted
                                              |
                                              v
                                  Hermes classifier adapter
                                              |
                                   valid ----> normalized result
                                              |
                                   failed ---> existing retry,
                                                defer, fail-open,
                                                or review policy
    |
    v
Code-owned validator and decision policy
    |
    v
Queue transition or side effect
```

There is one shared provider boundary. Scout, Research, Entity Manager,
maintenance, Editor, Publisher, X Desk, and source-specific workers must not
instantiate a TypeSafe client directly.

## No-Code Pseudocode

```text
WHEN a pipeline stage needs a judgment:

  1. Let code handle facts it can prove.
     Example: exact URL duplicate, expired deadline, numeric market move.

  2. Ask: "Is the remaining question a fixed-choice decision?"

     NO  -> send the task to Hermes for research or generation.

     YES -> build a small dossier and ask Jev.

  3. Check Jev's answer.

    IF Jev is healthy and every required answer satisfies the registered
    primitive-specific acceptance policy:
       use the answer.

     OTHERWISE:
       ask the currently configured Hermes classifier the same question.

  4. Validate the selected answer in code.

  5. Only code moves the item to the next queue or performs a write.

  6. Record who answered, why fallback happened, and what code finally did.
```

### Example: the SEC tokenized-stock signal

```text
Scout receives:
  "SEC approves temporary, conditional exemption for limited onchain trading
   of tokenized stocks."

Code:
  normalizes the URL and checks exact duplicates.

Jev:
  classifies it as regulatory, material, and research-worthy.

Hermes Research:
  reads the SEC material and produces an evidence-backed Research Packet.

Code:
  retrieves a grounded Entity shortlist such as SEC and tokenized securities.

Jev:
  chooses SEC as the primary subject from that shortlist and classifies the
  memory as keep, update, or drop against recent SEC memories.

Hermes:
  writes any required neutral summary/prose, or handles a new-Entity proposal
  if the fixed shortlist was insufficient.

Code:
  re-checks evidence, Entity identity, memory overlap, and write policy before
  saving anything.

If Jev is down at either decision:
  the same compact decision goes to the configured Hermes classifier.
```

## Shared Classification Contract

The existing `InferenceGateway` remains the public application boundary, but
`classify` must gain a native classification request instead of forcing every
provider through one free-form prompt.

The caller supplies only workload identity, version, state, trace identity, and
an optional tighter deadline:

```text
ClassificationRequest
  workload                 stable registered workload ID
  decisionVersion          exact registered decision-contract version
  state                    compact, allowlisted dossier
  trace
    stableDecisionKey      durable item identity used for shadow/canary sampling
    correlationIds         allowlisted signal/work/packet IDs; never secrets
  tighterDeadlineMs?       may reduce, never expand, the registry maximum
```

The caller cannot supply questions, answer schemas, thresholds, provider
routes, retry behavior, or maximum budgets. The registry resolves all of them
from `(workload, decisionVersion)`. An unknown or retired version fails before
any provider call; the gateway never silently substitutes a newer definition.

The registry constructs a fresh field-by-field projection of `state` against
its exact schema before provider selection. Unknown root and nested fields are
discarded; malformed values or relevant arrays beyond their registered bounds
are rejected before persistence or transmission. The projected value, not the
caller's object, is cloned, hashed, saved to the outbox, and sent to either
provider. A state that violates the registered caller contract is a
non-retryable caller error, not a reason to send uncontrolled input to Hermes.

The gateway creates a `decisionId` before the first attempt and returns it on
success or attaches it to a typed double-failure error. Conceptual result:

```text
ClassificationResult
  decisionId               links inference attempts to downstream policy outcome
  workload
  decisionVersion
  decision                  registry-decoded provider-neutral decision value
  answers                   typed provider answers; see primitive contract below
  configuredPrimary        Jev and pinned model version
  configuredFallback       exact resolved Hermes provider/model
  actualProvider           Jev or Hermes
  actualModel              exact model that answered
  fallbackUsed             true/false
  fallbackReason           typed reason
  schemaValid              true/false
  usage                    calls, input/output tokens, measured cost
  duration                 total and per attempt
  attempts                 immutable Jev/Hermes attempt summaries
```

`ClassificationResult` does not contain the downstream policy outcome. The
consumer has not yet validated the Entity IDs, evidence, queue state, or write
policy when the gateway returns.

### V1 coherence rule: all-or-nothing fallback

One request may contain several registered questions, but v1 produces one
coherent provider decision:

- every v1 question is required;
- Jev must return every answer with the exact registered type;
- every Jev answer must satisfy its registered acceptance rule;
- if any answer is unavailable, invalid, wrong-model, or not accepted, the
  complete Jev result is excluded from decision composition;
- Hermes then receives the complete state and complete registered decision
  definition; and
- answers from Jev and Hermes are never mixed in one result.

The final `actualProvider` is therefore unambiguous. Jev attempt details remain
available in `attempts` and audit telemetry when Hermes provides the result.

### Atomic question types

The v1 registry mirrors TypeSafe's actual primitive contract:

| Registry type | Jev mapping | Jev answer retained by the gateway |
|---|---|---|
| `choice` | TypeSafe Choice | selected option, full option probabilities, distribution-derived confidence |
| `noul` | TypeSafe Noul | yes probability only; no confidence field exists |
| `score` | TypeSafe Score | continuous score, legend/levels, level probabilities, distribution-derived confidence |
| `multi_label` | no native primitive | expanded by the registry into one Noul per label; deterministic code applies thresholds and cardinality |

Each question owns its instructions, allowed answers, criteria, boundary
examples, and output mapping. Questions are versioned in source control.

There is no synthetic normalized confidence across primitive types. Noul
acceptance uses registered probability rules. Choice and Score may use their
provider-returned confidence and full distributions. A Hermes fallback returns
the same provider-neutral decision labels but its self-reported confidence is
discarded and must never be compared with Jev's distribution-derived
confidence. Provider-native uncertainty evidence is optional and explicitly
tagged by provider/type in audit records.

The provider-neutral `decision` is distinct from provider-native `answers`:

```text
Jev Choice evidence  -> registry decoder -> registered decision label
Jev Score evidence   -> registry decoder -> registered decision value/label
Jev Noul probability -> registry rule    -> registered boolean/label
Hermes strict JSON   -> registry validator -> the same registered decision
```

Hermes is never asked to imitate Jev probabilities or confidence. For a Score
workload, the registry defines the downstream decision derived from the score;
Hermes returns that decision directly rather than fabricating a distribution.

For a multi-label decision, the registry owns the label set, Noul questions,
probability rule, deterministic ordering, and maximum cardinality. Callers do
not send labels or trim the result themselves.

Jev maps these definitions to native System One questions. Hermes receives a
strict JSON rendering generated from the same registered instructions,
criteria, labels, and output decoder. This means “same decision definition,”
not an assertion that the two providers expose equivalent uncertainty metrics.

### Adapter composition

The current gateway uses one structured adapter for all configured targets.
Implementation must introduce a provider adapter registry:

```text
typesafe / Jev target -> JevClassificationAdapter
Hermes-managed target -> HermesClassificationAdapter
generation target     -> existing HermesStructuredAdapter
investigation target  -> existing contained investigation port
```

`generateStructured`, `repairStructured`, and `investigate` remain unchanged.
Jev is valid only for `classify` mode. Configuration that routes generation or
investigation to Jev must fail at startup.

Classification uses a dedicated executor rather than the current generic
structured-output repair loop. `repairStructured` is forbidden for Jev and for
the Hermes classification fallback in v1. Invalid Jev output goes directly to
Hermes; invalid Hermes output reaches the workload's double-failure policy.

## Workload Registry

Every classification must be registered centrally. A workload definition
contains:

- stable workload ID;
- owner module;
- exact decision version and maximum authorized lifecycle mode;
- input schema, allowlist, projection rules, and maximum size;
- complete Choice/Noul/Score definitions and criteria;
- answer decoder and provider-neutral decision schema;
- Jev acceptance rules per required answer and label;
- deterministic multi-label composition/cardinality rules where applicable;
- Jev model version;
- Hermes fallback route;
- maximum deadline, request, input, output, and cost budgets;
- deployment-wide concurrency, rate, and circuit policy;
- typed fallback reasons and double-failure policy;
- stable shadow/canary sampling policy;
- whether the result may affect live routing;
- whether human review is required; and
- dashboard and evaluation dataset names.

Callers select only a registered workload/version and may optionally tighten
the deadline. They cannot choose arbitrary models, questions, schemas,
criteria, thresholds, retries, maximum budgets, or failure policy at runtime.

Conceptually, source-controlled registration owns:

```text
ClassificationDefinition
  workload
  decisionVersion
  maximumLifecycleMode
  validateState(state)
  questionDefinitions
  decodeJev(typedAnswers)
  acceptJev(typedAnswers, decodedDecision)
  renderHermes(state)
  validateHermes(value)
  decisionSchema
  primaryRoute / fallbackRoute
  maximumBudget / capacityPolicy
  doubleFailurePolicy
  stableSamplingPolicy
```

These functions are reviewed code associated with the exact decision version,
not data supplied by a request or generated by a model.

### Initial workload IDs

These IDs are the proposed implementation registry. They intentionally do not
repurpose current generative routes such as `research.synthesis`,
`entity.extract`, or `editor.draft`.

| Workload ID | Rollout designation | Safety direction on double failure |
|---|---|---|
| `research.novelty` | first active canary after shadow gates | fail open and research |
| `entity.catalog_identity` | reference shadow only; no automatic mutation | review; no mutation |
| `triage.classify` | registry definition only; activation requires reviewed triage evidence | rules-only/defer; never silently archive |
| `research.evidence_relevance` | target inventory; separate activation review | retain uncertain candidate or defer |
| `research.claim_support` | target inventory; separate activation review | mark unresolved; never promote to verified |
| `entity.subject` | child Entity Manager PRD required | retry/review; no Entity write |
| `entity.memory_action` | child Entity Manager PRD required | retry/review; no memory write |
| `editor.action` | child Editor PRD required | hold |
| `publisher.eligibility` | child Publisher PRD required | hold |
| `x_desk.action` | child X Desk/Editor PRD required | skip/hold for review |
| `calendar.event_class` | future source PRD required | omit semantic tag or defer |
| `research.deep_escalation` | separate deep-research activation review | remain standard/defer per capacity policy |

Source-specific variants use input fields and policy versions, not private
workload names, unless their label set or safety direction is genuinely
different.

## Complete Application Decision Map

The following map is the target inventory. “Jev role” means Jev is the default
classifier after deterministic code. It does not mean a new model call is
required for every item.

| Area | Decision | Jev role | Hermes role | Automatic action |
|---|---|---|---|---|
| Scout / source intake | semantic relevance, source/event category, materiality tags | default classifier when rules are ambiguous | fallback classifier | may route/defer; never delete source data |
| Triage | archive/defer/light/standard/deep suggestion and priority adjustment | default only for ambiguous rule outcomes | fallback classifier | deterministic capacity/policy owns final outcome |
| Research gate | already known / new information / contradiction | default | fallback classifier | only `already_known` may skip research; failure remains fail-open |
| Research retrieval | passage/evidence relevance and claim support/contradiction | default for bounded candidate batches | fallback classifier | filters bounded candidates; cannot invent evidence |
| Research execution | browsing, reading, fact synthesis, open questions | none | Hermes research/investigation | existing evidence rules |
| Research Packet | outcome labels, evidence quality bands, completeness gates | default where outputs are closed-set | fallback classifier | schema/evidence validators own acceptance |
| Entity shortlist | candidate relevance and primary-subject choice among grounded IDs | default | fallback classifier | cannot select outside code-supplied grounded IDs |
| New Entity path | whether the shortlist is insufficient | default advisory classification | Hermes proposes name/type/aliases/summary | existing grounding/admission owns creation |
| Memory reconciliation | keep/update/drop; new event/material update/duplicate source | default | fallback classifier | exact memory IDs and claim overlap validated in code |
| Entity maintenance | same Entity/different Entities/unsure/polluted alias | default | fallback classifier | existing decision policy and SQL guardrails own mutation |
| Editor | publish/hold/drop, content type, duplicate angle, reason codes | default classification portion | fallback; Hermes still creates draft prose | existing editor policy owns state transition |
| Publisher | final eligibility/policy checks | default only for semantic closed-set checks | fallback classifier | deterministic required fields and idempotency remain authoritative |
| X Desk | relevant/no-post, candidate type, risk flags, duplication | default classification portion | fallback; Hermes writes post text | review-only behavior unchanged unless separately approved |
| Polymarket | event category, materiality, same market event | default when arithmetic/rules cannot decide | fallback classifier | prices, deltas, thresholds, and leases stay deterministic |
| Market calendar | event type, expected impact band, Entity relevance | default when added to shared spine | fallback classifier | calendar timing and source authority stay deterministic |
| Deep research | escalation reason and completion classification | default before/after execution | fallback classifier; Hermes performs investigation | Jev never receives tools or controls them |
| API / mobile UI | presentation and retrieval | none by default | none | no request-time vendor dependency |

### Decisions that must stay deterministic

- canonical URL and source-item identity;
- exact duplicate keys;
- timestamps and freshness arithmetic;
- numeric market deltas;
- queue capacity and priority reservations;
- retry counters, leases, and circuit state;
- schema and enum validation;
- canonical Entity lookup and redirect resolution;
- evidence ID, claim ID, and Entity ID membership;
- memory identity and idempotency;
- database authorization, transactions, and constraints; and
- publication idempotency and delivery status.

## Module-Specific Design

### Current code migration seams

The implementation starts from these existing boundaries:

| Current seam | Required change |
|---|---|
| `signal-platform/triage-engine.ts` already accepts `CheapToollessTriageClassifier` | provide a gateway-backed implementation; preserve rules-first policy |
| `research-gate/gate.ts` calls Hermes directly | route its three-label decision through `research.novelty` |
| `research-engine` performs open-ended browsing | keep it on Hermes; add only separate bounded checks where justified |
| `entity-manager/canonical-planner.ts` jointly selects an Entity, reconciles memory, and writes prose | split bounded subject/action decisions from generative fields behind the same processor output contract |
| `entity-maintenance/hermes-judge.ts` and the scoped Jev experiment use provider-specific judges | replace production composition with `entity.catalog_identity` through the shared gateway |
| `editor-draft/hermes-editor.ts` uses structured generation | retain generation; optionally precede it with `editor.action` after shadow proof |
| `x-desk/provider.ts` uses the Editor generation route | separate recommendation classification from post-text generation and give each its own workload |
| legacy Polymarket researcher/editor/publisher code calls Hermes directly | migrate bounded decisions to shared workloads; leave research/prose on Hermes until the legacy lane is retired |

Provider migration must not change queue ownership, persistence identities, or
the module's existing failure direction in the same release.

### 1. Scout and Source Intake

Run cheap deterministic parsing first. Only ambiguous semantic facts go to the
classifier. For news, the dossier should normally contain title, visible
summary, provider, timestamp, source hints, and bounded metadata—not the full
article. Polymarket dossiers should contain market title, candidate type,
bounded current/prior values, and source hints.

Outputs may add allowlisted materiality/category labels. They must not alter
source provenance or manufacture Entity hints.

### 2. Triage

The existing rules-first design remains authoritative. Jev implements the
existing cheap, tool-less classifier port for ambiguous cases. It suggests an
outcome and bounded priority adjustment; capacity, provider health, supported
depths, deadlines, and P0 reservations are still applied afterward in code.

Jev failure must not silently archive a signal. The fallback is Hermes; if both
fail, the existing conservative defer or rules-only behavior applies.

### 3. Research Gate and Evidence Checks

The existing research novelty gate is an ideal first production workload
because it already has three labels and a safe failure policy. Jev compares the
new signal with a bounded recent timeline and returns:

```text
already_known | new_information | contradicts_prior
```

Only a valid `already_known` decision whose required answers satisfy the
registered Jev acceptance rules may suppress research. Any Jev answer that is
not accepted, plus provider failure or invalid output, sends the complete
decision to Hermes. If Hermes also fails, research proceeds.

Evidence relevance and claim support may later use Jev in batches, but the
classifier only judges supplied snippets and evidence references. It does not
browse and does not turn an unsupported claim into verified evidence.

### 4. Research and Synthesis

External research remains Hermes/contained-agent work. Structured synthesis
remains Hermes because it creates claims, evidence links, summaries, and an
integrated Research Packet.

Jev may classify inputs before research and validate closed-set properties
after synthesis. It does not replace the synthesizer.

### 5. Entity Manager

The current canonical plan mixes several tasks. It should be decomposed behind
the existing processor contract:

```text
Grounded shortlist produced by code
  -> Jev: existing Entity / no relevant subject / new Entity needed
  -> Jev: keep / update / drop memory
  -> code validates candidate, claim, evidence, and recent-memory IDs
  -> Hermes only when prose or a new Entity proposal is required
  -> existing canonical admission and persistence
```

During shadow evaluation, the current Hermes canonical planner may remain the
authoritative baseline whose outcome is compared with the proposed split path.
It is not a valid fallback after the split classification path becomes active
because it combines a different decision contract with prose generation.

Before active Entity Manager use, a child PRD must define two registry-owned
classification contracts and a separate generation contract. Jev and the
Hermes classifier fallback must receive the same split subject and memory-action
definitions. Hermes generation runs only after classification succeeds and
cannot revise the selected Entity or memory action. The current mixed planner
may be removed from authority only after shadow parity, canonical invariants,
and rollback gates pass.

Jev must never see the complete Entity catalogue. Code performs lookup and
sends only a grounded shortlist, bounded Entity hints, compact claims/evidence,
and recent memory titles/summaries required for reconciliation.

No provider answer can:

- add a candidate ID not supplied by code;
- convert an alias into canonical authority;
- create an Entity without the existing grounding checks;
- retain a memory without selected-Entity claim overlap;
- update a memory ID outside the supplied recent set; or
- bypass source-item memory identity.

### 6. Entity Catalogue Maintenance

The existing scoped Jev adapter becomes the first reference shadow workload for
the shared contract. It is not the first automatic mutation workload. The
maintenance service continues to discover candidate pairs deterministically
and sends compact profiles only.

The decision remains:

```text
same_entity | different_entities | unsure | polluted_alias
```

The maintenance Choice returns the decision distribution and Choice
confidence. If it selects
`polluted_alias`, a second bounded answer must identify an exact stored alias;
otherwise the result normalizes to `unsure`.

Existing decision policy, draft-reference checks, redirect safety, transaction
guards, and rollback rules remain mandatory. Jev or Hermes judgment alone is
never a merge instruction.

### 7. Editor, Publisher, and X Desk

Mixed generation prompts should be split only where the separation is clear:

1. Jev classifies eligibility, action, content type, duplication, and reason
   codes from a bounded dossier.
2. Code validates the decision and selects records.
3. Hermes writes user-facing prose for accepted items.

Do not send the full Entity timeline to Jev when recent titles, summaries, and
stable IDs answer the decision. X Desk remains review-only unless a separate
product decision authorizes automatic posting.

Legacy Polymarket editor/publisher paths should migrate through the same shared
workloads or be retired; they must not receive a private Jev integration.

Editor, Publisher, X Desk, and Entity Manager decomposition are separate child
PRDs. This document supplies their shared classifier contract and target
inventory but does not authorize their live behavior changes.

## Compact Dossier Rules

Each workload must define an explicit projection. Default ceilings are policy,
not suggestions:

- no raw credentials, headers, cookies, or internal prompts;
- no full database row dumps;
- no arbitrary metadata objects;
- no complete article when title, summary, and claim snippets suffice;
- no complete memory body when title, summary, type, date, and evidence IDs
  suffice;
- no full Entity catalogue; use code-selected candidates;
- no more candidates than the workload contract permits;
- preserve stable IDs so code can validate the answer; and
- treat every source string as untrusted data, never as instructions.

Payload size and candidate count must be measured per workload. Exceeding a
registry contract ceiling is a typed caller error before any provider call. A
request that satisfies the registry but exceeds a Jev-specific provider limit
routes in full to Hermes. Callers may not truncate identity-bearing fields
silently.

## Confidence and Decision Policy

There is no single global confidence threshold.

Jev acceptance is calibrated independently for each workload, decision
version, pinned model version, primitive, answer label/level, and consequence.
A threshold suitable for tagging a story is not suitable for merging Entities
or suppressing research.

Each required Jev answer has one binary gateway outcome:

```text
accepted       -> eligible to compose the complete Jev decision
not_accepted   -> discard Jev for decision authority and run full Hermes fallback
```

There is no v1 “reject band” that bypasses Hermes. A valid but uncertain Jev
answer is `not_accepted`, just like a missing or invalid answer.

Acceptance uses the primitive's real fields:

- Choice: selected option, option probabilities, and Choice confidence;
- Score: continuous score, level probabilities, and Score confidence;
- Noul: yes probability only; and
- multi-label: per-label Noul probabilities plus the registry's deterministic
  threshold/order/cardinality function.

Rules may be label-specific—for example, a high bar for `same_entity` and a
safe automatic acceptance of an explicit `unsure`. No code computes a fake
confidence for Noul, and no Hermes self-reported number is evaluated as Jev
confidence.

Thresholds are derived from reviewed shadow data and pinned to the exact Jev
model version. They are not copied from the four-case experiment and are not
changed automatically when a vendor alias moves.

## Fallback Semantics

The fallback is the exact Hermes classification route resolved from the
registry for that workload/version. No module hardcodes a Hermes model.

V1 has one state machine:

```text
validate request against registry
  -> invalid caller request: typed caller error; no provider call
  -> valid request:
       call Jev once
         -> complete, exact-model, valid, every answer accepted: return Jev result
         -> unavailable / timeout / rate limited / authentication rejected /
            circuit open / wrong model / malformed / incomplete /
            answer not accepted / Jev-specific eligibility exceeded:
              call Hermes once with the complete registered decision
                -> valid complete decision: return Hermes result
                -> unavailable / timeout / invalid / incomplete:
                     emit typed double failure
                     consumer applies registered workload failure policy
```

Fallback is one logical decision with one `decisionId`, not a second queue
item. Jev and Hermes answers are never combined. Attempt telemetry records both
calls and the exact fallback reason.

The dedicated classification executor sets `maxRepairCalls=0`. It must not use
the current generic `repairStructured` path. Invalid Jev classification goes
directly to Hermes, and invalid Hermes classification becomes a double failure.

If the TypeSafe SDK is used, v1 explicitly sets `retry.maxRetries=0`, passes the
gateway's `AbortSignal`, and sets a per-attempt timeout no larger than Jev's
reserved slice of the logical deadline. The SDK's default two retries and
per-attempt-only timeout are forbidden because they could consume the time
reserved for Hermes without the gateway observing each attempt. `Retry-After`
is recorded for circuit/backpressure decisions; it does not sleep inside the
live logical request.

If Hermes also fails, the workload's existing safety direction applies:

| Workload consequence | Double-failure behavior |
|---|---|
| Could incorrectly discard new knowledge | fail open or defer; do not drop |
| Could create/merge/quarantine an Entity | fail closed and retry/review |
| Could publish or post content | hold; do not publish |
| Pure advisory tag | omit the tag and continue if contract permits |

The system must never invent a default label merely to keep the queue moving.

## Configuration

Configuration is workload-based and read at process startup.

Implemented environment contract:

```text
JEV_API_TOKEN=<secret>
CLASSIFICATION_LIFECYCLE_JSON={"research.novelty":"disabled|shadow|canary"}
CLASSIFICATION_SQLITE_PATH=.data/classification.sqlite
INFERENCE_GATEWAY_PRIMARY_PROVIDER=ollama-cloud
INFERENCE_GATEWAY_PRIMARY_MODEL=glm-5.3-flash
RESEARCH_GATE_CLASSIFICATION_DISABLED=0|1
```

`RESEARCH_GATE_CLASSIFICATION_DISABLED=1` is the composition-level emergency
rollback for the first canary: the classification runtime is not constructed
and Research Gate uses its previous `buildGatePrompt`/`ignoreRules` Hermes path.
This is separate from `RESEARCH_GATE_DISABLED=1`, which disables novelty gating
entirely. The selected Hermes provider/model is resolved during composition and
recorded as an exact target in telemetry.

Deployment configuration may disable a workload, select a lifecycle mode no
more permissive than the registry's `maximumLifecycleMode`, reduce rollout
percentage, or tighten budgets. It cannot enable an unauthorized mode, change
questions/decoders, expand a maximum budget, or select a provider/model outside
the registry's approved route set. Invalid expansion fails startup.

Lifecycle authority is ordered `disabled < shadow < canary < active`.

Required controls:

- global Jev kill switch;
- per-workload `disabled | shadow | canary | active` mode;
- per-workload rollout percentage using the registered stable sampling key;
- force-Hermes override;
- pinned Jev model version;
- timeout, concurrency, rate, and budget ceilings; and
- circuit-breaker reset/probe controls.

The token is server-side only, excluded from logs and artifacts, and never
included in PM2 status output, API responses, prompts, or telemetry.

## Model Version Policy

Production uses a versioned model ID such as `jev-1.13.0`, not `jev-latest`.
TypeSafe documents that aliases can move and recommends pinning when acceptance
rules are tuned to a version.

A model upgrade requires:

1. shadow evaluation under the new version;
2. threshold recalibration;
3. reviewed boundary regressions;
4. a versioned workload-policy change; and
5. a controlled rollout with rollback to the previous model.

The exact model returned by the provider is checked and logged.

## Shadow Execution Contract

Shadow mode never places Jev in the live critical path:

```text
live item
  -> registry validates and creates decisionId
  -> Hermes remains authoritative
  -> consumer continues from the Hermes result

independent shadow lane
  -> reads an immutable compact decision snapshot
  -> calls Jev best-effort with no Hermes fallback
  -> records Jev result/failure under the same decisionId
  -> joins disagreement metrics after both records exist
```

Authority and isolation rules:

- Hermes is the only authoritative classifier in shadow mode.
- Jev output cannot alter the live result, queue state, attempt count, retry
  schedule, latency, or failure status.
- The live worker never awaits a Jev network call.
- The live worker uses a dedicated SQLite handoff connection with
  `busy_timeout=0`; lock contention fails immediately, emits a bounded warning,
  and cannot inherit the control plane's five-second writer wait.
- A bounded local outbox stores only the registry-validated compact state,
  decision version, input digest, trace identifiers, and `decisionId`.
- Outbox insertion failure emits an observability error but does not fail the
  live item; the authoritative Hermes path still proceeds.
- A separate shadow worker owns Jev timeout, retry scheduling, concurrency, and
  retention. Shadow Jev has no Hermes fallback because Hermes already supplied
  the authoritative decision.
- Retryable timeout, `429`, provider-unavailable, and circuit-open failures use
  bounded exponential backoff for at most three recorded attempts. Invalid,
  wrong-model, authentication, or final-attempt failures are terminal.
- Terminal snapshots are age-pruned after seven days and oldest-first pruned
  before admission to keep the outbox below 10,000 rows and 64 MiB. If active
  rows alone fill either bound, the new shadow snapshot is rejected without
  affecting the authoritative result.
- The immutable snapshot is content-addressed; the shadow worker never
  re-reads a mutable Entity, memory, or source row to reconstruct old state.
- Shadow capacity is lower priority than canary/active capacity and cannot
  consume the reserved live provider slots.

Sampling is deterministic:

```text
sample = hash(workload, decisionVersion, trace.stableDecisionKey) mod 10_000
include when sample < configuredBasisPoints
```

The stable key is a durable source item, Research Packet, Entity pair, or other
registry-defined logical identity—not an attempt ID, process ID, timestamp, or
random UUID. Retries and PM2 restarts therefore make the same sampling choice.

The authoritative and shadow attempt records join on `decisionId`; comparisons
also require the same input digest and decision version. A mismatch is an audit
error, not a provider disagreement.

## Reliability and Capacity

- One Jev request may carry several atomic questions over the same compact
  state when they share one decision contract and failure policy.
- Unrelated records are not batched merely to reduce request count.
- The live Jev adapter performs one attempt in v1; provider retry hints update
  shared backpressure/circuit state rather than sleeping in the request.
- The gateway reserves time for Hermes fallback before starting Jev.
- Concurrency and rate limits are enforced deployment-wide per workload and
  per provider/model, not independently inside each PM2 process.
- Provider-global and workload-specific call ceilings are distinct registry
  values and are checked atomically before the same rate event is inserted.
- Jev circuit state is deployment-wide and keyed by exact provider/model.
- Queue admission checks whether either Jev or Hermes can accept the workload.
- If both routes are unavailable, normal retry/defer semantics apply.

The current gateway's in-memory concurrency, rolling-call, and circuit maps are
not sufficient for classification because PM2 stages run as separate
processes. Phase 0 introduces a `ClassificationCapacityCoordinator` interface.
The current single-VPS implementation uses the existing Hermes limiter pattern
for crash-safe cross-process concurrency leases plus a shared transactional
SQLite ledger for provider/workload rate windows and circuit state. It must:

- use atomic leases with PID/token ownership and stale-owner reclamation;
- reserve independent capacity for live and shadow traffic;
- transactionally account provider-global and workload-specific rate windows;
- expose `ready`, `limited`, `circuit_open`, and retry-after state to every
  process;
- serialize half-open probes so one process, not every worker, tests recovery;
- clear/open the same circuit from any PM2 worker; and
- export one deployment-wide readiness snapshot.

Hermes fallback continues to use the cross-process Hermes concurrency limiter.
The classification coordinator accounts the logical fallback route without
replacing that lower-level process limiter. If MyBoon moves to multiple hosts,
the coordinator port must move to a shared external store before scaling; a
host-local filesystem/SQLite implementation is valid only for the current
single-VPS topology.

The current TypeSafe limits and prices are operational inputs, not hardcoded
business logic. Usage records store measured tokens; cost reporting applies the
versioned rate card outside the decision path.

## Observability and Audit

Inference and downstream policy are two linked records with different owners.

```text
classification_attempt                owned by Classification Gateway
  decisionId
  workload / decisionVersion
  executionMode                       authoritative | shadow
  attemptNumber                       1 for live; increasing for shadow retries
  inputDigest
  configured primary/fallback
  ordered provider attempts
  final actual provider/model
  typed provider-native answers
  decoded decision or typed failure
  fallback reason
  schema/model validity
  duration, tokens, measured cost

classification_policy_outcome         owned by consuming module
  decisionId
  consumer / consumerPolicyVersion
  outcome                             accepted | held | deferred | retried |
                                      reviewed | failed | no_action
  bounded reasonCodes
  sideEffectReferences                allowlisted IDs only; may be empty
  recordedAt
```

The gateway persists/emits `classification_attempt` before returning or
throwing. A double-failure error still carries `decisionId`, allowing the
consumer to record its fail-open, hold, defer, retry, or review outcome.

There is one attempt record per
`(decisionId, executionMode, attemptNumber)`. An active/canary authoritative
record has attempt number 1 and may contain the ordered Jev and Hermes calls.
A shadow decision has a Hermes `authoritative` record plus one or more Jev
`shadow` attempt records under the same `decisionId`; they never share
authority or provider answers.

The consuming module records exactly one terminal policy outcome for each
authoritative decision it consumes, idempotent on
`(decisionId, consumer, consumerPolicyVersion)`. Shadow attempts never create a
policy outcome because they have no state authority.

Gateway telemetry does not claim that an Entity was merged, a story was held,
or content was published. Those facts exist only in the linked consumer-owned
outcome record.

Dashboards must show:

- request volume by workload/provider;
- Jev acceptance and Hermes fallback rates;
- fallback reasons;
- Jev non-acceptance distribution by primitive/label/reason;
- p50/p95 latency;
- input tokens and measured/derived cost;
- disagreement rate in shadow mode;
- invalid response rate;
- circuit-open time; and
- downstream retry, defer, drop, merge, hold, and review outcomes.

Dashboards join attempts and policy outcomes by `decisionId`. A missing
consumer outcome after the workload's expected completion window is itself an
operational alert.

No full dossier, article body, memory body, prompt, credential, or customer data
is required in routine telemetry. Reproducible evaluation artifacts use
redacted fixtures and versioned hashes.

## Security and Data Handling

- The adapter calls only the allowlisted TypeSafe API host over TLS.
- The API token is read from the secret environment at startup.
- Request logs redact authorization headers and state bodies.
- Workload projections minimize proprietary and personal data.
- Source text is wrapped as state/data; it cannot alter question definitions.
- Question criteria are application-owned, versioned, and never generated from
  untrusted source text.
- Provider output is untrusted input until schema and membership validation
  complete.
- Jev has no tools, database client, queue client, or mutation capability.
- Data-retention/legal settings must be reviewed before production activation;
  any required enterprise zero-data-retention agreement is an operational
  release gate, not an assumption in code.

## Evaluation Strategy

Every workload progresses through the same evidence ladder:

1. **Unit contract tests** — request projection, primitive mapping, response
   decoding, primitive-specific acceptance rules, and failure mapping.
2. **Golden boundary fixtures** — known confusing cases and unsafe false
   positives.
3. **Offline replay** — reviewed historical items compared with the current
   Hermes result and the actual downstream outcome.
4. **Live shadow** — Jev runs beside the current path but cannot alter state.
5. **Canary** — a stable percentage uses Jev, with automatic Hermes fallback.
6. **Default-on** — only after per-workload release gates pass.

Required metrics are workload-specific:

- classification precision/recall or reviewed agreement by label;
- calibration of Choice/Score distributions and confidence or Noul
  probabilities, without mixing those measures;
- unsafe false-positive count;
- false-drop or false-suppression rate;
- provider disagreement rate;
- fallback rate;
- latency improvement; and
- tokens/cost per completed pipeline item, not merely per API call.

High-consequence fixtures must include at least:

- network versus native asset (`Solana` / `SOL`, `Ethereum` / `ETH`);
- protocol versus token (`Jupiter` / `JUP`);
- brand/product versus legal organization;
- legitimate shorthand versus polluted alias (`SEC`);
- duplicate publisher versus material event update;
- source/venue mention versus primary subject;
- ambiguous/no-evidence Entity subject;
- same article under a new Research Packet ID;
- conflicting evidence; and
- prompt-like instructions embedded in source text.

No workload may use the four-case exploratory result as its complete release
dataset.

## Rollout Plan

### Phase 0 — Shared foundation

- Add the minimal caller request and registry-owned classification contracts.
- Add the provider adapter registry and Jev adapter.
- Add a Hermes renderer/adapter for the same registered questions.
- Add all-or-nothing fallback, primitive-specific acceptance, linked audit
  records, deployment-wide capacity coordination, and controls.
- Add the immutable shadow outbox/worker.
- Register workloads as `disabled`; no live or shadow call is enabled by this
  foundation deployment.

### Phase 1 — Reference shadows

- Move Entity catalogue identity evaluation behind the shared contract as a
  shadow-only reference. It remains non-authoritative and cannot mutate.
- Define `research.novelty`, replay reviewed history, then enable its isolated
  shadow with Hermes authoritative.
- Do not activate ambiguous triage or any additional workload in this phase.

### Phase 2 — First active canary

- Make `research.novelty` the first Jev-authoritative canary after its release
  gates pass.
- Preserve its existing fail-open behavior: Jev non-acceptance uses Hermes;
  double failure proceeds with research.
- Expand the stable canary percentage only from reviewed telemetry and retain
  immediate force-Hermes rollback.

### Phase 3 — Child PRDs

- Write and approve separate PRDs for Entity Manager decomposition, Editor,
  Publisher, X Desk, triage, evidence checks, and other target workloads.
- Each child PRD defines its dossier, decision contract, failure policy,
  evaluation, migration, and rollback while reusing this gateway.
- The legacy mixed Entity planner may serve only as a shadow baseline; active
  fallback must use the split Hermes classifier.

### Phase 4 — Workload-by-workload expansion

- Enable additional Jev workloads only through their child PRDs and release
  gates.
- Tune batching, compact projections, and rate limits.
- Retire duplicate direct-classifier integrations.
- Keep Hermes fallback and kill switches permanently.

## Testing Requirements

### Gateway tests

- Jev success preserves Choice/Score distributions and confidence, Noul
  probability without confidence, exact model, usage, and telemetry.
- Callers cannot inject questions, schemas, routes, thresholds, retries, or
  maximum budgets.
- Unknown decision versions and invalid/oversized registry state fail before a
  provider call.
- Unknown nested caller fields never reach a digest, outbox snapshot, or
  provider; malformed and over-limit dossier fields fail before provider call.
- If any required Jev answer is invalid or not accepted, all Jev answers are
  excluded and the complete decision goes to Hermes.
- Missing token routes directly to Hermes and reports degraded readiness.
- Timeout, `429`, retryable `5xx`, authentication failure, malformed JSON,
  missing answer, wrong model, and circuit-open all exercise fallback.
- Choice/Score non-acceptance and Noul probability non-acceptance exercise
  Hermes fallback.
- Invalid classification output never invokes `repairStructured`.
- The TypeSafe adapter disables SDK retries, passes the abort signal, and stays
  within its reserved deadline slice.
- Jev cannot be selected for generation or investigation.
- The logical wall budget reserves executable time for fallback.
- Provider errors never leak the token or request state.
- Separate PM2 processes observe the same concurrency, rate, and circuit state;
  only one half-open probe executes.

### Contract tests

- Jev and Hermes are generated from the same workload definition.
- Unknown labels, unknown IDs, repeated answers, omitted questions, invalid
  probabilities, and invalid primitive fields fail validation.
- Noul never acquires a synthetic confidence and Hermes self-reported
  confidence is discarded.
- Multi-label decisions expand to registered Nouls and obey deterministic
  threshold, ordering, and cardinality rules.
- A result cannot select a candidate absent from the supplied shortlist.
- Projection ceilings are deterministic and do not silently remove identity
  evidence.

### Pipeline tests

- Scout/triage double-provider failure never silently archives new knowledge.
- Research Gate double-provider failure proceeds with research.
- In Entity Manager shadow mode, the current canonical planner stays
  authoritative and Jev cannot affect writes.
- In a future active Entity Manager route, fallback uses the split Hermes
  classifier; the mixed canonical planner is never called as fallback.
- Entity maintenance judgment cannot mutate without existing decision and SQL
  policies.
- Editor/publisher double-provider failure holds content.
- Replays remain idempotent regardless of which provider answered.
- The consumer records a linked terminal policy outcome for authoritative
  success and double failure; shadow attempts record none.

### Operational tests

- Run with no Jev credential.
- Revoke/replace the credential during a canary.
- Simulate latency, rate limiting, and outage.
- Prove a shadow Jev timeout does not change authoritative latency, result,
  attempts, or retry state.
- Hold the SQLite writer lock and prove live shadow handoff fails immediately
  rather than waiting on the control-plane busy timeout.
- Prove retryable shadow failures back off for a bounded number of independently
  auditable attempts, while non-retryable failures dead-letter immediately.
- Prove age, row, and byte retention bounds prune only terminal shadow rows and
  fail admission when active rows alone consume the bound.
- Prove stable sampling survives retries and PM2 restarts and joins on the same
  snapshot digest/decision version.
- Force Hermes globally and per workload without restart where the existing
  control plane supports it; otherwise document the bounded restart.
- Confirm dashboards distinguish configured, actual, and fallback providers.

## Release Gates

A workload may move from shadow to active only when all are true:

- its owner has approved the versioned question definition and compact input;
- the labeled evaluation includes normal and adversarial boundary cases;
- no unsafe automatic action occurs in the critical boundary suite;
- false-drop/suppression behavior is no worse than the approved baseline;
- primitive-specific acceptance rules are calibrated for the pinned model and
  decision labels/levels;
- Jev outage and answer non-acceptance fallback to Hermes are demonstrated;
- double-failure behavior matches the documented safety direction;
- shadow execution is latency/failure isolated and uses immutable snapshots;
- deployment-wide limits and circuit recovery are rehearsed across PM2
  processes;
- gateway attempt records join to consumer policy outcomes by `decisionId`;
- telemetry is complete and contains no secret/full-content leakage;
- the workload kill switch is rehearsed; and
- the existing module-specific release gates still pass.

Global default-on additionally requires a multi-workload production soak that
shows queue throughput, latency, fallback rate, and completed-item cost. PM2
`online` status alone is not evidence of readiness.

## Acceptance Criteria

Implementation of this PRD is complete when:

1. The caller contract contains only workload, decision version, state, trace,
   and an optional tighter deadline; the registry owns every other decision
   concern.
2. No production module constructs a TypeSafe client directly.
3. The registry natively represents Choice, Score, Noul, and multi-label as
   composed Nouls without synthetic uncertainty fields.
4. V1 fallback is all-or-nothing, never uses structured repair, and uses one
   registered split definition for Jev and Hermes.
5. Missing, unhealthy, invalid, wrong-model, or not-accepted Jev results
   demonstrably send the complete decision to Hermes.
6. Gateway-owned attempt records and consumer-owned policy outcomes join by
   `decisionId` without assigning downstream authority to the gateway.
7. Shadow Jev runs outside the live critical path from immutable, stably
   sampled snapshots with Hermes authoritative.
8. Classification concurrency, rate, and circuit state are deployment-wide
   across current PM2 processes.
9. Jev cannot perform or directly authorize side effects; existing module
   guardrails remain in code.
10. All workload definitions ship disabled, Entity catalogue identity proves
   the reference shadow path, and `research.novelty` is designated as the first
   candidate for a separately approved active canary after its release gates
   pass.

## Implementation Work Packages

The implementation should be split into reviewable changes:

1. **Classification contracts and registry**
   - minimal caller request;
   - native Choice/Score/Noul definitions and deterministic composition;
   - versioned schemas, decoders, Jev acceptance, budgets, and failure policy.
2. **Gateway and provider adapters**
   - TypeSafe/Jev client;
   - Hermes fallback renderer;
   - adapter registry;
   - all-or-nothing executor with no repair/retry ambiguity;
   - linked attempt telemetry and readiness.
3. **Shadow/evaluation framework**
   - immutable local outbox and isolated shadow worker;
   - stable sampling and authoritative-result join;
   - reviewed fixtures;
   - replay command;
   - comparison artifacts and metrics.
4. **Deployment-wide capacity**
   - cross-process concurrency leases;
   - shared rate/circuit ledger and half-open probe;
   - separate live/shadow reservations.
5. **Reference workloads**
   - Entity catalogue identity shadow only;
   - Research Gate shadow, then first active canary.
6. **Production rollout**
   - `research.novelty` canary;
   - outage rehearsal;
   - soak and default-on decisions.
7. **Child PRDs, not authorized implementation in this document**
   - Entity Manager decomposition;
   - Editor, Publisher, and X Desk split;
   - triage, evidence, calendar, deep-research, and legacy Polymarket migration.

Each work package must preserve a working Hermes-only path. No package is
allowed to depend on a later phase for safe fallback.

## Decisions Locked by This PRD

- Jev is a classifier, not the new Hermes.
- Classification is a shared inference-gateway capability, not an
  Entity-Manager-specific integration.
- Jev is primary and Hermes is fallback for approved bounded workloads.
- The registry, not the caller, owns the complete versioned decision contract.
- The same versioned decision definition drives both providers, and provider
  answers are never mixed.
- V1 uses all-or-nothing fallback and no classification repair calls.
- TypeSafe SDK retries are disabled; the gateway owns the logical deadline.
- Jev uncertainty remains primitive-native; Noul has no confidence and Hermes
  confidence is not treated as equivalent.
- The exact Jev model is pinned in production.
- Jev acceptance policy is per workload, primitive, and label/level.
- Compact dossiers are mandatory.
- Code owns validation, policy, state transitions, and mutations.
- Gateway attempts and consumer policy outcomes are separate linked records.
- Shadow Jev is asynchronous, immutable-snapshot-based, and non-authoritative.
- Classification capacity/circuit state is deployment-wide on the current VPS.
- Rollout is workload-by-workload through shadow and canary stages.
- `research.novelty` is the first active canary; Entity maintenance is a
  reference shadow, not the first automatic mutation path.
- Entity Manager, Editor, Publisher, and X Desk activation require child PRDs.
- The Hermes-only operating path remains permanent.

## Phase 0 Decisions and Remaining Rollout Inputs

Phase 0 resolved the implementation choices that affect the shared contract:

1. V1 uses a small direct HTTP adapter, so there is exactly one Jev request,
   the gateway AbortSignal reaches `fetch`, and no SDK retry policy can create
   hidden attempts.
2. The current single-VPS deployment uses `.data/classification.sqlite` for
   linked attempts/outcomes, shared leases/rate/circuit state, and the shadow
   outbox. Live outbox admission uses a separate zero-wait connection; the
   worker owns bounded retry and terminal retention. A multi-host deployment
   must replace this coordinator first.
3. Provisional acceptance thresholds live in each versioned definition and
   remain rollout gates, not globally shared confidence values.
4. The Hermes fallback target is resolved from the existing inference-gateway
   route environment and must match a source-controlled approved allowlist.
5. Production TypeSafe retention/contract review and the historical evaluation
   sample sizes remain release inputs before any canary is enabled.

None of these open details changes the core route:

```text
bounded decision -> registry -> Jev -> whole-decision acceptance -> complete
Hermes fallback when needed -> consumer validation/policy -> side effect
```
