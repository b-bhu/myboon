# Beta Readiness Sprint PRD

Status: decision-aligned draft
Date: 2026-07-11
Owner: myboon product
P0 timebox: July 10–22, 2026

## Purpose

Move myboon from an installable pre-beta build to one coherent, device-tested
beta journey that can support the Alliance ALL18 application.

The sprint prepares a Solana dApp Store package, but store submission is
conditional on the release, safety, privacy, and device gates passing. Alliance
submission is not blocked by dApp Store approval.

The sprint protects the product shell the founder has already chosen:

```text
Feed -> Apps -> Wallet
```

The missing 30% is not more protocols. It is the public product layer that turns
the existing entity memory, market integrations, and wallet readers into one
truthful experience.

## Current Foundation

The following foundations already exist and should be improved rather than
restarted:

- entity memory stores durable subjects and source-backed memories
- editor and publisher paths already attach narratives to entities
- `entity_published_history` already records public entity-linked output
- the mobile home is already a long scroll with context first
- Polymarket, Pacifica, and Phoenix have mobile routes at different maturity
  levels
- wallet authentication, prediction positions, and perps account reads exist
- an EAS Android APK profile exists for dApp Store-oriented builds

These foundations do not yet prove beta readiness. Device behavior, venue
capabilities, release signing, network security, and public UX still require
verification.

## Problem

### 1. Feed still behaves like the previous source-centric product

The current Feed renders each published narrative as an isolated card:

```text
category
headline
short body
tap -> article-like full story sheet
```

This resembles an X or news feed. It does not show that multiple signals belong
to a developing subject, what came before, or how the latest change fits into a
larger sequence.

### 2. Entity memory needs a safe mobile mapping

The entity manager is the right internal foundation, but complete memory rows
also contain research bodies, evidence, metrics, context, diagnostics, and
internal identifiers that do not belong in the mobile contract.

The mobile app must map each non-marker memory to only its concise `summary` and
date. It must never expose a complete `entity_memories` row directly.

### 3. Product terms are becoming mixed

The beta must use these terms consistently:

```text
Feed   = the top-level context surface and date-ordered stream of Updates
Story  = the safe API projection of one Entity for P0
Update = one published development in the chronological Feed
Entity = the internal durable subject behind research memory
Event  = one mapped non-marker Entity memory summary and date
Apps   = categorized market/action surfaces
Wallet = accounts, balances, and positions
```

“Story” does not replace “Feed” in navigation.

### 4. Apps currently overstate product maturity

The current home launcher includes dead or incomplete surfaces:

- Orca, Raydium, and Kamino have no mobile routes
- Meteora now has a real mobile route at beta scope (pools, create position,
  and position management); it is not dead or fabricated, but its DLMM
  liquidity scope is narrower than a full protocol integration
- Swap currently shows mock balance state and a `COMING SOON` action
- Phoenix is explicitly marked incomplete and has wallet, regional, access-code,
  close-position, and TP/SL limitations
- only Pacifica and Phoenix have mobile perps routes
- Hyperliquid exists as a data/collector direction, not a mobile action surface

The beta cannot describe all of these as working apps.

### 5. Wallet state is visually convincing but partly fictional

The home wallet currently shows hard-coded net worth, daily change, venue value,
and positions. The drawer also contains a hard-coded Pacifica value and mixes
account controls with protocol profile navigation.

Unknown or unavailable money state must never appear as a believable number.

### 6. A connected wallet is not automatically actionable everywhere

myboon currently supports different wallet and protocol states:

- external Solana wallets can expose different signing capabilities
- Privy embedded wallets do not expose the same Solana transaction path used by
  every venue
- Polymarket requires a separately derived Polygon identity, deposit wallet,
  funding, and renewable signing session
- Phoenix can require access activation and can be region restricted

The beta journey must describe setup, funding, unsupported, expired, and
restricted states—not only connected versus disconnected.

### 7. Release readiness is unproven

Current repository evidence includes:

- Android `usesCleartextTraffic` is enabled
- API fallbacks can use HTTP
- mobile app version is `1.0.4`, while the drawer displays `v0.1.0`
- several Android/splash assets referenced by `app.json` are absent
- the mobile TypeScript check currently fails in the Predict Playwright setup
- only Polymarket has meaningful lifecycle E2E coverage
- privacy, support, verified deletion, and beta feedback journeys are absent

The current build must be installed and audited before the sprint assumes it can
be submitted.

## Product Boundary

The long-term boundary is:

```text
Entity manager = internal research memory
Feed Story      = safe user-facing projection
```

That boundary is correct and permanent.

The P0 sprint does not build a full multi-entity Story platform or automatic
Story matcher. It first validates whether users understand and value a compact
entity-backed timeline.

For P0:

- a Story is projected from one primary Entity; Entity and Story remain separate
  internal and public concepts
- the shared Entity Manager writes a concise, neutral one- or two-line summary
  for every non-marker memory from both Polymarket and news
- an Entity's Story timeline is its non-marker memories ordered chronologically
- `entities.show_in_carousel` is the only P0 control for carousel membership
- the latest Entity memory summary provides the Story's latest development
- the existing publisher cron remains the automated path from eligible editor
  draft to Feed Update; Publisher is a separate consumer of Entity Manager and
  does not control the carousel or Entity timeline
