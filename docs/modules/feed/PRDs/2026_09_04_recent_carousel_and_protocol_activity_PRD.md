# Feed Recent Carousel and Protocol Activity PRD

Status: proposed
Created: 2026-09-04
Owner: myboon product / Feed
Module: feed
Review branch: `codex/polymarket-fresh-standard`
Product reference: supplied mobile Feed screenshot
Related:

- [`FEED.md`](../../../FEED.md)
- [`2026_08_26_feed_v3_signal_to_knowledge_platform_PRD.md`](../../entity-manager/PRDs/2026_08_26_feed_v3_signal_to_knowledge_platform_PRD.md)
- [`2026_08_13_structured_news_feed_PRD.md`](../../entity-manager/PRDs/2026_08_13_structured_news_feed_PRD.md)

## Document Scope

This PRD defines two related Feed changes:

1. turn the current vertical Recent feed into a polished, circular horizontal
   carousel whose cards advance from right to left; and
2. add a **Protocols** category that surfaces material, verified protocol
   activity derived from on-chain transactions.

This document does not authorize a production cutover, database migration, or
collector activation by itself. It is the implementation contract for later
work.

## Product Outcome

The Feed should feel alive without becoming noisy. A user can glance through
the newest intelligence one card at a time, see that more content is available,
and move continuously through the loaded set. The same interaction gives
protocol activity a clear home.

```text
Developing Stories (existing)

Recent | Protocols
        |
        v
circular card carousel
        |
        v
existing narrative detail sheet
```

**Recent** is the default chronological view of all published narratives.
**Protocols** is a subset of those narratives whose primary trigger is material
on-chain activity from a tracked protocol.

Transactions are evidence for Protocols cards. They do not bypass research,
entity memory, editorial review, or the publisher, and the Protocols category
must not become a raw block explorer.

## Why This Change

The supplied reference shows the intended visual rhythm: a large card with a
clear next-card peek, moving horizontally instead of presenting a long wall of
content. The current Expo Feed already has a horizontal Stories carousel, but
published narratives remain a vertical `FlatList` under **Latest**.

The public narrative contract also has no user-facing category for protocol
transaction intelligence. Adding transaction rows directly to the client would
conflict with the existing Feed rule that more observations must not
automatically create more cards.

## Goals

- Rename the latest-content section to **Recent** and make it a circular,
  horizontally snapping carousel.
- Make the next card visibly peek from the right so the interaction is obvious.
- Auto-advance cards from right to left while the user is passively viewing.
- Preserve manual swiping, card selection, freshness, refresh, and the existing
  narrative detail experience.
- Add **Recent** and **Protocols** as an accessible category switch.
- Collect finalized activity only for explicitly configured protocols, combine
  noisy transactions into meaningful events, and send those events through the
  shared Signal-to-Knowledge pipeline.
- Make every Protocols card traceable to public transaction evidence.
- Ship both changes behind reversible release controls.

## Non-Goals

- A live stream of every protocol transaction.
- A wallet tracker, portfolio, protocol leaderboard, or analytics dashboard.
- Personalized categories or protocol watchlists in this release.
- Trading, signing, or sending a transaction from a Feed card.
- Multi-chain collection in the first release.
- Replacing Developing Stories, its selection rules, or its detail sheet.
- Redesigning the Feed header, calendar, or bottom navigation.
- Publishing a transaction automatically because it crossed a numeric
  threshold.
- Moving durable entities, entity memories, or published narratives out of
  their current Supabase boundaries.

## Canonical Terms

### Recent

All eligible published narratives ordered newest first. Protocol narratives
also appear in Recent; categories are not mutually exclusive.

### Protocol Transaction Observation

One finalized on-chain receipt emitted by a program belonging to an allowlisted
protocol. An observation is source evidence, not a Feed card.

### Protocol Activity Signal

A deterministic, bounded summary of one or more observations for the same
protocol, event family, and time window. This is the object eligible for shared
triage and research.

### Protocols

