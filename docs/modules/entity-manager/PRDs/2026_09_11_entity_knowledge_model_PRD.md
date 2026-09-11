# Entity Knowledge Model V1 PRD

Status: scoped admission integration approved; production knowledge persistence remains proposed
Created: 2026-09-11
Owner: myboon product / Entity Manager
Module: entity-manager
Branch: `codex/entity-knowledge-model-prd`
Implementation authorization: reviewed read-only admission context and scoped tests only

Related:

- [`FEED.md`](../../../FEED.md)
- [`FEED_SOURCE_BLUEPRINT.md`](../../../FEED_SOURCE_BLUEPRINT.md)
- [`2026_08_26_feed_v3_signal_to_knowledge_platform_PRD.md`](2026_08_26_feed_v3_signal_to_knowledge_platform_PRD.md)

## Document Scope

This PRD explores how myboon should move from entity timelines with loose
labels toward a small, trustworthy entity knowledge model.

It defines the product problem, canonical terms, entity-boundary examples,
proposed knowledge contracts, consumer behavior, migration principles,
guardrails, evaluation, and open decisions.

The 2026-09-11 scoped implementation authorizes only:

- a versioned, bounded, read-only entity knowledge context;
- an optional provider port on the existing canonical Entity processor;
- reviewed Solana/SOL, Jupiter/JUP/Jupiter Mobile, and Polymarket fixtures;
- role-aware Polymarket shortlist behavior on the canonical Feed V3 path; and
- focused and full Entity Manager test execution.

The scoped slice must pass through the same canonical admission and planner
contracts used by the main pipeline. It must not create a second Entity
pipeline or a source-specific Entity Manager.

This document still does not authorize:

- a database migration;
- production backfill or cleanup;
- automated classification or relationship writes;
- changing the public Feed API;
- merging, splitting, or deleting existing entities; or
- enabling a new collector or inference workload.

The immediate outcome is a shared model plus a tested integration seam.
Physical knowledge storage, backfill writes, model-authored enrichment,
operator mutation APIs, and production activation require a later
implementation plan after the scoped behavior is reviewed.

## Scoped V1 Decisions

This section is authoritative for the approved scoped implementation. Later
sections describe the intended production direction and remain proposed where
they exceed this boundary.

### Main-pipeline integration boundary

The scoped knowledge context extends canonical Entity admission rather than the
public Entity Knowledge reader:

```text
ResearchPacketV1
  -> EntityServiceCanonicalPacketProcessor
  -> canonical shortlist
  -> optional EntityAdmissionKnowledgePort
  -> EntityAdmissionInput v2
  -> canonical Entity planner prompt v2
  -> existing admission decision and memory write
```

The contract is `myboon.entity_admission_knowledge.v1`. It is internal to the
Entity planner and is not a mobile/public API, not an extension of
`myboon.entity_knowledge.v1`, and not a persistence schema.

When no provider is configured, the field is absent and the processor follows
the existing catalog-only path. The active shared runtime does not configure a
provider in this scope, so production behavior remains unchanged.

The bounded context permits at most 12 reviewed classifications and 12
reviewed relationships per shortlisted entity. It is stably ordered and only
contains allowlisted fields.

### Frozen scoped kinds and legacy projection

The scoped kind vocabulary is:

```text
person
organization
network
protocol
product
asset
place
event
topic
regulation
unclassified
```

The read-only legacy projection is explicit:

| Existing type | Scoped kind |
|---|---|
| `person` | `person` |
| `organization`, `company` | `organization` |
| `network` | `network` |
| `protocol` | `protocol` |
| `product`, `ai_model` | `product` |
| `asset`, `commodity`, `currency`, `index`, `instrument`, `asset_class` | `asset` |
| `country`, `nation`, `geo`, `place`, `location` | `place` |
| `event` | `event` |
| `topic`, `market_theme`, `sector`, `indicator`, `geopolitical_topic`, `event_market` | `topic` |
| `regulation`, `legislation`, `regulation_or_initiative` | `regulation` |
| `project`, `platform`, or unknown | `unclassified` |

`project` and `platform` remain unclassified because either may describe an
organization, protocol, product, or umbrella brand. Reviewed scoped context
may supply the correct kind without rewriting the legacy entity. This
projection never falls back to `topic` and never performs a durable write.

### Scoped classifications and predicates

The controlled classification schemes are `domain`, `ecosystem`, `sector`,
`function`, and `asset_class`. Each concept has a stable `scheme:slug`
identity and a bounded root-to-concept path.

The frozen scoped relationship predicates are:

```text
native_asset_of
has_native_asset
token_of
has_token
issued_on
product_of
has_product
operates_on
```

They exist only as reviewed planner context. The scoped implementation cannot
propose or persist relationships.

### Polymarket subject-versus-source rule

The canonical Feed V3 shortlist may include the existing `polymarket` entity
only when a validated Research Packet contains an evidence-linked entity hint
whose normalized slug is `polymarket` and whose normalized role is exactly
`subject`, `primary_subject`, or `primary`.