- Home shows a hard-coded carousel of up to five developing Stories and three or
  four recent Updates
- the full Feed remains a complete stream of entity-linked Updates ordered only
  by publication date
- US–Iran is the anchor timeline and context-to-action demonstration
- source receipts and research provenance remain internal; P0 has no public
  evidence or source-detail experience

If beta evidence later shows that one entity needs several simultaneous Stories,
P1 introduces a separate persisted Story domain.

## P0 Beta Definition

The P0 beta candidate is ready when this exact journey works on the target
Android device:

```text
open myboon without signing in
  -> see Feed first
  -> open one developing Story
  -> understand its latest development and chronological history
  -> inspect one related market/app
  -> connect a supported wallet only when required
  -> complete one controlled, verified transaction lifecycle
  -> see the resulting protocol account or position refresh
  -> send feedback or start a verified deletion request
```

The P0 beta does not promise that every visible protocol supports every wallet
or every transaction.

## P0 Goals

1. Keep the permanent Home order `Feed -> Apps -> Wallet`.
2. Deliver a hard-coded carousel of up to five entity-backed Stories, plus three
   or four recent Updates on Home and a complete date-ordered full Feed.
3. Deliver one complete compact public timeline for the US–Iran Story.
4. Categorize Apps and hide every capability that is not device verified.
5. Remove all fabricated balances, values, positions, signals, and app versions.
6. Show separate live protocol account summaries with honest state and time.
7. Verify one controlled real-money lifecycle on Android.
8. Produce a signed test APK, an Alliance demo, and a conditional dApp Store
   package.

## P1 After Alliance

- persisted multi-entity Story and related-entity model
- richer Story matching and timeline automation
- several simultaneous Stories per broad entity when needed
- Entity identity/background descriptions
- visible categories, filters, search, saves, follows, alerts, and chart
  annotations
- personalized ranking, Update consolidation, duplicate handling, and publisher
  cadence changes
- legacy narrative reconciliation and additional perps, on-chain, wallet, and
  social publishing pipelines