The Feed view containing published narratives whose initiating Signal is a
Protocol Activity Signal. News about a protocol does not enter this view unless
the narrative is backed by tracked transaction activity.

### Circular Carousel

A bounded client presentation of the loaded result set. After the last card,
the next movement returns to the first card without a visible jump. It does not
change server ordering or imply that old content is new.

## Locked Product Decisions

1. **Recent remains the default.** Opening the Feed selects Recent.
2. **Recent is inclusive.** Every public narrative eligible today remains in
   Recent, including narratives also categorized as Protocols.
3. **Protocols is a filtered publishing surface.** It shows published
   protocol-transaction intelligence, not observations, research work, held
   items, or rejected items.
4. **Chronology remains newest first.** The circular treatment must not rerank
   the API result.
5. **Right-to-left describes motion, not text direction.** Advancing moves the
   current card left and brings the next card from the right. Text and controls
   still respect the device locale.
6. **Manual input wins.** Auto-advance pauses while the user touches, drags,
   reads a detail sheet, uses a screen reader, backgrounds the app, or leaves
   the Feed route.
7. **No fake infinite data.** The UI may loop through the loaded window, but it
   must not duplicate impressions, dates, or analytics identities.
8. **Phase 1 protocol collection is Solana-only.** Programs are enabled through
   an explicit registry. No address is inferred from a name or token metadata.
9. **Only finalized transactions qualify.** Pending, failed, or merely
   confirmed transactions cannot produce a public candidate.
10. **One transaction does not equal one card.** Aggregation and materiality
    gates happen before research admission.
11. **The existing editorial gate remains authoritative.** High value or an
    activity spike is a reason to inspect, not permission to publish.
12. **Existing public clients remain compatible.** `GET /narratives` without a
    category keeps its current Recent list behavior and ordering.

## Feed Information Architecture

Developing Stories stays above the published narrative section. The narrative
heading becomes an accessible two-option category control:

```text
RECENT    PROTOCOLS
^^^^^^
selected indicator

|<--------------- viewport ---------------->|
|   current card                         | next card peek
```

The labels are **Recent** and **Protocols** exactly. Each option exposes its
selected state to accessibility services and has at least a 44-by-44-point
touch target.

Changing category replaces the carousel data in place; it does not navigate to
a new route. The user returns to the last viewed position in each category for
the life of the mounted Feed screen.

## Recent Carousel Requirements

### Layout

- One primary card occupies approximately 88–92% of the content width.
- A stable gap and right-side peek reveal the next card.
- Cards snap one at a time; a normal swipe cannot accidentally skip several.
- Cards keep the existing Feed hierarchy: image when available, freshness,
  headline, description, and detail affordance.
- Card height may adapt to text scaling, but cards in the same loaded set should
  not visibly jump in height during a swipe.
- Leading and trailing insets align with the Feed screen margins.

### Motion

- With at least two cards, passive auto-advance begins five seconds after the
  first card settles.
- Each automatic advance moves exactly one card from right to left using a
  350–500 ms ease-out animation.
- After the last loaded card, the next advance lands on the first card with no
  visible rewind animation or blank frame.
- Touch-down pauses auto-advance immediately. It resumes five seconds after the
  user finishes and a card has settled.
- Opening any Feed sheet pauses the carousel. Closing it restarts the dwell
  timer for the still-visible card.
- The timer exists only while the Feed route is focused and the app is active.
  It is cleaned up on blur, background, and unmount.
- Reduced-motion preference or an active screen reader disables auto-advance.
  Manual horizontal paging remains available.

### Data and Refresh

- The initial Recent request loads the 20 newest narratives.
- The carousel keeps a bounded number of physical render items. Looping must
  never append clones indefinitely.
- Five-minute background refresh and pull-to-refresh keep the current cadence.
- Refresh preserves the visible narrative by stable `updateKey` when it remains
  in the result. Otherwise the carousel settles on the newest item.
- Refresh does not reposition the carousel while the user is dragging.
- New content may update silently, but the UI must not repeatedly force an
  active reader back to card one.