`sourceType = polymarket`, source provenance, a title mention, or a `venue`
role never grants this exception. The default legacy shortlist remains banned.
Existing Polymarket entities and memories are not moved, rewritten, or deleted
in this scope.

Required regression cases are:

```text
news about a Polymarket product
  -> Polymarket may be the primary Entity

Polymarket odds about Solana
  -> Solana may be the primary Entity
  -> Polymarket remains source/venue context, not a filing candidate
```

### Provenance, failure, and replay boundary

Scoped knowledge is `reviewed` and carries a durable `reviewed_record`
reference to a checked-in review artifact. It never cites transient packet IDs
as its only provenance.

Because the scope performs no knowledge writes, it has no classification or
relationship replay identities and no partial knowledge-write state. Context
lookup happens before planner invocation and before any Entity or memory write:

- a missing provider means explicit catalog-only compatibility behavior;
- a configured unavailable provider is a retryable `storage_transient` failure;
- invalid configured output is a permanent `storage_permanent` failure; and
- both configured failure paths invoke neither the planner nor durable writes.

Automated evidence-backed persistence remains blocked until a later contract
defines durable evidence snapshots, deterministic write identities,
transactions, quarantine, retry, correction, and retention behavior.

### Migration and operator boundary

The scoped implementation does not split Solana/SOL, create Jupiter/JUP,
change foreign keys, migrate memories, rewrite publications, or remove legacy
metadata. Reviewed examples use fixture IDs only.

Review occurs through checked-in fixtures and code review. No operator mutation
endpoint or browser write action is added, and no proposed/unreviewed knowledge
is visible to any inference consumer.

## Product Outcome

myboon should know more than the name of a subject and the sequence of stories
filed under it.

For a durable subject, the system should be able to answer:

```text
What is this thing?
Which knowledge neighborhoods does it belong to?
How is it connected to other things we track?
What role does it play in this specific observation?
What happened to it over time, and what evidence supports that memory?
```

The model should make Research and Editor decisions more specific without
turning the product into a general-purpose ontology project.

```text
canonical identity
  + structural kind
  + controlled classifications
  + typed relationships
  + memory-specific entity roles
  + sourced timeline
  -> reusable entity knowledge
```

## Why This Matters

Entity memory is already the durable center of the Feed. It prevents every
research run from starting from zero and gives the Editor a history against
which to judge novelty.

The current entity record is still too flat to describe subjects such as
Solana, Jupiter, and Polymarket accurately:

- `Solana` can refer to a blockchain network, its ecosystem, or the SOL asset.
- `Jupiter` is an umbrella subject connected to Swap, Perps, Lend, Mobile,
  prediction markets, and the JUP asset.
- `Polymarket` can be the subject of a story, the venue on which a signal was
  observed, or merely source provenance for a story about something else.

A single free-form category cannot express those distinctions. When they are
left implicit, the cost appears throughout the pipeline:

- Entity admission can select a broad or incorrect filing home.
- Research receives an incomplete baseline and repeats foundational work.
- Mentions remain strings instead of resolvable connections.
- Related entities are inferred by text matching rather than stored meaning.
- Editor prompts receive a summary and timeline, but no dependable structural
  context.
- Publisher tags inherit inconsistent metadata vocabulary.
- User-facing categories risk mixing knowledge classification with feed
  presentation rules.

## Current-State Audit

The following is a read-only production catalog snapshot taken on 2026-09-11.
It is evidence for this PRD, not a migration manifest.

```text
total entities                         1,257
entities with a populated tags array       0
entities with a metadata category          39
distinct metadata category values          34
```

The snapshot is reproducible with the following service-role read query; it
returns aggregates only and does not mutate or expose entity content:

```sql
with categorized as (
  select
    id,
    tags,
    coalesce(
      nullif(metadata ->> 'category', ''),
      nullif(metadata ->> 'entity_category', ''),
      nullif(metadata ->> 'primary_category', '')
    ) as category
  from public.entities
)
select
  count(*) as total_entities,
  count(*) filter (where cardinality(tags) > 0) as entities_with_tags,
  count(*) filter (where category is not null) as entities_with_metadata_category,
  count(distinct category) filter (where category is not null) as distinct_metadata_categories
from categorized;
```

Examples of category drift include:

```text
crypto
cryptocurrency
blockchain
crypto_project
crypto-market
Layer 1 blockchain
layer-1 blockchain / native asset
DEX
decentralized_perpetual_exchange
```

The catalog also contains historical entity types outside the current
normalization vocabulary, including `company`, `platform`, `protocol`,
`nation`, `index`, `currency`, and several one-off topic variants.

Relevant examples from the snapshot:

- `solana` is an `asset` with metadata category `blockchain`; its summary mixes
  the durable subject with one particular Polymarket price market.