- Polymarket inclusion in the Wallet combined total (see
  [`docs/modules/wallet/PRDs/2026_07_21_beta_readiness_wallet_PRD.md`](../modules/wallet/PRDs/2026_07_21_beta_readiness_wallet_PRD.md)
  for the P0 total's actual scope)
- Phoenix full execution, Swap execution, a third perps venue, and LP apps
- cross-protocol transfers
- richer analytics and in-app feedback tooling
- dApp Store submission if any P0 release gate remained unresolved

## Non-Goals for P0

- Do not rewrite the entity manager.
- Do not expose raw entity memory to mobile.
- Do not create `public_stories`, `public_story_entities`, or automatic Story
  matching during this sprint.
- Do not change the existing editor-draft -> publisher-cron ->
  `published_narratives` publishing model.
- Do not show categories, sources, receipts, or evidence in the Feed UI.
- Do not add saves, follows, filters, search, or personalization.
- Do not backfill unlinked legacy narratives during P0; exclude them from the new
  Feed.
- Do not redesign publisher timing, Update consolidation, or repetition handling.
- Do not add a third perps venue.
- Do not present Hyperliquid collection work as a mobile integration.
- Do not add LP execution.
- Do not ship working cross-protocol transfers (visible `Coming soon` only).
- Do not include Polymarket in the Wallet combined total or row list.
- Do not add analytics until privacy, retention, and deletion ownership are
  approved.
- Do not build a graph visualization.
- Do not make the internal entity browser public.

## Information Architecture

### Site Map

```text
Home /
  Feed preview
    Developing Story carousel, up to five hard-coded Stories
    Three or four recent entity-linked Updates
    Full Feed /feed
      Complete entity-linked Update stream, newest first
      Feed detail /narratives/:updateKey
    Story detail /stories/:storySlug
      Related prediction market /predict-market/:slug
      Related Pacifica market /trade/:symbol
      Related Phoenix market /markets/phoenix/:symbol
  Apps
    Prediction /predict
    Pacifica /trade
    Phoenix /markets/phoenix, only at its verified capability level
  Wallet preview
    Wallet /wallet
      Combined total: Solana spot + Meteora + Phoenix + Pacifica
      Solana spot balance row
      Meteora account /markets/meteora/profile
      Phoenix account /markets/phoenix/profile
      Pacifica account /trade?view=profile
      Wallet activity: Send, Receive, Deposit, Withdraw, Transfer
        (all "Coming soon")
      (Polymarket stays on its existing /predict-profile path, outside
      the Wallet total)

Account drawer
  Identity and wallet connection
  Security and export
  Feedback and support
  Privacy and account deletion
  Disconnect
```

### Navigation Model

- **Primary navigation:** the Home long scroll; no persistent bottom tabs are
  added in P0.
- **Contextual navigation:** carousel Stories open Story detail; Feed Updates
  open their full published Feed detail; optional actions open the relevant
  market when the later action work adds them.
- **Utility navigation:** the account drawer owns identity, security, support,
  privacy, deletion, and disconnect.
- **Back behavior:** Story and Feed detail return to Feed without losing scroll
  position where feasible. A market returns to whichever detail surface opened
  it.
- **Maximum depth:** Home -> Full Feed -> Feed detail, or Home -> Story -> Market.
  Protocol-specific funding or review modals are contextual steps, not new
  primary navigation levels.

### Content Hierarchy

#### Home

1. Feed — why the user should care now
2. Apps — where the user can inspect or act
3. Wallet — what the user owns or has open

#### Story Detail

1. Story name
2. latest development
3. concise chronological timeline
4. related market action, when present

Related entities, confidence visualizations, graphs, and long research prose are
not P0 content.

#### Wallet

1. protocol account states and timestamps
2. positions grouped by protocol
3. funding/setup/retry action when required
4. route to the protocol-native detail surface

### Naming Conventions

| Concept | UI label | Rule |
|---|---|---|
| Context surface | Feed | Never rename the top-level surface to Stories |
| Developing context item | Story | Safe API projection of one Entity for P0 |
| Recent development | Update | One entity-linked item in the chronological Feed |
| Historical point | Event | Concise public point inside a Story timeline |
| Market/protocol launcher | Apps | Replaces the current Home label Markets |
| Account/position area | Wallet | Includes protocol positions; not the drawer |
| Identity utility | Account | Drawer title and purpose |

## Primary User Journeys

### 1. Context-only visitor

```text
open app
  -> browse Feed without authentication
  -> open Story
  -> read the latest development and chronological timeline
  -> inspect related market in read-only mode
```

### 2. External-wallet action user

```text
open Story action
  -> inspect market
  -> connect an installed Solana wallet
  -> app checks required signing capability
  -> set up or fund the protocol account if needed
  -> review venue, amount, fees, and maximum loss
  -> confirm
  -> reconcile pending/confirmed/failed state after resume or timeout
  -> refresh protocol account/position
```

### 3. Embedded-wallet user

```text
sign in with email or passkey
  -> embedded wallet becomes available
  -> app checks the selected protocol's signing requirements
  -> supported action continues
  -> unsupported action explains why and offers a supported route
```

The app must never imply that an embedded wallet can transact on every visible
venue.

### 4. Polymarket setup and session renewal

```text
connect base wallet
  -> derive/verify Predict owner identity
  -> show deposit wallet and funding state
  -> request a fresh signature when the session is missing or expired
  -> place, cash out, or redeem only when the required state is ready
```

### 5. Restricted or access-required venue

```text
open venue
  -> detect access code, regional, or wallet limitation
  -> show plain-language status before enabling transaction UI
  -> do not provide a bypass
```

### 6. Portfolio user

```text
open Wallet
  -> see separate protocol account cards
  -> see state and “as of” time for each
  -> open positions grouped by protocol
  -> retry, set up, or open native profile as appropriate
```

### 7. Feedback and deletion

```text
open Account drawer
  -> send feedback without an automatic screenshot
  -> optionally include contact details and diagnostics
  -> read privacy/support information
  -> submit a deletion request and receive confirmation
```

## P0 Workstream 0: Release Truth Before Feature Work

Run this on Day 1 before committing to the feature schedule.

### Build and device audit

- run the mobile TypeScript check and fix current Predict Playwright failures
- build the current `dapp-store` APK
- verify the signing key is recoverable and documented
- install and launch on the target Android/Seeker device
- verify HTTPS API connectivity
- verify external wallet and embedded wallet entry paths
- verify package name, app version, icon, adaptive icon, and splash assets
- inspect the APK for secrets and internal URLs

Missing release assets referenced by `app.json` must be restored or the config
must be corrected before the release build is considered valid.

### Capability matrix

Test each venue on the target device and record:

| App | Browse | Account read | Deposit | Trade | Close/cash out | Withdraw | Wallet types | Status |
|---|---|---|---|---|---|---|---|---|
| Polymarket | test | test | test | test | test | test | external / embedded | TBD |
| Pacifica | test | test | test | test | test | test | external / embedded | TBD |
| Phoenix | test | test | test | test | test | test | external / embedded | TBD |
| Swap | test | n/a | n/a | test | n/a | n/a | external / embedded | hidden by default |

Status rules:

```text
live      = required lifecycle verified on device
read-only = browsing/account reads verified; transaction UI disabled
hidden    = capability or release truth is not verified
```

Default until testing proves otherwise:

- Polymarket: visible at the highest verified lifecycle
- Pacifica: visible at the highest verified lifecycle
- Phoenix: read-only or hidden
- Swap: hidden
- Meteora: visible at its verified beta lifecycle (see beta-scoped Meteora
  PRD); this is the one exception to hiding LP apps for P0
- other LP apps (Orca, Raydium, Kamino) and a third perps venue: hidden,
  shown as `Coming soon`

### Sprint stop condition

If the current APK cannot be built, signed, installed, and connected to an HTTPS
API by the end of Day 1, release repair becomes the sprint priority. Do not add
new Feed or Wallet architecture on top of an unshippable build.

## P0 Workstream 1: Entity-Backed Stories and Updates

### Existing publishing model stays intact

Entity Manager is the central memory layer with separate consumers:

```text
research -> Entity Manager -> entities + entity_memories
                            -> carousel/Story timeline reads selected Entities directly
                            -> editor -> publisher cron -> Feed Updates
                            -> future consumers such as X marketing
```

The publisher continues to wake on its existing schedule and publishes eligible
drafts. It does not select carousel Entities or produce their timelines. P0 does
not redesign publisher cadence, consolidation, or repetition handling.

### Feed shell

The Home section title remains `Feed`. Replace the current publisher-summary and
dummy framing with:

- a horizontal carousel of up to five hard-coded developing Stories
- three or four recent entity-linked Updates
- `Open full Feed`

The full `/feed` screen remains Feed and shows the complete entity-linked Update
stream ordered strictly by publication date. It does not display an Entity
timeline.

### Public contracts

```ts
interface BetaFeedStoryItem {
  storySlug: string
  name: string
  latestDevelopment: string
  eventCount: number
  updatedAt: string
}

interface BetaFeedUpdateItem {
  updateKey: string
  title: string
  summary: string
  publishedAt: string
}

interface BetaFeedDetail extends BetaFeedUpdateItem {
  content: string
}
```

The Story is a safe API projection of one Entity for P0, not the Entity row
itself and not a separate persisted Story domain. Unlinked legacy narratives do
not appear in the new Feed. Public categories are not rendered in P0.

### Entity carousel and memory timeline

P0 reuses the existing Entity Manager model instead of creating a duplicate
timeline table:

```sql
ALTER TABLE public.entities
  ADD COLUMN IF NOT EXISTS show_in_carousel boolean NOT NULL DEFAULT false;
```

Both Polymarket and news already use the same Entity extraction provider. Update
that shared instruction so every non-marker `entity_memories.summary` is a
standalone, neutral, one- or two-line description suitable for timeline display.
Deeper research remains in `body`, `evidence`, `metrics`, and `context`.

The Entity timeline is:

```text
entity_memories
  where entity_id = selected Entity
  and memory_type != source_marker
  order by event_at ascending
  return only summary and eventAt through the API mapping
```

There is no Editor or Publisher gate for the Entity timeline and no
`public_entity_timeline_events` table.

### P0 API

```text
GET /stories
GET /stories/:storySlug
GET /narratives, adapted as the entity-linked chronological Update stream
GET /narratives/:updateKey, the full published Feed item
```

`GET /stories` returns Entities where `show_in_carousel = true`, capped at five.
`GET /narratives` remains the separate Publisher-generated Feed, excludes rows
without an Entity link, and orders Updates by `published_at DESC` without
frontend ranking or categories. `GET /stories/:storySlug` returns the selected
Entity plus allowlisted timeline items mapped from its non-marker memories; it
never returns complete memory rows.

`GET /stories/:storySlug` returns:

```ts
interface BetaStoryDetailResponse {
  story: BetaFeedStoryItem
  events: Array<{
    text: string
    eventAt: string
  }>
}
```

Memories are returned oldest to newest. The API maps only `summary` and
`event_at`; raw rows, processing markers, body, internal reasoning, sources,
receipts, evidence, metrics, and context are not returned.

### US–Iran validation Story

US–Iran remains the required anchor Story. P0 must:

1. create the US–Iran Entity through the internal Entity workflow
2. research and backtrack roughly three to four months of key developments
3. produce a latest development and concise chronological timeline
4. attach one related Polymarket action for the context-to-action demo

The research must verify dates and claims internally before the automated public
copy is created. Public source or evidence display is not part of P0.

### Feature flag and rollback

Add a server-controlled beta Feed flag.

```text
enabled  -> mobile uses the Story carousel and entity-linked Update Feed
disabled -> mobile falls back to the legacy Feed
```

## P0 Workstream 2: Feed UX

### Home Feed preview

Home shows the horizontal Story carousel, three or four recent Updates, and
`Open full Feed`. Carousel Stories show the Story name and latest development.
The Update cards continue the current concise Feed-list approach.

### Full Feed

The full Feed is the complete chronological Update stream. It does not duplicate
the Story timeline and does not rank or group Updates by category.

### Story detail and Update navigation

Use a full screen, not the current article-like bottom sheet. Content order:

1. Story name
2. latest development
3. concise chronological timeline
4. one related market action, when present

Tapping a carousel Story opens its Story detail. Tapping a Feed Update opens the
full published Feed item. The Feed detail does not open or require the related
Story timeline. The market action remains a separate route.

The P0 screen does not include raw IDs, JSON, categories, sources, receipts,
evidence, confidence visualizations, related-entity graphs, editor reasoning,
Entity identity/background explanations, or long article text.

### Validation test

Before generalizing the component, show the US–Iran Story to five target users.

Success:

- after ten seconds, the user can explain what changed
- the user can identify what happened before
- the user can find the related market without guidance

If users cannot do this, revise the Story hierarchy before adding more timelines.

## P0 Workstream 3: Apps

Create one capability registry:

```ts
type AppCategory = 'prediction' | 'perps' | 'swap' | 'lp'
type AppStatus = 'live' | 'read_only' | 'hidden'

interface MarketAppDescriptor {
  id: string
  name: string
  category: AppCategory
  route: string
  status: AppStatus
  verifiedCapabilities: Array<
    'browse' | 'account' | 'deposit' | 'trade' | 'close' | 'withdraw'
  >
  limitation?: string
}
```

Render horizontal rows for non-empty categories. Only `live` and `read_only`
apps appear. A read-only app explains the limitation before transaction UI.

Rename the Home section from `Markets` to `Apps`.

Show a `Coming soon` tile for Orca, Raydium, and Kamino instead of removing
them outright — visible but explicitly non-interactive, so the roadmap stays
legible without overstating current capability. Meteora is excluded from this
treatment: it has a verified beta mobile route (pool browse, create position,
claim/add/remove/close) and renders at its actual, capability-registry-verified
status rather than a placeholder. Hide Swap until its real quote-to-transaction
lifecycle passes. Do not claim Hyperliquid or a third perps venue.

## P0 Workstream 4: Wallet

Superseded by
[`docs/modules/wallet/PRDs/2026_07_21_beta_readiness_wallet_PRD.md`](../modules/wallet/PRDs/2026_07_21_beta_readiness_wallet_PRD.md).
That PRD is the authoritative spec for this workstream; the summary below
exists only to keep this sprint document internally consistent and should
not be read as a separate or competing plan.

### A real combined total is now in scope for P0

P0 shows a genuine combined total (Solana spot + Meteora + Phoenix +
Pacifica), not only separate protocol account summaries. The total is shown
as soon as at least one source has loaded, and is visibly marked partial if
any source has not loaded successfully. Polymarket is excluded from the
total and row list for this phase and remains reachable only through its
existing `/predict-profile` path; Meteora is included instead.

```ts
type ProtocolAccountState =
  | 'loading'
  | 'ready'
  | 'empty'
  | 'stale'
  | 'unavailable'
  | 'setup_required'
  | 'access_required'
  | 'unsupported_wallet'
  | 'disconnected'

interface ProtocolAccountSummary {
  source: 'solana' | 'meteora' | 'pacifica' | 'phoenix'
  label: string
  identityLabel: string | null
  state: ProtocolAccountState
  valueUsd: number | null
  cashUsd: number | null
  positionCount: number | null
  asOf: string | null
  message: string | null
  route: string | null
}
```

Rules:

- unknown numbers remain `null`, never zero
- every loaded number has an `as of` time
- stale state retains the last known value and labels it stale
- unavailable state does not clear other protocol cards, and does not block
  the combined total from showing as partial
- each protocol identifies which address/account it represents
- retry is per protocol
- Phoenix and Pacifica report equity (collateral + unrealized PnL), not
  static collateral

### Home Wallet preview

Disconnected:

```text
Connect to see your accounts and positions
Feed and Apps remain available
```

Connected:

- show the real combined total, or its partial-total state
- show separate available account cards
- show top real positions only
- link to the full Wallet screen
- never show a fabricated total value or daily PnL

### Wallet screen

Show:

1. combined total (or partial-total state)
2. protocol account cards (Solana spot, Meteora, Phoenix, Pacifica)
3. setup, access, unsupported, stale, and retry states
4. links to current protocol-native profiles
5. Send, Receive, Deposit, Withdraw, and cross-protocol transfer as visible
   `Coming soon` entries

### Account drawer

Rename its product responsibility from wallet/portfolio to account utility.

Keep:

- identity and auth method
- connected address
- copy/export where supported
- feedback, support, privacy, deletion
- disconnect
- version read from application metadata

Remove:

- protocol balances
- protocol profile cards
- hard-coded Pacifica value
- hard-coded version

## P0 Workstream 5: One Controlled Transaction Lifecycle

Choose one lifecycle only after the Day-1 capability matrix.

The chosen lifecycle must cover:

```text
wallet capability check
protocol setup/funding state
amount and balance validation
venue and regional availability
risk and maximum-loss disclosure
explicit confirmation
pending state
success / rejection / failure
reconciliation after app resume or network timeout
position/account refresh
withdrawal or exit path
```

Other apps may remain useful for browsing or account reads. They do not need to
pretend to support execution.

Private-key export is not part of the normal journey. If retained in beta, it
requires re-authentication, explicit danger acknowledgement, no analytics or
screenshots, and a separate security review. Otherwise hide it for the first
cohort.

## P0 Workstream 6: Safety, Privacy, and Feedback

### Controlled cohort

The first beta is allowlisted. Real-money execution is enabled only for the
tested wallet/venue combination until lifecycle evidence supports expansion.

### Required disclosures

- myboon is non-custodial where applicable
- protocol terms and regional availability still apply
- market and leveraged trading can lose money
- prediction-market maximum loss is shown before confirmation
- myboon does not bypass venue restrictions

### Privacy and vendor inventory

Document data handled by:

- myboon API and Supabase
- Privy authentication/embedded wallets
- external Solana wallets
- Polymarket identity/session/account APIs
- Pacifica and Phoenix account APIs

The privacy policy names what is stored, why, retention period, and deletion
owner.

### Public pages

```text
https://myboon.tech/privacy
https://myboon.tech/support
https://myboon.tech/account-deletion
```

Account deletion must be an operational request channel with acknowledgement and
completion tracking, not only an information page.

### Feedback

Add `Send beta feedback` in the Account drawer and critical error states.

- no automatic screenshot
- no automatic wallet address, signature, or transaction payload
- diagnostics are opt-in and redacted
- app version and current screen may be included
- user receives a submission acknowledgement

### External links

- allowlist trusted source and protocol domains
- show the destination before leaving the app where appropriate
- never load an untrusted URL in a WebView

### Analytics

New analytics are deferred from P0 unless the privacy, retention, consent, and
deletion behavior is approved early enough to test. Manual beta observation and
feedback are sufficient for the Alliance sprint.

## Database and Security Gate

The checked-in migrations already contain an RLS enablement statement for
`published_narratives`, while the live database reports RLS disabled. Treat this
as migration drift.

Before release:

1. compare applied migrations with the repository
2. inspect live grants and policies
3. repair drift through a reviewed migration
4. confirm the mobile client reads through the myboon API
5. verify anon/authenticated roles cannot mutate public content tables

Do not treat a repeated `ENABLE ROW LEVEL SECURITY` statement as a complete
explanation of the drift.

`entities` and `entity_memories` remain service-role-only. The mobile API may map
only the carousel Entity fields and each memory's `summary` and `event_at`; it
must never serialize a complete Entity memory row.

## P0 Workstream 7: Alliance and Conditional dApp Store Package

### Alliance submission by July 22

Required:

- one-sentence positioning
- problem and product explanation
- why Solana Mobile matters
- honest four-month build record
- current stage and risks
- 60–90 second demo of the exact working beta journey
- next 30-day plan
- founder story and solo-founder execution evidence

Do not wait for dApp Store approval before submitting Alliance.

### dApp Store package

Prepare:

- release-signed APK
- final icon, adaptive icon, splash, and app name
- short and long descriptions
- screenshots of Feed, Apps, and Wallet
- privacy, support, and deletion URLs
- publisher account and KYC/KYB
- recoverable publisher wallet with required SOL
- reviewed Publisher Policy and Developer Agreement

Submit only when all release gates below are green. “Package prepared” and “store
submitted” are different milestones.

## Feed Issue Plan

1. **Entity carousel and memory timeline foundation** — add the Entity carousel
   flag and make shared Entity memory summaries concise enough for direct
   chronological display.
2. **Beta crypto news sources** — ingest the blended structured article/social
   feed, then use the existing Researcher and Entity Manager path without
   changing Editor or Publisher behavior.
3. **Publisher and Feed APIs** — preserve the independent cron publishing model
   while serving the Entity carousel, memory timelines, and Feed Updates.
4. **Home and full Feed experience** — build the up-to-five-Story carousel,
   recent Home Updates, full date-ordered Feed, and legacy-content exclusion.
5. **Story detail and navigation** — show the latest development and chronological
   timeline, while Feed Updates open their own full published detail.
6. **Related actions** — attach optional market actions and support the
   Story-to-action beta demonstration.
7. **US–Iran Entity and beta Story content** — perform the targeted US–Iran
   Entity creation and historical research, then prepare up to four additional
   carousel Stories.
8. **Feed reliability and rollout** — handle loading, empty and failure states,
   switch to the new Feed, and retain a safe fallback.
9. **Testing and beta validation** — test the pipeline, APIs, mobile journey, date
   ordering, timelines, actions, and user comprehension.

## P0 Sprint Order

### Day 1: Release and capability truth

- build, sign, install, and launch the current APK
- fix current TypeScript failures
- verify HTTPS
- repair missing release assets and version truth
- create the device capability matrix
- select the one transaction lifecycle

### Days 2–5: Feed vertical slice

- create the US–Iran Entity for the beta content work using the existing Entity
  Manager store/resolution patterns; do not build a generic manual Entity tool
- backtrack roughly three to four months of key US–Iran developments
- add `entities.show_in_carousel` and update the shared Entity Manager summary
  contract used by both Polymarket and news
- define Entity timelines as non-marker memories ordered by `event_at`
- preserve the existing Editor and Publisher behavior and cadence
- build the hard-coded carousel of up to five Stories and three or four Home
  Updates
- keep the full Feed as the complete date-ordered entity-linked Update stream
- build and test the compact Story detail and Update-to-Story navigation
- add feature-flag fallback to the legacy Feed

### Days 6–7: Apps and Wallet truth

- categorize Apps from the capability matrix
- hide dead and unverified tiles
- remove all fabricated Home and drawer values
- show separate live protocol account cards and states
- move protocol profiles out of the Account drawer

### Days 8–9: Controlled lifecycle and compliance

- verify the chosen transaction lifecycle end to end
- add risk, restriction, timeout, and reconciliation states
- publish privacy, support, deletion, and feedback paths
- audit live RLS/grants and APK secrets

### Days 10–11: Validation and assets

- test on target Android/Seeker device
- run five-user Story comprehension check
- resolve critical crashes and money-state errors
- build the signed beta candidate
- create screenshots and record the exact product demo

### Day 12: Alliance submission and release decision

- submit Alliance application
- invite the controlled beta cohort
- submit to the dApp Store only if every release gate passes
- otherwise record blockers and finish the store package in P1

## P0 Scope

Expected files to create or modify:

- `supabase/migrations/<timestamp>_entity_carousel_flag.sql` — add
  `entities.show_in_carousel` with a default of false and a selected-Entity index.
- `packages/collectors/src/entity-manager/` — reuse existing store/resolution
  patterns for the targeted US–Iran Entity creation in the beta-content issue;
  no generic manual editor is required for P0.
- `packages/collectors/src/entity-manager/types.ts` — include the carousel flag in
  the Entity contract.
- `packages/collectors/src/entity-manager/supabase-store.ts` — read and update the
  carousel flag.
- `packages/collectors/src/entity-manager/extractor.ts` — make the shared memory
  summary neutral, standalone, concise, and UI-readable for both source paths.
- `packages/collectors/src/entity-manager/normalization.ts` — enforce the shared
  summary contract.
- `packages/api/src/stories.ts` — beta Story list/detail and feature flag.
- `packages/api/src/stories.test.ts` — carousel selection, timeline ordering,
  internal-field exclusion, and fallback tests.
- `packages/api/src/index.ts` — mount Story routes and restrict the new Feed to
  entity-linked narratives ordered by date.
- `apps/hybrid-expo/app/stories/[entitySlug].tsx` — compact Story detail route.
- `apps/hybrid-expo/app/wallet.tsx` — protocol account and position route.
- `apps/hybrid-expo/app/_layout.tsx` — register Story and Wallet routes.
- `apps/hybrid-expo/features/feed/feed.types.ts` — beta Story and Update contracts.
- `apps/hybrid-expo/features/feed/feed.api.ts` — Story carousel, Story detail, and
  chronological Update reads with fallback.
- `apps/hybrid-expo/features/feed/FeedScreen.tsx` — full chronological Update Feed.
- `apps/hybrid-expo/features/feed/components/StoryCarousel.tsx` — hard-coded
  carousel of up to five Story projections.
- `apps/hybrid-expo/features/feed/components/FeedCard.tsx` — concise entity-linked
  Update card.
- `apps/hybrid-expo/features/feed/components/StoryTimeline.tsx` — compact public
  timeline without public source/evidence UI.
- `apps/hybrid-expo/features/home/HomeScreen.tsx` — Feed -> Apps -> Wallet,
  Story carousel, three or four recent Updates, removal of dummy content, and
  live states.
- `apps/hybrid-expo/features/home/marketApps.registry.ts` — device-verified app
  capability registry.
- `apps/hybrid-expo/features/wallet/wallet.types.ts` — protocol account states.
- `apps/hybrid-expo/features/wallet/useProtocolAccounts.ts` — independent live
  protocol reads (Solana spot, Meteora, Phoenix, Pacifica) with
  null/stale/error semantics, plus the combined/partial total.
- `apps/hybrid-expo/features/wallet/WalletScreen.tsx` — combined total, protocol
  cards, and `Coming soon` wallet-activity entries.
- `apps/hybrid-expo/components/drawer/WalletDrawer.tsx` — account-only utility or
  rename to `AccountDrawer.tsx`.
- `apps/hybrid-expo/app.json` — release assets, version, and HTTPS-only traffic.
- `apps/hybrid-expo/eas.json` — verified signed APK profile.
- `apps/hybrid-expo/e2e/beta-journey.spec.ts` — Feed -> Story -> chosen Action ->
  account/position refresh.
- `apps/web/src/app/privacy/page.tsx` — privacy page.
- `apps/web/src/app/support/page.tsx` — support and feedback.
- `apps/web/src/app/account-deletion/page.tsx` — verified deletion request entry.
- `docs/PRDs/beta readiness sprint PRD.md` — this PRD.

This is still an aggressive solo sprint. If Day-1 release truth or the Feed
vertical slice slips, defer the full Wallet screen before compromising release
safety, fabricated-state removal, or the Alliance demo.

## Release Gates

### Product gate

- Home visibly remains `Feed -> Apps -> Wallet`.
- Home shows a hard-coded carousel of up to five real Stories and three or four
  recent Updates.
- the full Feed contains only entity-linked Updates ordered by publication date.
- US–Iran shows its latest development and a concise chronological history.
- one US–Iran related action demonstrates the context-to-action path; other
  Updates do not require actions.
- five target users understand what changed and what came before within ten
  seconds.
- no fabricated balance, PnL, position, signal, venue, or version is visible.
- no dead or unverified app tile is visible.

### Transaction gate

- one wallet/venue lifecycle passes on the target Android device
- setup/funding, confirmation, pending, resume/timeout reconciliation, refreshed
  state, and exit/withdraw path are verified
- unsupported wallets and restricted venues never show an enabled transaction
  action
- no unresolved critical money-state defect remains

### Release gate

- mobile TypeScript check passes
- automated Story API and beta-journey tests pass
- release APK builds with a recoverable signing key
- APK installs and launches on target device
- production traffic is HTTPS-only
- package name, version, icon, adaptive icon, and splash are correct
- APK secret scan is clean
- server feature flag can restore the legacy Feed

### Security and compliance gate

- live RLS drift is understood and repaired
- raw Entity memories, source receipts, research notes, and internal provenance
  do not reach the mobile API
- the new Feed can be disabled server-side without an APK release
- privacy and vendor inventory match actual behavior
- support and deletion requests are operational and acknowledged
- risk, regional, and third-party protocol disclosures are visible
- feedback never captures sensitive data or screenshots automatically

### Distribution gate

- Alliance demo matches the submitted APK exactly
- Alliance application contains no unverified capability claim
- dApp Store listing assets match the release build
- publisher account, KYC/KYB, and publisher wallet are ready
- dApp Store submission occurs only if all prior gates pass

## Acceptance Criteria

- [ ] The top-level product hierarchy and visible Home order are Feed, Apps,
      Wallet.
- [ ] Story remains an item within Feed and does not replace Feed in navigation.
- [ ] Home shows up to five hard-coded carousel Stories, three or four recent
      Updates, and `Open full Feed`.
- [ ] The full Feed is a complete entity-linked Update stream ordered strictly by
      publication date.
- [ ] Every Update opens its full published Feed detail.
- [ ] Story detail shows the Story name, latest development, concise chronological
      timeline, and an optional related action.
- [ ] Carousel membership is controlled only by
      `entities.show_in_carousel = true` and is capped at five by the API.
- [ ] Both Polymarket and news use the shared Entity Manager summary contract.
- [ ] Story timelines contain all non-marker memories for the Entity, ordered by
      `event_at`, and expose only mapped text and date fields.
- [ ] The US–Iran Entity is created through the internal workflow and its timeline
      backtracks roughly three to four months of internally verified research.
- [ ] At least one US–Iran action demonstrates the context-to-action journey;
      actions are not required for every Update.
- [ ] Complete Entity memory rows, bodies, evidence, metrics, context, editor
      reasoning, diagnostics, prompts, raw JSON, and internal identifiers never
      reach the mobile response.
- [ ] Sources, receipts, evidence, categories, and Entity identity/background
      descriptions do not appear in the P0 Feed UI.
- [ ] Unlinked legacy narratives do not appear in the new Feed.
- [ ] The existing editor-draft -> publisher-cron -> published-narrative model and
      cadence remain intact.
- [ ] Publisher remains a separate consumer and does not control carousel
      membership or the Entity memory timeline.
- [ ] No duplicate public timeline table is created.
- [ ] The new Feed can be disabled server-side, restoring the legacy Feed.
- [ ] Apps render from the device-verified capability registry.
- [ ] Swap, third perps, other LP apps (Orca, Raydium, Kamino, shown as
      `Coming soon`), and unverified Phoenix actions are hidden. Meteora is
      the sole LP app exception and renders at its verified beta lifecycle.
- [ ] Home and Account drawer contain no hard-coded financial or version data.
- [ ] Wallet shows a real combined total (Solana spot + Meteora + Phoenix +
      Pacifica), visibly partial when a source has not loaded, plus separate
      protocol account cards with identity, state, and `as of` time; unknown
      values are `Unavailable`/`null`, never `$0`.
- [ ] Polymarket is excluded from the Wallet combined total and row list.
- [ ] Embedded, external, unsupported, setup-required, access-required, expired,
      stale, unavailable, and disconnected states have explicit behavior.
- [ ] Exactly one controlled transaction lifecycle is required for P0; all other
      visible capabilities are labelled honestly.
- [ ] The chosen lifecycle reconciles after app resume and network timeout.
- [ ] Privacy, support, feedback, and verified deletion-request paths are live.
- [ ] Mobile TypeScript, Story API tests, and beta journey tests pass.
- [ ] The release APK installs on target device, uses HTTPS only, and contains no
      private or internal credentials.
- [ ] Five target users pass the compact Story comprehension test.
- [ ] The Alliance demo shows the exact working APK journey.
- [ ] Store submission is recorded separately from store-package preparation.

## Open Decisions Before Implementation

1. Which up to four additional Stories join US–Iran in the hard-coded carousel?
2. Which wallet/venue combination is the single controlled transaction
   lifecycle after the Day-1 device matrix?
3. Is Phoenix useful enough as verified read-only value, or should it be hidden?
4. Which Solana balances, if any, are shown before USD valuation is proven?
5. Where do feedback and deletion requests go, who owns them, and what is the
   promised response time?
6. Is private-key export hidden for the first cohort or retained after a separate
   review?
7. Who are the five target users for the Story comprehension test?

## References

- `docs/VISION.md`
- `docs/FEED.md`
- `docs/markets.md`
- `docs/PRDs/entity memory browser PRD.md`
- `docs/marketing/beta-discovery-plan.md`
- `docs/mockups/home-no-tabs-codex-v2.html`
- Alliance ALL18 application: <https://alliance.xyz/apply>
- Solana dApp Store submission guide:
  <https://docs.solanamobile.com/dapp-store/submit-new-app>
- Solana Mobile Publisher Policy:
  <https://docs.solanamobile.com/dapp-store/publisher-policy>