### Edge States

- Zero items: show the existing useful empty/error state in the carousel area.
- One item: show a static card with no loop, auto-advance, or false next peek.
- Failed refresh with cached data: keep cached cards and show a non-blocking
  stale/error state.
- Failed first request: show retry without hiding Developing Stories.
- Invalid rows or media URLs: drop or degrade only the invalid field, not the
  whole category.

## Protocols Category Requirements

Protocols uses the same carousel mechanics and detail-sheet pattern as Recent.
It has independent loading, error, empty, current-index, and refresh state so a
Protocols failure does not take down Recent or Developing Stories.

### Protocol Card

Every Protocols card contains:

- a **PROTOCOL** eyebrow;
- the protocol's canonical name;
- event time using the existing live relative-time behavior;
- an editorial headline and short explanation of what changed;
- chain identity, which is **Solana** in phase 1;
- at most two useful metrics chosen from transaction count, unique wallets,
  notional USD value, token amount, or comparison with a baseline window;
- a public-safe protocol/content image when available, otherwise the normal
  no-image treatment; and
- the existing narrative-detail affordance.

Missing or untrusted values are omitted. The client must not display `$0`, “0
wallets,” or another invented fallback when a metric is unavailable.

### Protocol Detail

The existing narrative detail remains primary. A bounded **Transaction
evidence** section appears when structured activity data exists:

- protocol and chain;
- activity window;
- event families included;
- aggregate metrics used by the narrative; and
- up to five representative finalized transaction signatures linked to an
  allowlisted explorer host.

The UI shortens signatures visually, but the full public signature can be
copied. No private labels, credentials, raw provider payloads, or unsupported
wallet-owner claims may be returned to the app.

### Empty State

If no protocol activity has passed the publishing gate, show:

```text
No protocol updates yet
Material on-chain activity from tracked protocols will appear here.
```

The empty state must not claim collection is healthy. Collector health is an
internal operational concern.

## Protocol Collection Scope

Phase 1 watches Solana programs in a checked-in, versioned registry. Each entry
contains:

```text
protocolId
canonical entity slug
display name
chain
program IDs
supported event families
enabled state
materiality policy version
explorer host
```

The launch protocol list and exact program IDs require product/engineering
approval before active collection. The collector fails closed for an unknown
program, unsupported decoder version, missing registry entry, or unfinalized
receipt.

Supported phase 1 event families are:

- swaps;
- deposits and withdrawals;
- liquidity added and removed;
- borrows and repayments;
- liquidations;
- stakes and unstakes; and
- protocol governance or administrator executions when the decoder can prove
  the invoked instruction.

Each registry entry declares its actual coverage; supporting a family in the
contract does not mean every decoder implements it.

## Signal-to-Knowledge Flow

Protocol activity joins the existing horizontal pipeline as a new source, not
as a source-specific researcher or Entity Manager.

```text
Solana RPC / indexer
  -> finalized transaction observation
  -> protocol registry + deterministic decoder
  -> bounded aggregation and materiality rules
  -> Protocol Activity Signal
  -> shared triage / research
  -> shared Entity Manager
  -> protocol entity memory
  -> existing editor and publisher
  -> published narrative
  -> Recent + Protocols
```

### Canonical Signal Extension

Implementation adds one member to the Feed V3 Signal union:

```ts
interface ProtocolTransactionSignal extends SignalBase {
  sourceType: 'protocol_transactions'
  contentKind: 'protocol_activity'
  content: {
    schemaVersion: 'myboon.signal_content.protocol_activity.v1'
    protocolId: string
    protocolEntitySlug: string
    chain: 'solana'
    eventFamilies: ProtocolEventFamily[]
    windowStartedAt: string
    windowEndedAt: string
    transactionCount: number
    uniqueWalletCount: number | null
    notionalUsd: number | null
    tokenAmounts: Array<{
      mint: string
      amountAtomic: string
      decimals: number
    }>
    representativeSignatures: string[]
    materialityReasons: string[]
    decoderVersion: string
    policyVersion: string
  }
}
```