- `jupiter-mobile` exists as a `topic` and owns recent Jupiter Mobile memories.
- a canonical umbrella `jupiter` entity was not present in the queried catalog.
- Jupiter appears as an unresolved mention in Solana memories.
- `polymarket` exists as a legacy `platform` entity with memories, while the
  active canon code excludes the `polymarket` slug from filing candidates
  because it is also a collection source.

The repo already contains an `entities.tags` migration whose comments describe
coarse grouping, shortlist use, and future Research Gate use. The active entity
store and read contracts do not carry those tags through, and no production
entity currently has a populated tag array.

Publishing separately reads `category`, `entity_category`, or
`primary_category` from entity metadata, then falls back to entity type for the
single `entity_category` field. This is a compatibility behavior, not a
controlled knowledge contract.

## Core Principle

Category is a way of locating an entity in a knowledge neighborhood. It is not
the entity's identity, its structural kind, its relationship to another
entity, its role in a memory, or the Feed surface on which a narrative appears.

The model therefore separates five concepts:

```text
kind              what sort of durable thing this is
classification    which controlled knowledge neighborhoods it belongs to
relationship      how two canonical entities are connected
memory role       how an entity participates in one observation or memory
feed surface      how a published narrative is presented to a user
```

These concepts may be projected together for a consumer, but they must not be
stored or reasoned about as interchangeable labels.

## Canonical Terms

### Entity

A canonical, durable referent whose identity and timeline remain useful across
sources and over time.

An entity is not created merely because a noun appears in a packet. Source
records, scrape targets, temporary market questions, transaction receipts, and
presentation labels remain source or product objects unless they independently
deserve a durable timeline.

### Entity Kind

The entity's primary structural class. Kind answers, “What sort of thing is
this?” rather than, “What is it about?”

Examples:

```text
person
organization
network
protocol
product
asset
place
event
topic
regulation
```

The exact V1 vocabulary remains a review decision. The important constraint is
that one canonical value has one meaning. `protocol` must not silently mean
`project`, and `platform` must not silently mean either a legal organization or
a software product.

An entity has one primary kind in V1. Additional functional identity belongs in
controlled classifications. When two meanings have independently useful
timelines—for example, a network and its native token—they should normally be
separate entities connected by a relationship.

### Knowledge Classification

A membership in a controlled concept scheme. Classification answers, “Which
knowledge neighborhoods should this entity be discoverable within?”

An entity can have several classifications. Classifications may be
hierarchical.

Example schemes:

```text
domain       crypto, macroeconomics, politics, sports, technology
ecosystem    Solana ecosystem, Ethereum ecosystem, Bitcoin ecosystem
sector       DeFi, prediction markets, payments, infrastructure
function     DEX aggregation, wallet, lending, perpetuals, staking
asset class  crypto asset, stablecoin, commodity, equity
```

The first version should use a small reviewed vocabulary. The Entity Manager
may propose membership in an existing classification but cannot invent a new
classification string during normal packet processing.

### Entity Relationship

A typed, directional connection between two canonical entities.

Examples:

```text
SOL             native_asset_of   Solana
Jupiter         operates_on       Solana
JUP             token_of          Jupiter
Jupiter Mobile  product_of        Jupiter
```

Relationships are not inferred merely because names co-occur. Stored
relationships require provenance, confidence, and review or evidence-backed
admission appropriate to the predicate.

### Memory Entity Role

The role a canonical entity plays in one memory. This is contextual and does
not change the entity's kind.

Initial candidate roles:

```text
primary_subject
subject
actor
asset
network
protocol
product
venue
source_subject
catalyst
counterparty
mentioned
```

V1 retains exactly one `primary_subject` so existing entity lanes and Editor
ownership stay deterministic. A memory may link to additional entities with
other roles instead of copying the memory into several lanes or leaving every
connection as an unresolvable string.

### Source Provenance

Where an observation or evidence item came from. Source provenance is not an
entity decision.

The same canonical entity can appear as the subject in one memory and as a
venue or evidence source in another. A packet collected from Polymarket does
not automatically file under Polymarket; a story about Polymarket's own product
or business can legitimately use Polymarket as its primary subject.

### Feed Surface

A product presentation or retrieval rule for published narratives, such as
`recent` or `protocols`.

Feed surfaces are not entity classifications. The existing proposed Protocols
surface is intentionally based on protocol-transaction provenance. A news
story about a protocol does not enter that surface merely because its subject
is classified as a protocol.

## Entity Boundary Rules

Before classification, the system must decide what counts as one entity.
Category cannot repair an incorrect identity boundary.

### Split when timelines diverge

Use separate entities when two referents can change independently, have
different identifiers, support different action targets, or require different
historical timelines.

Examples:

- Solana network and SOL asset;
- Jupiter protocol/ecosystem and JUP asset;
- Jupiter umbrella subject and Jupiter Mobile product;
- Polymarket platform and an individual Polymarket market object.

### Keep one entity when labels are aliases

Do not split merely for ticker symbols, common abbreviations, renamed labels,
domains, or source-specific spelling.

