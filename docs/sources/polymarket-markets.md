# Source: Polymarket Markets

Status: implemented V0 reference source
Scope: Polymarket market-level data only

## What This Source Is

This is the first implemented Feed V3 source lane.

It watches Polymarket markets, finds market-level changes worth researching,
passes them through Researcher and Editor, then publishes approved items into
`published_narratives`.

This is not the full Polymarket source family.

Out of scope here:

- Polymarket wallets
- Polymarket trader profiles
- Polymarket order book / trade tape as a separate realtime source
- Sports-specific Polymarket coverage

Those should be separate source lanes.

## Source Lane

```text
Polymarket markets
  -> Markets Data Engineer
  -> market candidates
  -> Researcher
  -> market research rows
  -> Editor
  -> editor decisions
  -> Publisher
  -> published_narratives
```

## First Lane

Market-level observation.

The source watches selected active unresolved markets across non-sports tags
and manual pinned slugs.

Implemented selected tags:

```text
crypto
politics
geopolitics
economics
finance
business
technology
artificial-intelligence
commodities
```

Sports tags are intentionally excluded in this lane. Sports should become its
own source lane because the research/editorial needs are different.

## Raw Objects

Raw objects are Polymarket market/event rows fetched from Polymarket APIs.

Important source identifiers:

```text
slug
market_id
event_slug
title
tag / area
end_date
```

Important metrics:

```text
yes price
volume
24h volume
liquidity
recent activity
odds movement / volatility
freshness
closing window
```

## Candidate Triggers

The Data Engineer emits candidates when a watched market changes enough.

Implemented candidate types:

```text
odds_moved
volume_moved
activity_spiked
closing_soon
```

`newly_watchlisted` is not a Researcher candidate in V0. It is watchlist state
only.

## Candidate Score

The Data Engineer uses simple explainable scoring.

Current score inputs:

```text
volume / liquidity
recent activity
volatility / odds movement
freshness
manual pin bonus
noise penalties
```

The important rule is not the exact formula. The important rule is that every
candidate can explain:

```text
why this market was selected
why this market changed enough for research
```

## Noise Rules

V0 excludes:

- sports tags
- obvious short-term up/down binary markets
- stale or inactive market state
- repeated candidates inside cooldown windows

The goal is source diversity without source noise.

## Storage

Implemented local SQLite tables:

```text
pipeline_watchlist
pipeline_candidates
pipeline_research
pipeline_editor_decisions
pipeline_editor_drafts
pipeline_runs
```

Durable Supabase output:

```text
entities
entity_memories
published_narratives
entity_published_history
```

Watchlist:

```text
latest state of markets worth watching
```

Candidates:

```text
Researcher inbox
status = pending_research
```

Research rows:

```text
Editor inbox
status = pending_editor
```

Editor decisions:

```text
Publisher inbox for publish decisions
status = pending_publisher
```

Published rows:

```text
final feed table
published_narratives
```

## Stage Ownership

### Data Engineer

Owns market discovery, filtering, scoring, latest watchlist state, and
candidate emission.

Does not research, edit, publish, or create identities.

### Researcher

Owns context gathering for each candidate.

Research may include web/news context, Polymarket context, prior research for
the same slug, and uncertainty.

Does not decide final editorial quality.

### Editor

Owns publish / reject / needs_more_research.

May group related market research rows into one editor decision when they are
about the same topic, asset, event, or narrative.

Does not write final feed copy.

### Publisher

Owns final feed copy and final persistence into `published_narratives`.

Does not run new research and does not re-decide whether an Editor-approved
item deserves publishing.

## Final Actions

Published feed items from this source expose inspectable Polymarket actions:

```json
{ "type": "predict", "slug": "polymarket-market-slug" }
```

The Publisher hardens actions so only linked research slugs can be stored.

## Runner Commands

```bash
pnpm --dir packages/collectors polymarket:markets-data-engineer
pnpm --dir packages/collectors polymarket:researcher
pnpm --dir packages/collectors polymarket:editor
pnpm --dir packages/collectors polymarket:publisher
```

Useful one-shot env flags:

```text
POLYMARKET_MARKETS_RUN_ONCE=1
POLYMARKET_RESEARCHER_RUN_ONCE=1
POLYMARKET_EDITOR_RUN_ONCE=1
POLYMARKET_PUBLISHER_RUN_ONCE=1
```

## Reference Issues

```text
#190 Polymarket Markets Data Engineer
#191 Polymarket Researcher
#192 Feed Editor
#193 Feed Publisher
```

## What Worked

- The source can produce a real end-to-end feed item.
- Data Engineer latest-state plus candidate emission is better than append-only
  snapshots.
- Researcher gives the Editor richer context without deciding publish quality.
- Editor grouping/rejection is essential for reducing noise.
- Publisher writes into the shared final table with lightweight provenance.

## What To Improve Later

- Source-agnostic TypeScript contracts for candidates, research briefs, editor
  decisions, and publisher briefs.
- More deliberate research modes and helper tools.
- Better source-specific research direction for geopolitics, crypto, business,
  and macro markets.
- Identity memory integration after the source path is stable.
- Separate Polymarket wallet source lane.

## Next Polymarket Lane

Polymarket wallets should not be bolted onto this market lane.

It should get its own source packet and first-lane decision:

```text
Polymarket wallets
  -> Wallet Data Engineer
  -> wallet / trade behavior candidates
  -> Researcher
  -> Editor
  -> Publisher
  -> published_narratives
```

Likely raw objects:

```text
wallet address
trade / position activity
market slug
side / outcome
size
price
timestamp
wallet history
```

Likely first questions:

```text
Which wallets are credible enough to watch?
What makes a wallet action candidate-worthy?
How do we avoid turning every trade into feed noise?
What wallet memory do we need before publishing?
```