Amounts use integer atomic units plus decimals. Floating-point token amounts
are display projections only. USD notional records valuation time and source in
the raw evidence; if valuation is missing or stale, it stays `null`.

### Identity and Deduplication

- Observation identity is `solana:<signature>:<instruction-index>`.
- A transaction with several relevant instructions may produce several
  observations, but replaying an instruction cannot create another.
- Signal identity is deterministic from protocol, event family, window start,
  policy version, and sorted observation identities.
- Provider retries, overlap, restart, and re-reading a finalized slot must not
  create duplicate Signals, memories, or narratives.
- The collector records the highest safely processed finalized slot and uses
  bounded overlap when resuming so it cannot silently create a gap.

### Aggregation and Materiality

The adapter groups observations by protocol and event family in a configured
window. It emits a candidate only when a versioned rule is met, for example:

- aggregate notional exceeds the protocol-specific threshold;
- transaction or unique-wallet count materially exceeds its comparison window;
- a liquidation cluster crosses its configured threshold;
- liquidity changes by a configured percentage or amount; or
- an allowlisted governance/administrator instruction executes.

Thresholds are configuration, not universal constants. The policy artifact
records the threshold, comparison window, minimum sample, and reason code. A
material candidate can still be archived or held by triage/editorial policy.

### Storage Boundaries

- Raw/decoded observations and collection cursors remain in a source-local
  SQLite store.
- The source store keeps public receipts, decoder/version data, aggregation
  inputs, and retry state. It never holds signing keys, wallet secrets,
  service-role keys, or private user data.
- Protocol Activity Signals, work, packets, and execution evidence use shared
  Feed V3 contracts and operational controls.
- Final knowledge is written to existing `entities` and `entity_memories`.
- Customer-facing output remains in `published_narratives`.
- No mobile client reads the source store or a collector endpoint.
- Automated source-store deletion is not authorized until retention and replay
  behavior have a reviewed operational policy.

## Entity and Publishing Rules

- Every admitted Protocol Activity Signal includes the canonical protocol
  entity slug from the registry.
- Entity Manager resolves that slug through the existing canonical boundary; it
  does not create an entity from an arbitrary program ID.
- Memory `source` is `protocol_transactions` and `source_type` is
  `protocol_activity`.
- Evidence contains representative receipts, finalized slot/range, decoder and
  registry versions, the materiality rule, and any price evidence used.
- Publisher preserves `source = 'protocol_transactions'` on the narrative.
- A Protocols narrative needs at least one valid source memory and finalized
  receipt. Otherwise publishing fails closed.
- Decoder or valuation corrections use the existing archive/correction path;
  original receipts are never silently rewritten.

## Public API Contract

The existing route remains canonical:

```http
GET /narratives?category=recent&limit=20&offset=0
GET /narratives?category=protocols&limit=20&offset=0
```

Rules:

- Missing `category` equals `category=recent`.
- `recent` applies no new source filter and preserves current ordering.
- `protocols` filters published rows to
  `source = 'protocol_transactions'` before pagination.
- Unknown category values return `400` with a public-safe validation error.
- Existing `limit` and `offset` bounds stay unchanged.
- Filtering is server-side; the client must not fetch Recent and filter locally.
- List/detail changes are additive so old clients can ignore new fields.

Additive list fields:

```ts
interface FeedItemDto {
  // existing fields remain unchanged
  categories: Array<'recent' | 'protocols'>
  protocolActivity: null | {
    protocolId: string
    protocolName: string
    chain: 'solana'
    windowStartedAt: string
    windowEndedAt: string
    eventFamilies: string[]
    transactionCount: number
    uniqueWalletCount: number | null
    notionalUsd: number | null
  }
}
```

Detail extends `protocolActivity` with at most five receipts:

```ts
representativeTransactions: Array<{
  signature: string
  explorerUrl: string
  finalizedAt: string
}>
```