Examples:

```text
SOL                 alias of the SOL asset
JUP                 alias of the JUP asset
polymarket.com       alias/identifier of the Polymarket product
```

### Do not promote every source object

An individual Polymarket market, article, post, transaction, or pool is not a
durable entity by default. It can remain a typed source/action object linked
from memory context.

Promotion requires an independent reason to ask for a cross-source timeline of
that exact object. A recurring real-world event or a durable protocol pool may
qualify; a temporary binary question usually does not.

### Separate brands/products from legal organizations when needed

The public product and its operating legal entity may initially share one
canonical subject only while the distinction has no product consequence. They
must split when regulation, ownership, financing, litigation, or other company-
specific facts would corrupt the product timeline.

## Worked Knowledge Map

The following is a proposed truth set for discussion, not approved production
backfill data.

| Canonical entity | Proposed kind | Example classifications | Example relationships |
|---|---|---|---|
| Solana | network | crypto; layer-1 network; Solana ecosystem | `has_native_asset → SOL` |
| SOL | asset | crypto asset; native token | `native_asset_of → Solana` |
| Jupiter | protocol | crypto; Solana ecosystem; DeFi; trading; DEX aggregation | `operates_on → Solana`; `has_token → JUP`; `has_product → Jupiter Mobile` |
| JUP | asset | crypto asset; governance token | `token_of → Jupiter`; `issued_on → Solana` |
| Jupiter Mobile | product | wallet; mobile trading; Solana ecosystem | `product_of → Jupiter`; `operates_on → Solana` |
| Polymarket | product | prediction markets; trading venue; crypto | operating-organization relationship only when verified and separately modeled |
| One Polymarket market | source/action object by default | market topic may be retained on the source object | source context may record its Polymarket venue and canonical subject; these are not scoped entity edges |

This map illustrates why `Solana = asset`, `Jupiter Mobile = topic`, or
`Polymarket = banned source` are individually too lossy for the long-term
knowledge layer.

## Future Product Read Model (Not Scoped)

This section describes a later production read model. It is not implemented by
the scoped `EntityAdmissionKnowledgeContextV1` contract and does not change the
existing paginated `myboon.entity_knowledge.v1` reader or internal API.

Future consumers should not assemble knowledge by reading arbitrary entity
metadata. They should receive one bounded, versioned, source-neutral profile.

Illustrative contract:

```ts
interface EntityKnowledgeProfileV1 {
  schemaVersion: 'myboon.entity_profile.v1'
  entity: {
    id: string
    slug: string
    name: string
    kind: string
    aliases: string[]
    summary: string | null
    status: string
  }
  classifications: Array<{
    scheme: string
    slug: string
    name: string
    path: string[]
    confidence: number | null
    verificationStatus: 'reviewed' | 'evidence_backed' | 'proposed'
  }>
  relationships: Array<{
    predicate: string
    direction: 'outgoing' | 'incoming'
    relatedEntity: {
      id: string
      slug: string
      name: string
      kind: string
    }
    confidence: number | null
    validFrom: string | null
    validTo: string | null
    verificationStatus: 'reviewed' | 'evidence_backed' | 'proposed'
  }>
  recentMemories: {
    items: EntityKnowledgeMemoryV1[]
    nextCursor: string | null
    hasMore: boolean
  }
}
```

The final physical schema may differ. A later consumer contract must define
audience, endpoint and service-role authorization, consumer-specific field
allowlists, maximum page size, and cursor behavior. Evidence, arbitrary
context, and internal provenance must not cross into public clients merely
because they exist in an internal profile.

## Proposed Persistence Responsibilities

The implementation plan should evaluate a normalized model equivalent to the
following responsibilities.

### Classification concepts

```text
stable ID / slug
scheme
display name
description
immediate parent, when hierarchical
version
status
```

The hierarchy must be cycle-free. V1 should store direct parent links and
derive ancestors; it should not write every transitive ancestor as an
independent model claim.

### Entity classification membership

```text
entity ID
classification ID
confidence
verification status
supporting evidence / provenance
valid-from and valid-to qualifiers
superseded-by reference, when corrected
created and updated time
```

Membership is many-to-many. A model may select only from the supplied
controlled classification menu. Production memberships are historically
versioned rather than silently overwritten, so a product reclassification or
organization role change remains explainable. Scoped reviewed context is a
current-state fixture and has no temporal persistence.

### Entity relationships

```text
subject entity ID
predicate
object entity ID
confidence
verification status
supporting evidence / provenance
valid-from and valid-to qualifiers
created and updated time
```

Predicates come from a small versioned registry defining direction, inverse
label, allowed subject/object kinds, and whether human review is required.

### Memory entity links

```text
memory ID
entity ID
role
is primary
supporting claim/evidence IDs
confidence
```

