# myboon Feed

Status: current product and pipeline note (Feed V3 shared research and entity pipeline implemented)
Scope: source-agnostic design for the myboon feed

## What The Feed Is

The myboon feed is the product's research and story layer. The intended user
experience is a personal market analyst: developing stories are organized in
chronological order, latest updates cover the wider market, and the calendar
shows important dates that have happened or are coming.

It watches many sources, connects observations to durable entities, researches
what changed, updates the entity graph, applies an editorial test, and publishes
only when there is something useful for the user.

The feed is not a raw data stream, a generic news app, or a collection of
source-specific feeds. A user should be able to understand the latest
development and what happened before it, instead of acting on one isolated
headline. When a useful action exists, the Story should connect to the relevant
asset and market rather than becoming a reading dead end.

## Core Principle

V3 should scale inputs without scaling noise.

More sources should create more candidate observations. They should not
automatically create more feed cards. A source can help the feed when it
produces useful evidence for an entity, claim, relationship, or future question.
Only the subset that passes the editorial test becomes a published feed card.

## Mental Model

Think of the system like a live newsroom:

```text
source filters      -> field producers / assignment desk
entity memory       -> beat files
research            -> context production
editor              -> newsroom judgment
publisher           -> final script
feed                -> broadcast
```

The system is always asking two questions:

```text
What did we learn that should update our entity memory?
Is there something worth publishing here right now?
```

## Pipeline

The default feed path is:

```text
source-specific data filter
  -> candidate observation
  -> entity match or entity creation proposal
  -> research and enrichment
  -> entity / claim / relationship memory update
  -> editor decision
  -> publisher, only when feed-worthy
  -> published feed item
```

Each source has its own filtering playbook, but every source emits the same
kind of candidate observation.

## Candidate Observation

A candidate observation is the shared object emitted by any source-specific
filter. It is not a feed item.

Minimum shape:

```text
source
observedAt
candidateType
entityHints
whatChanged
whyFlagged
evidence / receipts
metrics
freshness
uncertainty
```

The data filter's job is to say:

```text
This changed. It may matter. Here is the proof. Here are the entities it may
belong to.
```

It should not write final copy or decide that something is publishable.

## Entity Memory

The durable center of the feed is the entity graph.

An entity is any subject we may want to ask:

```text
What did we already know, what changed now, and does this change matter?
```

Examples of entities:

- BTC
- Gold
- a meme coin
- a wallet
- a protocol
- a venue
- a liquidity pool
- a sports event
- a recurring market theme

Entities are connected by claims, relationships, evidence, open questions, and
timeline events. For example, an X post about JTO may create or update entities
for JTO, Jito, JTX Trade, Ansem, and Solana infrastructure, plus a claim that
JTX fees may create JTO buy pressure.

Not every candidate becomes a feed item. A candidate can be rejected from the
visible feed and still update entity memory if it teaches the system something
durable.

New entity creation is a separate helper workflow. The default pipeline should
suggest entity creation when research finds a durable subject worth tracking,
but it should not create noisy entities automatically.

## Research Memory Graph

Published narratives are only one output of Feed V3. The deeper asset is the
curated research memory that accumulates around entities over time.

Research should preserve reusable intelligence, including:

```text
entities mentioned
claims discovered
relationships between entities
evidence links and receipts
confidence / uncertainty
timeline events
open questions
what was rejected or held, and why
```

This lets future agents, users, and feed runs ask richer questions than a fresh
web scrape can answer:

```text
What is JTX Trade?
How is it connected to JTO?
Which claims were made, verified, weakened, or disproven over time?
Who amplified the story?
What changed since we last researched it?
```

The visible feed can eventually support monetization around timely research and
user actions. The entity graph can support a later context API built from useful
research memory, including work that was not publishable at the time. Neither
path has revenue or user validation yet.

## Entity Maturity

Entity maturity controls research depth and publish threshold.

```text
canonical entity
  -> lower research burden, still needs a fresh material change

watched entity
  -> medium research burden, needs useful delta against memory

emerging entity
  -> higher research burden, needs proof that it is real and not noise

rejected or noisy entity
  -> normally suppressed unless something extraordinary changes
```

The more the pipeline runs, the stronger the entity graph becomes. Mature
entities should support faster and better decisions because the researcher can
compare new evidence against prior memory instead of starting from zero.

## Research

Research means:

```text
Given this candidate and entity context, what extra knowledge should we save,
and what extra context would make the editor smarter?
```

Research does not always mean web search.

For a large asset move, research may check recent news, prior entity memory,
market structure, and cross-source context. For a wallet move, research may
focus on wallet history and prior behavior. For a meme coin, research may focus
on liquidity, holders, prior cycles, and risk flags.

Research should enrich the candidate and propose memory updates. It should not
decide final feed quality.

## Editorial Test

The editor decides whether something belongs in the feed.

The core editorial priority is:

```text
1. Help a serious market participant notice something earlier or more clearly.
2. Connect the user to something inspectable or actionable.
3. Add personality only after the evidence is strong.
```

Every editor decision should include both human-readable reasoning and
structured reason codes.

Example reason codes:

```text
duplicate
weak_evidence
stale
not_material
low_liquidity
untrusted_source
already_covered
needs_more_research
no_clear_feed_value
```

Rejected and held decisions are part of the intelligence. They should update
entity memory when they contain durable claims, relationships, evidence, or
negative signal the system should remember.

## Publishing

The feed publishes as soon as the automated pipeline has enough evidence,
research context, and editor approval.

Publishing is not delayed for a daily batch.

Minimum publish contract:

```text
known primary entity
concrete change
strong enough evidence / receipts
editor approval
```

The publisher writes from the approved researched brief. It should not invent
new facts, claims, motives, or actions.

## Helper Tools

Many capabilities will sit around the pipeline as helper tools.

Examples:

- entity creation
- wallet profiling
- wallet history
- web search
- article scraping
- X/source scraping
- sports and calendar context
- token and pool research
- dedupe checks
- source reliability checks

Tools can be used wherever they help. They are not the pipeline by themselves.
The final feed decision still belongs to the editor stage.

## Build Approach

The rebuild should start from documentation and then proceed one source at a
time.

For each source, take one complete cycle to publish:

```text
source filter
  -> candidate observation
  -> entity match
  -> research
  -> entity / claim / relationship memory update
  -> editor decision
  -> publisher
  -> feed item
```

The first goal is not to add every source at once. The first goal is to prove
that the foundation stays understandable while each new source plugs into the
same feed design.

For the practical source onboarding checklist, see
[`FEED_SOURCE_BLUEPRINT.md`](FEED_SOURCE_BLUEPRINT.md).