Fields are derived from linked entity memories through a bounded batch read.
The API allowlists public fields; it does not expose arbitrary memory `context`,
`metrics`, or `evidence` JSON.

### Caching and Failure Isolation

- Recent and Protocols use distinct request/cache keys.
- The client loads Recent and Developing Stories first. Protocols loads lazily
  when selected.
- A successful category may be reused for five minutes before foreground
  refresh.
- Switching does not cancel or erase the other category's successful result.
- Failed optional memory enrichment may degrade Recent structured fields. A
  Protocols row without minimum evidence is omitted and logged internally.

## Accessibility and Internationalization

- Category controls expose role, label, selected state, and predictable focus.
- Every card is one accessible button with category, position, headline, and
  relative time in its label.
- The next-card peek cannot clip keyboard or screen-reader focus.
- Auto-advance is off with a screen reader or reduced motion.
- Text scaling must not hide the headline, category, or detail affordance. The
  card may grow vertically at large sizes.
- Color is not the only selected/current cue.
- Dates, numbers, and currencies use locale-aware formatting.
- Chronology is newest to oldest in every locale; RTL support must not reverse
  the underlying result order.

## Performance and Reliability

- Recent becomes usable within the current loading budget; the carousel adds no
  blocking request.
- Category API p95 target is under 750 ms excluding a cold connection.
- Carousel target is 60 fps, with no image preloading beyond the current card
  and next two cards.
- There is at most one auto-advance timer per mounted Feed screen.
- Loop sentinels are bounded and never reported as distinct content.
- Memory use stays flat after 100 automatic or manual wraps.
- Protocol collection exposes finalized slot, lag, observation/dedupe/decode
  counts, emitted Signals, queue age, and last successful poll through the
  existing control-plane pattern.
- A decoder error for one protocol cannot stop other registered protocols.

## Security, Privacy, and Trust

- RPC/indexer credentials stay server-side.
- Only public finalized signatures and public on-chain facts reach the client.
- Explorer links are built server-side from an allowlisted HTTPS origin;
  provider-supplied arbitrary URLs are rejected.
- Program IDs must match the versioned registry before decoding.
- Wallet addresses are not assigned a person/organization label without
  separately verified evidence accepted by Entity Manager.
- Missing prices, ambiguous events, and incomplete decoder coverage remain
  explicit limitations, not estimated facts.
- Logs and public errors exclude credentials and raw provider payloads.

## Analytics

Events use canonical narrative IDs, not physical carousel indices:

```text
feed_category_selected
feed_carousel_card_impression
feed_carousel_manual_advance
feed_carousel_auto_advance
feed_carousel_wrap
feed_card_opened
protocol_transaction_evidence_opened
feed_category_load_failed
```

An impression counts once per narrative ID and category per screen session
after at least 50% of the card is visible for one second. Looping must not
inflate impressions.

## Success Measures

- Crash-free Feed sessions do not regress from baseline.
- p95 time to first usable Recent card regresses by no more than 10%.
- At least 99% of sampled automatic advances land on one valid card with no
  blank frame.
- Every sampled Protocols card has a protocol entity, finalized receipt,
  materiality reason, source memory, editor approval, and publisher record.
- Replay/restart testing produces no duplicate Signal or narrative for an
  idempotency identity.
- After 14 days, product reviews category selection, card-open rate, evidence
  opens, and empty-state frequency before expanding protocol coverage. This PRD
  does not invent a usage target before a baseline exists.

## Release Plan

### Phase 0 — Contracts and Fixtures

- Add the registry, decoder fixtures, Signal types, validation, and API fixtures.
- Approve launch program IDs, decoder coverage, and materiality policies.
- Keep collection and public Protocols responses disabled.

### Phase 1 — Shadow Collection

- Run finalized Solana collection/aggregation without research admission.
- Compare decoded observations with explorer receipts and protocol-native views.
- Prove recovery, overlap, idempotency, provider outage handling, and
  per-protocol isolation.

### Phase 2 — Shared Pipeline Shadow