The existing `entity_memories.entity_id` remains the authoritative primary lane
during V1. Additional links enrich retrieval without changing Editor ownership
or duplicating memories. A link's time scope is the immutable memory it belongs
to (`event_at` / `observed_at`); changing a later role creates a link on a later
memory rather than rewriting the earlier one.

### Compatibility projections

During migration:

- existing `entities.type` may project as `kind` through a versioned mapping;
- reviewed classifications may project into legacy `entities.tags` if a
  current consumer still needs the array;
- `metadata.category` remains a read fallback only;
- no new normal-path writer should add free-form category strings to metadata;
- public narrative tags remain stable until a separately reviewed publisher
  cutover.

## Relationship Predicate Policy

The scoped V1 registry is frozen by the earlier Scoped V1 Decisions section:

```text
native_asset_of / has_native_asset
token_of / has_token
issued_on
product_of / has_product
operates_on
```

The scoped contract records direction explicitly. An inverse name is listed
only where both directions are safe and useful; it is not synthesized as a
second stored relationship.

A later persistence design should still begin with predicates needed by the
current product, not a general knowledge-graph vocabulary.

Deferred candidate predicates requiring semantics and migration review:

```text
part_of / has_part
developed_by / develops
owned_by / owns
integrates_with
successor_of / predecessor_of
```

Predicates such as `related_to`, `associated_with`, or `connected_to` are too
vague for durable writes. Co-occurrence can remain an inferred discovery hint
without being promoted to a canonical relationship.

Competitive, causal, disputed, and fast-changing relationships require a later
claim model or stronger qualifiers. They should not be flattened into permanent
edges in V1.

## Knowledge Admission Rules

### Code owns vocabularies

Kinds, classification schemes, classification concepts, relationship
predicates, memory roles, and their versions are code- or review-owned.

Inference may choose or propose from a bounded menu. It does not silently
create vocabulary.

### Evidence owns claims

Future model-proposed classification or relationship writes must cite canonical packet
claim/evidence IDs. The deterministic boundary rejects unknown IDs, invalid
kind combinations, unknown predicates, unknown classification slugs, and
self-links where the predicate forbids them.

The scoped implementation accepts reviewed context only and performs no such
writes. Production automation remains blocked until packet evidence is copied
to a durable reference that survives source-local SQLite retention.

Reviewed seed knowledge may cite a manual curation record rather than a live
research packet, but its actor and change history remain auditable.

### Identity decisions stay stricter than classification

A category match can improve discovery and shortlisting. It cannot by itself
merge entities, select a broad parent as the primary filing home, or authorize
new entity creation.

For example, `Jupiter` and `Solana` sharing `Solana ecosystem` should make both
available as context. It must not cause a Jupiter product story to file under
the broad Solana entity.

### Source and subject remain independent

Entity admission evaluates what the memory is about. Source provenance records
where the evidence came from. Memory roles record how other canonical entities
participate.

This replaces slug-level source bans with role-aware behavior:

```text
Polymarket odds move about a Fed decision
  primary subject: Federal Reserve / relevant event
  venue: Polymarket
  source: polymarket collector

Polymarket launches a new product
  primary subject: Polymarket
  source: news or first-party announcement
```

### Uncertainty stays visible

Proposed and weakly supported knowledge is not presented to downstream agents
as settled canon. Read contracts expose verification status and confidence, and
consumers can set minimum acceptance levels.

## Pipeline Integration

### Signal and Research Packet

Source adapters continue to emit evidence-backed entity hints. They may also
emit known source-object identities, such as a Polymarket market ID or a Solana
program ID, without promoting those objects into canonical entities.

No connector assigns free-form entity classification as trusted fact.

### Entity admission and planning

The shortlist may use:

- exact names and aliases;
- reviewed identifiers;
- controlled classification overlap;
- one-hop typed relationships; and
- packet entity hints backed by claims/evidence.

Category and neighbor matches are recall signals. Existing deterministic
identity collision checks and evidence-backed creation rules remain
authoritative.

The planner retains exactly one primary entity per packet in V1. It may propose
additional memory entity links, classifications, and relationships in a bounded
structured section. Each proposal is validated independently so an invalid
enrichment does not corrupt canonical identity.

The implementation plan must decide whether invalid optional enrichment rejects
the complete packet or is quarantined while the valid primary memory proceeds.

### Research Gate and Research Engine

The Research Gate should receive only knowledge relevant to the incoming
subject:

- canonical entity profile;
- recent memories;
- directly related entities needed to interpret the signal; and
- reviewed classifications useful for comparison.

It must not receive an unbounded graph dump. Retrieval budgets and stable
ordering remain explicit.

Better structural context should let Research ask delta questions such as:

```text
What changed in Jupiter Mobile versus the existing Jupiter product timeline?
Does this JUP move have a Jupiter-specific catalyst or only a broad SOL move?
Is this Polymarket signal about the venue or merely observed on the venue?
```

### Entity memory writer

The primary memory write remains replay-idempotent and source-neutral.
Classification, relationship, and secondary memory-link writes require their
own stable identities so replay cannot create duplicate knowledge.

Identity, classification, relationship, and memory failures remain observable
as distinct categories. A consumer must be able to tell whether a timeline was
saved but optional enrichment was held.

### Editor

The Editor receives a bounded Entity Knowledge Profile rather than arbitrary
metadata plus string mentions.

Relevant relationships and classifications can improve baseline context,
comparison, and terminology. They are not permission to invent causal claims
or add unrelated textbook explanation.

The Editor continues to write only from supplied, accepted knowledge. Proposed
or low-confidence edges are omitted unless the prompt explicitly identifies
their uncertainty and their inclusion is editorially necessary.

### Publisher

Publisher remains deterministic. It does not call inference to invent tags.

After a separately reviewed cutover, public entity tags may be projected from a
small allowlisted subset of reviewed classifications. Feed surfaces remain
derived from narrative/source contracts, not entity classification alone.

### Internal entity browser

The browser should eventually show:

- canonical identity and kind;
- reviewed and proposed classifications;
- incoming and outgoing relationships;
- memory-linked entities and their roles;
- provenance, confidence, and validity qualifiers; and
- legacy metadata/category fallbacks during migration.

Operators need review actions and reasons, not only a generated graph
visualization.

This operator workflow is future scope. Before production proposals exist, its
implementation PRD must define:

- service-role or narrower reviewer authorization separate from public reads;
- reviewer identity and role;
- propose, accept, reject, supersede, and restore actions;
- required reason and supporting evidence for every mutation;
- immutable before/after audit records;
- optimistic concurrency so stale reviews cannot overwrite newer decisions;
- whether acceptance activates knowledge immediately or through a versioned
  release; and
- a hard rule that proposed/unreviewed knowledge is invisible to Research,
  Editor, Publisher, and public clients.

## Retrieval and Prompt Budget Rules

Knowledge enrichment is useful only if it stays bounded.

- A primary entity profile has a maximum number of classifications,
  relationships, and recent memories per consumer.
- Relationship expansion is one hop by default.
- Direct, reviewed relationships rank above inferred co-occurrence.
- Consumer-specific projection decides which predicates and schemes matter.
- Stable ordering makes prompt and cache identities deterministic.
- Broad classifications do not pull every entity in a category into a prompt.
- Pagination and aggregate request ceilings follow the Entity Knowledge reader
  pattern already used by Editor and Publisher hydration.

## Quality and Safety Guardrails

### Vocabulary control

- No free-form normal-path category writes.
- No model-created relationship predicates.
- No silent fallback from unknown kind to `topic` for newly admitted entities.
- Vocabulary changes are versioned and reviewed.

### Graph integrity

- Classification hierarchies are cycle-free.
- Relationship endpoints must be canonical active entities unless a reviewed
  predicate permits historical/inactive entities.
- Predicate kind constraints are enforced deterministically.
- Inverse projections cannot create contradictory duplicate rows.
- Merge, split, and redirect behavior preserves relationship and memory-link
  history.

### Evidence and provenance

- Automated durable knowledge cites supplied packet evidence.
- Manual edits record actor, reason, and timestamp.
- Confidence is not a substitute for evidence.
- Time-sensitive relationships carry validity qualifiers.
- Corrections supersede or close prior knowledge; they do not silently erase
  historical assertions.

### Prompt safety

- Arbitrary stored metadata is not dumped into prompts.
- Only allowlisted profile fields and bounded evidence summaries cross the
  inference boundary.
- Source text cannot introduce new vocabulary or override deterministic
  admission rules.

### Product separation

- Entity classification cannot automatically publish a narrative.
- Entity kind cannot automatically place a story on a Feed surface.
- Relationship presence cannot imply causality.
- A source object cannot become an entity without independent admission.

## Evaluation Plan

Before implementation, create a reviewed truth set covering at least:

```text
Solana / SOL
Jupiter / JUP / Jupiter Mobile
Polymarket / Polymarket market / real-world event
Ethereum / ETH / Ethereum Foundation
Bitcoin / BTC / spot Bitcoin ETFs
a protocol / its legal organization / its token
a person / organization role change over time
a renamed product
a merged or acquired product
a noisy source object that must not become an entity
```

Evaluation should measure:

- correct entity boundary;
- correct primary filing home;
- correct kind;
- controlled classification precision;
- relationship precision and direction;
- source-versus-subject separation;
- no duplicate entities, relationships, or memory links on replay;
- prompt size and latency impact;
- Research novelty/delta quality;
- Editor specificity and factual correction rate; and
- stable public tags where a projection is enabled.

Historical replay should compare the current catalog-only shortlist with the
proposed knowledge-aware shortlist. Category overlap alone must not count as a
correct result; the primary filing decision must match the reviewed truth set.

## Success Measures

The initial rollout should be judged by knowledge quality, not the number of
tags or edges created.

Candidate measures:

- at least 95% reviewed precision for automatically accepted classifications
  and relationships in the launch cohort;