- Admit a reviewed sample to shared triage, Research, and Entity Manager.
- Verify entity attachment, evidence projection, editorial quality, cost,
  capacity, and rollback.
- Keep output unavailable to public clients.

### Phase 3 — Recent Carousel

- Release behind a client feature flag, retaining the vertical list as rollback.
- Validate motion, accessibility, refresh stability, memory, analytics, and
  iOS/Android behavior.

### Phase 4 — Protocols Category

- Enable the API category, then the client control, for internal review.
- Activate public publishing only after shadow and evidence review pass.
- Expand registry entries independently; adding a protocol needs no client
  release.

## Rollback

- Client rollback disables the feature flag and restores the vertical Recent
  list without changing published data.
- API rollback hides Protocols while unfiltered `GET /narratives` continues.
- Pipeline rollback sets protocol intake, research, and entity ownership safe
  off through the Feed V3 control plane.
- Collector rollback stops after persisting its finalized cursor.
- No rollback step deletes or rewrites receipts, memories, or published history.

## Acceptance Criteria

### Recent UI

- [ ] Feed opens with Recent selected and current newest-first narratives.
- [ ] With two or more cards, the next peeks from the right and each swipe snaps
      to one card.
- [ ] The settled card advances left after five passive seconds.
- [ ] Advancing after the last card shows the first without a blank frame,
      reverse-scroll animation, or duplicate analytics identity.
- [ ] Touch, drag, open sheet, route blur, app background, reduced motion, and
      screen-reader state pause or disable auto-advance as specified.
- [ ] A single card is static; an empty category shows its correct state.
- [ ] Refresh preserves the visible item when possible and never jumps mid-drag.
- [ ] Existing detail, image, relative-time, refresh, and error behavior works.

### Protocols UI and API

- [ ] Recent and Protocols are accessible category controls.
- [ ] Protocols loads lazily and its failure does not affect other sections.
- [ ] `GET /narratives` and `category=recent` remain backward compatible.
- [ ] `category=protocols` filters before pagination and rejects unknown values.
- [ ] Every Protocols card comes from a published
      `protocol_transactions` narrative.
- [ ] Unknown metrics are omitted instead of rendered as synthetic zeroes.
- [ ] Detail exposes no more than five finalized, allowlisted explorer links.
- [ ] The specified empty state appears when no rows qualify.

### Pipeline

- [ ] Only enabled program IDs and supported decoders emit observations.
- [ ] Only finalized successful transactions enter aggregation.
- [ ] Replay, overlap, retry, and restart tests prove idempotency.
- [ ] Materiality rules are versioned and recorded on each Signal.
- [ ] Protocol signals use shared triage, Research, and Entity Manager; no
      protocol-specific researcher or Entity Manager is introduced.
- [ ] Publishing without a canonical protocol entity, source memory, editor
      approval, or finalized receipt fails closed.
- [ ] Shadow evidence covers normal traffic, spikes, provider outage, decoder
      error, restart, and rollback before public activation.

### Quality

- [ ] Unit tests cover category parsing, public projection, loop-index
      normalization, timers, pause rules, reduced motion, and analytics dedupe.
- [ ] Integration tests prove collector-to-Signal idempotency and
      Signal-to-published-category provenance.
- [ ] Expo end-to-end tests cover Recent looping, category switching, Protocols
      empty/error/success, evidence detail, refresh, and app background/return.
- [ ] Manual QA passes on supported small/large iOS and Android layouts, large
      text, reduced motion, and VoiceOver/TalkBack.

## Launch Configuration Still Required

Implementation may begin against fixtures, but public collection cannot
activate until owners approve:

- initial protocol names and canonical entity slugs;
- every program ID and supported instruction decoder;
- materiality thresholds and comparison windows per event family;
- Solana RPC/indexer and explorer providers;
- source-store location, backup behavior, and retention policy; and
- internal reviewers and evidence sample required for production approval.

These are deployment/configuration decisions. They must not be guessed by the
client or silently hard-coded during implementation.