- no free-form category drift in new canonical writes;
- no regression in primary entity filing accuracy;
- measurable improvement in reviewed shortlist recall for connected subjects;
- zero replay-created duplicate relationship or memory-link identities;
- bounded profile hydration within existing consumer latency budgets; and
- Editor evaluation shows more specific background context without increased
  unsupported claims.

Numerical launch thresholds require a baseline replay and product review. This
PRD does not invent production SLOs without that evidence.

## Phased Delivery Proposal

Only the scoped portions of Phases 0 and 1 are currently authorized. Every
production or persistence phase requires separate implementation approval.

### Phase 0 — Scoped truth set and vocabulary (authorized)

- Review entity boundaries for the named launch examples.
- Approve the primary kind vocabulary.
- Approve small classification schemes and their direct hierarchy.
- Approve the initial relationship predicate and memory-role registries.
- Freeze reviewed-only status and reviewed-record provenance for the scoped
  context.
- Produce fixtures before a migration is written.

### Phase 1 — Scoped main-pipeline admission seam (authorized)

- Define `myboon.entity_admission_knowledge.v1` as an optional field of
  `EntityAdmissionInput v2`.
- Add the optional provider to `EntityServiceCanonicalPacketProcessor` before
  planner invocation.
- Add explicit legacy type-to-kind projection for tests and later reviewed
  reads; ambiguous values remain `unclassified`.
- Add bounds, stable ordering, validation, and fail-closed configured lookup
  behavior.
- Add role-aware Polymarket subject/source regression behavior.
- Keep the active shared runtime unconfigured and all production writers
  unchanged.

### Phase 2 — Reviewed storage and operator workflow

- Add normalized classification, relationship, and memory-link persistence.
- Add integrity constraints, stable identities, and audit history.
- Extend the internal entity browser for review.
- Seed a small manually reviewed high-value cohort.

### Phase 3 — Shadow inference enrichment

- Let Entity planning propose only controlled classification, relationships,
  and memory roles with packet evidence references.
- Validate and store proposals in shadow/review state.
- Compare against the truth set and historical replay.
- Do not expose proposals to Research, Editor, Publisher, or clients.

### Phase 4 — Internal consumer adoption

- Enable reviewed knowledge in shortlist retrieval and Research context.
- Enable bounded reviewed knowledge in Editor prompts.
- Measure accuracy, cost, latency, and content-quality deltas.
- Retain kill switches and catalog-only fallbacks.

### Phase 5 — Compatibility cleanup and public projection

- Backfill a reviewed cohort before considering catalog-wide enrichment.
- Define redirects/splits for ambiguous historical entities.
- Deprecate free-form metadata category writers.
- Project allowlisted classifications into public narrative tags only after an
  API and client review.
- Keep Feed surface logic separate.

## Scoped Implementation Verification

The authorized Phase 0/1 slice is implemented in the separate
`codex/entity-knowledge-model-prd` worktree and is intentionally not enabled in
the production runtime. It adds a reviewed, read-only knowledge port to the
existing canonical Entity admission path; it adds no database migration,
background writer, or second Entity pipeline.

Verified on 2026-09-11:

- `pnpm run test:entity-manager` — 194 passed, 0 failed.
- `pnpm run test:signal-platform` — 215 passed, 0 failed.
- Focused knowledge/admission/planner/processor tests — 35 passed, 0 failed.
- `pnpm run build` — TypeScript compilation passed.
- `git diff --check` — passed.
- Every local Markdown link in this PRD resolves.

The fixtures cover the reviewed Solana/SOL, Jupiter/JUP/Jupiter Mobile, and
Polymarket boundaries, including the rule that Polymarket may be shortlisted
when evidence marks the platform itself as the subject but remains excluded
when it is merely the source or venue. Content-quality evaluation is deferred
by scope and is still required before any production consumer activation.

## Migration Principles

- Additive before destructive.
- No bulk model-only rewrite of all 1,257 entities.
- Back up and inventory entity IDs, memory ownership, drafts, publications, and
  redirects before any split or merge.
- Seed high-memory and product-critical entities first.
- Preserve old entity IDs where identity remains correct.
- Use redirects when a legacy entity is superseded.
- Migrate `Solana`/`SOL` or similar conflated histories with an explicit,
  reviewed memory allocation plan.
- Do not infer a missing parent entity merely to satisfy a relationship.
- Every backfill is dry-run capable, resumable, idempotent, and auditable.
- Rollback disables new reads/writes without deleting accepted knowledge.

No identity migration is part of the scoped implementation. A later migration
PRD must use the following concrete safety model before any merge or split:

- Never delete a source entity during migration; the existing cascade and
  set-null foreign keys make deletion an unsafe redirect mechanism.
- A one-to-one merge creates a durable `old entity ID -> canonical entity ID`
  redirect and marks the old row inactive/redirected only after validation.
- The merge manifest enumerates every moved memory ID. Unpublished drafts whose
  source-memory set changes are invalidated and regenerated rather than silently
  retargeted.
- Published narratives and published history keep their immutable displayed
  name/slug snapshots. Their nullable `entity_id` may be retargeted to the
  canonical entity only when every source memory for that publication maps to
  the same target; otherwise they remain attached to the historical entity.
- A one-to-many split cannot use a global redirect. It requires a reviewed
  memory-by-memory allocation manifest. Unallocated memories and ambiguous
  historical publications remain on the legacy entity until resolved.
- Each entity operation runs in one database transaction with locked source and
  target rows, expected before-counts, expected after-counts, and an immutable
  operation record.
- Dry-run output contains the entity IDs, memory IDs, affected draft IDs,
  affected publication IDs, and exact intended foreign-key changes.
- Per-entity rollback uses the stored before-state mapping to reverse moves and
  restore statuses; it does not depend on reconstructing intent from logs.

## Non-Goals for V1

- A universal ontology or Wikidata replacement.
- Unbounded graph traversal in runtime prompts.
- Fully automated entity merge/split decisions.
- Turning every market, post, wallet, pool, or transaction into an entity.
- Modeling every scalar fact as a permanent graph statement.
- Causal inference from co-occurrence.
- Personalized taxonomy or user-created categories.
- Changing Feed ranking or publication authority.
- Replacing the existing evidence-backed memory timeline.

Durable scalar claims, disputed assertions, and richer qualifiers may become a
later claim layer. V1 should first prove identity, classification,
relationships, and memory roles with high precision.

## Risks

### Ontology before product value

The team could spend months naming concepts without improving Research or
content. Mitigation: begin with a small truth set and predicates used by current
consumer questions.

### Self-reinforcing wrong knowledge

An incorrect classification or relationship could bias future retrieval and
then appear to confirm itself. Mitigation: evidence references, review states,
consumer thresholds, correction history, and independent evaluation fixtures.

### Broad-category misfiling

Shared membership such as `Solana ecosystem` could cause product stories to
file under Solana. Mitigation: classification improves recall only; identity
and primary-subject evidence remain authoritative.

### Prompt and query expansion

Relationships can multiply context quickly. Mitigation: one-hop projections,
predicate allowlists, stable limits, and no broad-category fan-out.

### Legacy ambiguity

Historical types and summaries sometimes mix networks, tokens, companies,
products, and source objects. Mitigation: reviewed cohort-first migration,
redirects, and no catalog-wide destructive cleanup in the first release.

### Product-category confusion

Internal taxonomy could accidentally redefine public Feed tabs. Mitigation:
name public concepts Feed surfaces and require an explicit projection contract.

## Open Decisions

1. What exact primary kind vocabulary should V1 freeze?
2. Should `Jupiter` be modeled primarily as a protocol, product ecosystem, or
   brand, and when does its legal organization become separate?
3. Should `Polymarket` initially represent the public platform/product, with a
   future operating-company entity only when needed?
4. Which existing Solana memories belong to the network versus the SOL asset?
5. May a classification concept have more than one direct parent in V1?
6. Which predicates are safe for evidence-backed automatic acceptance, and
   which always require review?
7. Should invalid optional enrichment quarantine only that enrichment or fail
   the full Entity plan?
8. What is the first reviewed production cohort: top 25, top 50, or entities
   above a memory/activity threshold?
9. Which entity classifications, if any, should eventually become user-visible
   Feed filters?
10. When should durable scalar claims move out of prose memories into a
    separately queryable claim layer?

## Acceptance Criteria for the PRD Stage

- [ ] Product agrees that kind, classification, relationship, memory role, and
      Feed surface are separate concepts.
- [ ] The Solana/SOL, Jupiter/JUP/Jupiter Mobile, and Polymarket examples have
      reviewed identity boundaries.
- [ ] A small primary kind vocabulary is approved.
- [ ] Initial classification schemes and hierarchy rules are approved.
- [ ] Initial relationship predicates and memory roles are approved.
- [ ] Evidence, provenance, review state, and temporal qualifier semantics are
      agreed before schema work.
- [ ] The team chooses the first truth-set/backfill cohort.
- [ ] Research, Editor, Publisher, and internal-browser consumer contracts are
      reviewed.
- [ ] Public Feed surface behavior remains explicitly separate.
- [ ] No implementation starts until the open decisions that affect physical
      storage and migration are resolved.

## Design References

- [W3C SKOS Reference](https://www.w3.org/TR/skos-reference/) — controlled
  concept schemes and direct broader/narrower versus associative relations.
- [Wikidata data model](https://www.wikidata.org/wiki/Help:Data_model) —
  subject/property/value statements with qualifiers and references.
- [Jupiter product documentation](https://docs.jup.ag/) — useful real-world
  example of an umbrella subject with several independently meaningful
  products and action surfaces.
- [Polymarket markets and events](https://docs.polymarket.com/concepts/markets-events)
  — useful distinction between the platform, an event, and an individual
  tradable market.
