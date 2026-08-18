# Structured News Feed Ingestion PRD

Status: implemented, legacy scout removed
Created: 2026-08-13
Updated: 2026-08-18
Owner: myboon pipeline
Module: news / entity-manager
Review branch: `codex/structured-news-feed`

## Purpose

Replace the expensive Hermes browser-based news discovery step with a
structured news feed, while keeping temporary news working state local and
leaving durable entity-memory storage unchanged.

The change is deliberately narrow:

```text
structured news-feed ingestion
  -> existing candidate normalization and dedupe
  -> existing NewsStore
  -> existing Hermes research
  -> existing entity-manager pipeline
```

The structured feed is the only news-discovery path. Hermes remains in the
research and entity-manager stages, where source reading and synthesis are
still required.

## Locked Decisions

- The feed integration itself is logic-only.
- No SQLite schema changes or local storage-location changes.
- No Supabase entity/publishing schema, credential, or storage-location changes.
- Disposable working rows are not migrated between SQLite and Supabase. The
  obsolete Supabase copies are removed after the local cutover.
- No entity-memory schema changes; source media and story provenance are
  retained in the existing memory `context` JSON.
- No Polymarket changes.
- Fetch the blended provider feed with `source=all` and keep both articles
  and posts.
- Keep all CoinGecko-backed article outlets returned by the provider.
- The X portion is the `@tokens` account, not a general X search.
- Continue using the existing researcher and entity manager.
- Entity Manager owns final same-story reconciliation. It performs this inside
  the existing extraction call, not through another LLM call.
- Remove the former browser-based source scout and its rollback modes after the
  successful soak and isolated pipeline validation.
- Treat `related_coin_ids` as untrusted hints, never as final entity identity.

## Out of Scope

- New durable database tables, columns, statuses, or retention policies.
- Moving final entity or publishing data out of Supabase.
- Embedding-based, cross-entity, or unbounded historical story clustering.
- New language or promotional-content filters.
- A new research budget or ranking system.
- Replacing Hermes research.
- Replacing entity extraction or adding another reconciliation LLM call.
- Rendering images in the mobile UI or mirroring remote images into owned
  object storage.
- Polymarket changes.

Those can be considered later as separate improvements. They must not be
bundled into this integration.

## Existing Storage Contract

The `NewsStore` interface remains the persistence boundary used by the
news-feed ingestor, researcher, and entity-manager adapter. Production uses its
local `SqliteNewsStore` implementation; the retired Supabase implementation and
its alternate worker entrypoints are removed.

Neither news working-store schema changed:

- candidate observations keep the existing statuses;
- research results keep the existing statuses;
- entity memory continues through the existing entity store;
- provider-specific provenance is retained inside the existing `raw_candidate`
  JSON, not in new columns.

The news-feed ingestor does not create source-run rows. Feed observations keep
the already-supported nullable `sourceRunId` field as `null`; the local SQLite
table and column remain intact.

The entity-memory store adds one bounded read operation for recent memories. It
queries the already-existing `entity_memories` rows by entity and
`observed_at`; it does not add or alter persistence structures.

### Retired Supabase scaffolding

After the SQLite storage boundary was verified, the superseded remote working
tables and their dead code paths were removed. Migration
`20260818113845_drop_retired_pipeline_tables.sql` drops exactly:

```text
news_research_results
news_candidate_observations
news_source_runs
polymarket_market_editor_decisions
polymarket_market_candidate_research
polymarket_market_candidates
polymarket_market_watchlist
editor_drafts
```

The migration deliberately does not use `CASCADE`: an unexpected dependency
must fail and roll back the migration instead of deleting a kept object. It
does not touch `entities`, `entity_memories`, `published_narratives`,
`entity_published_history`, `pipeline_runs`, catalog tables, Hyperliquid tables,
`pacific_tracked`, migration history, or unrelated application tables.

The same logical news table names continue inside `news.sqlite`; deleting the
obsolete Supabase tables does not delete or migrate local queued work.

## Service Client

The canonical client now lives in the neutral shared package so both API and
collectors can use one implementation without creating an API/collector package
cycle.

Canonical module:

```text
@myboon/shared/news-feed
```

The neutral API facade at `packages/api/src/news-feed/client.ts` re-exports the
shared implementation and types. The former provider-named module under
`packages/api/src/tokens/` is removed as part of the naming cleanup.

### Client behavior

- `fetchFeed()` sends `source=all`.
- `fetchArticles()` sends `source=news`.
- `fetchPosts()` sends `source=tweets`.
- Requests use `x-api-key: TOKENS_API_KEY`.
- The limit is clamped to the upstream range of 1–50.
- The collector explicitly requests `limit=50`.
- Missing API keys fail loudly.
- Non-429 4xx responses do not retry.
- 429, 5xx, and network failures retry twice with bounded backoff.
- Requests time out after ten seconds per attempt.
- Timestamps normalize to ISO strings or `null`.
- Unknown feed-source kinds and items without a usable title/text or URL are
  dropped safely.
- `NEWS_FEED_API_BASE` accepts either a host root or a base already ending in
  `/v1`.

## Collection Mapping

Both content kinds enter the neutral `NewsCandidate` shape. No Hermes process
is called by the news-feed ingestor.

### Articles

```text
sourceId                = news_feed:articles
sourceName              = actual upstream outlet, or "Structured News Feed"
headline                = article.title
article_url             = article.url
published_at            = article.publishedAt
author                  = article.author
content_kind            = article
upstream_source_name    = article.outlet
image_url               = article.imageUrl
related_coin_ids        = article.relatedCoinIds (untrusted)
```

### Posts

```text
sourceId                = news_feed:social
sourceName              = post.handle, or "@tokens"
headline                = post.text
article_url             = post.url
published_at            = post.postedAt
author                  = post.handle
section                 = social_post
content_kind            = social_post
upstream_source_name    = post.handle
image_url               = post.imageUrl
related_coin_ids        = post.relatedCoinIds (untrusted)
```

The existing storage columns still use article-oriented names such as
`article_url`; changing them would violate the storage constraint. The logical
kind is therefore preserved in `raw_candidate.content_kind` and carried into
research/entity adaptation.

## Shared Ingestion and Dedupe

Discovery and persistence are separated by a provider-neutral ingestion helper.
Structured-feed items use the existing logic for:

- canonical URL normalization;
- tracking-parameter removal;
- fingerprint creation;
- prior-observation lookup;
- unchanged classification;
- candidate insertion.

Feed items use a stable-URL identity policy because the provider can return the
same canonical article more than once with translated headlines, syndication
prefixes, or later metadata/image changes. For the structured feed:

- one source ID plus canonical URL represents one research identity;
- duplicates within the same fetch are collapsed before persistence;
- the preferred variant favors a valid headline, content image, summary, and an
  English-first/unprefixed headline when those variants are available;
- a later cosmetic headline, language, summary, or image change is classified as
  unchanged and does not create another research job.

Dedupe remains source-scoped between article and social-feed lanes.

## Permanent Runtime

There is no collection-mode or rollback switch. The processes have single
responsibilities:

```text
news-feed ingestor -> fetch, normalize, dedupe, persist
news researcher    -> recover stale research work and run Hermes research
entity manager     -> entity resolution, story reconciliation, memory writes
```

- the news-feed ingestor persists new observations through the existing
  `NewsStore`;
- the news researcher performs stale-work recovery and bounded concurrent
  pending research;
- the news researcher can issue only `source_aware_research` work;
- existing entity-manager entrypoints continue unchanged.

## Cadence and Process Separation

The upstream exposes a live window with no cursor or history. The news-feed
ingestor therefore defaults to ten minutes:

```text
NEWS_FEED_INTERVAL_MS=600000
```

The collector starts immediately and uses the existing overlap-guarded interval
runner. Collection is a separate process from research, so a slow Hermes
research call cannot delay the next feed fetch.

The research process is permanently research-only. One PM2 process owns two
internal Hermes lanes and claims at most ten candidates per cycle:

```text
NEWS_RESEARCHER_BATCH_SIZE=10
NEWS_RESEARCHER_CONCURRENCY=2
```

Each candidate transitions from `pending_research` to `research_queued` only
when a transactional status check succeeds. SQLite uses an immediate
transaction, so concurrent lanes or an accidental second process cannot
research the same row. Queued and researching rows share the existing
stale-work recovery path. Runtime concurrency is hard-capped at four even if
the environment is misconfigured.

Every completed cycle reports pending count and oldest pending age. PM2 emits a
warning when either configured threshold is reached:

```text
NEWS_RESEARCH_BACKLOG_WARN_COUNT=20
NEWS_RESEARCH_BACKLOG_WARN_AGE_MS=3600000
```

## Research Contract

The research system remains Hermes-based. The request explicitly carries:

```text
content_kind
upstream_source_name
image_url
untrusted_related_coin_ids
```

The prompt tells the researcher that the source may be an article or social
post, and that related coin IDs are weak search hints rather than verified
identity.

The existing research output continues separating:

- source claims;
- verified facts;
- unresolved claims;
- evidence;
- entity hints;
- limitations and open questions.

## Entity-Manager Handoff

The existing entity manager still owns final entity selection and memory writes.
The researcher provides context and hints; it does not choose the durable home.

Content kind is preserved when research becomes a `ResearchPacket`:

```text
article     -> packet.sourceType = article     -> default memory = news_event
social_post -> packet.sourceType = social_post -> default memory = social_signal
```

The upstream outlet/handle, image URL, provider provenance, and untrusted coin
IDs remain available in packet context. The resolver deterministically copies
trusted media into every entity-bound memory after extraction, so the LLM
cannot drop or replace it:

```text
context.image_url          validated http(s) URL or null
context.image_kind         content | source_avatar | null
context.image_origin       technical provider provenance or null
context.image_attribution  upstream outlet or handle, or null
```

When the upstream image is absent or unsafe, all four media fields are cleared
after extraction. Public Story APIs also require a valid HTTP(S) image URL
before exposing kind or attribution, providing a second deterministic guard
against extraction-authored provenance.

The editor and publisher already receive full entity-memory context. The Story
and narrative Feed APIs expose the same media as `imageUrl`, `imageKind`, and
`imageAttribution`; narrative enrichment follows existing `source_memory_ids`
and prefers a content image over an avatar. Remote images are not downloaded or
copied in this phase.

### Entity-owned story reconciliation

Canonical-URL dedupe prevents the same feed URL from being researched twice,
but it cannot recognize two publishers covering one underlying event. Entity
Manager closes that later-stage gap, after research has supplied enough context
and after the deterministic shortlist has identified plausible entities.

For news packets only, Entity Manager reads at most 30 recent news memories for
the shortlisted entity IDs within the 48 hours ending at the packet's
`observedAt`. A compact form—memory ID, entity, type, title, summary, timing,
source, and source URL—is added to the existing extraction prompt. Bodies and
the full historical catalog are not added, keeping the token cost bounded.

The existing extraction call classifies every proposed memory as:

```text
new_story             -> insert a new entity-memory row
update_existing_story -> update the named existing row with material new facts
duplicate_source      -> keep the existing story content and attach the new source
```

An automatic update requires all of the following:

- the named memory ID was supplied in the 48-hour prompt context;
- the named memory belongs to the same resolved entity;
- reconciliation confidence is at least `0.8`;
- the named memory is not the same packet being replayed.

If any condition fails—or if the recent-memory read fails—the resolver fails
open to the normal new-memory/idempotency path. Similar entity, topic, theme,
or market direction alone is explicitly insufficient for a merge.

For `update_existing_story`, the existing row keeps its stable identity while
summary/body/metrics are refreshed and evidence is merged. For
`duplicate_source`, canonical story text is preserved. Both actions retain all
source URLs, source research IDs, image URLs, reconciliation reasons, and
timestamps under bounded/auditable `context.story_sources` and
`context.reconciliation_history` data. This keeps one downstream story while
preserving the raw research trail and every publisher's evidence.

## Local Commands

Run one collection into the existing local news store:

```bash
NEWS_FEED_RUN_ONCE=1 \
pnpm --filter @myboon/collectors news:feed:ingest
```

Run the researcher:

```bash
pnpm --filter @myboon/collectors news:research
```

Run the existing news entity-manager command:

```bash
pnpm --filter @myboon/collectors entity-manager:news
```

The dotenv chain is loaded by every news worker. `TOKENS_API_KEY` is the single
canonical Tokens.xyz credential, and `NEWS_SQLITE_PATH` selects their shared
working database (default: `packages/collectors/.data/news.sqlite`).

## Verification

Automated coverage proves:

- the shared client passes the complete API client test suite;
- mixed article/post order and normalization remain correct;
- collection stores both kinds through the existing store contract;
- replaying the same feed creates no duplicate observations;
- same-batch translated/syndicated variants of one canonical feed URL collapse
  to the preferred candidate and create one research job;
- later cosmetic feed metadata changes for an existing canonical URL do not
  create another research job;
- tracking parameters are removed by the existing canonicalizer;
- feed ingestion makes no Hermes call;
- news research makes only `source_aware_research` calls;
- two research lanes never exceed configured concurrency and claim distinct
  candidate rows;
- stale queued work is recoverable and every cycle exposes backlog count, age,
  and warning state;
- articles remain `article`/`news_event` downstream;
- posts remain `social_post`/`social_signal` downstream;
- recent entity memories are supplied to the existing extraction call without
  adding another Hermes call;
- the two-publisher CLARITY Act regression collapses to one entity-memory row
  while retaining both sources;
- exact-threshold reconciliation succeeds, while low-confidence, wrong-entity,
  unlisted/stale-ID, and packet-replay attempts do not merge;
- the exact 48-hour boundary is included, older memories are excluded, and a
  recent-memory read failure fails open;
- invalid or absent upstream media clears all extraction-authored provenance,
  and public Story APIs expose no image metadata without a valid URL;
- collectors and shared packages compile.

Primary commands:

```bash
pnpm --filter @myboon/api test:news-feed
pnpm --filter @myboon/collectors test:news
pnpm --filter @myboon/collectors test:entity-manager
pnpm --filter @myboon/collectors build
pnpm --filter @myboon/shared build
git diff --check
```

### Local soak and bounded research validation (2026-08-16)

An approximately 15-hour local ingestion soak produced 310 candidate
observations: 304 articles and 6 social posts. All 310 retained provider
provenance, 299 retained a valid HTTP(S) image URL, and SQLite integrity passed.
The pre-fix dataset exposed 12 repeated canonical-identity groups: seven later
metadata/headline variants and five same-fetch translated/syndicated variants.
Those observations motivated and are covered by the stable-URL feed policy
described above.

A five-item Hermes sample was then run against an isolated copy of the soak
database, containing one social post and four articles. All five completed as
`ready_for_entity_memory`, with zero research failures and zero JSON-validation
failures. The entity-manager adapter retained content kind, image URL, provider
provenance, upstream source name, evidence, and entity hints for every item. The
sample averaged about 257 seconds per research item (about 21.4 minutes total),
while the soak averaged about 20.7 new candidates per hour. One sequential lane
could therefore process at most about 14 items per hour and would accumulate a
permanent backlog. Two bounded lanes processing ten candidates per cycle raise
the measured-rate estimate to about 24 items per hour under the existing
five-minute overlap-guarded schedule. Backlog count/age warnings remain required
because real VPS latency and memory pressure can reduce that margin. The
original soak database was not used for research and remained unchanged.

## Acceptance Criteria

1. The canonical client is shared without duplicating implementation.
2. The API exposes a neutral news-feed facade backed by the shared client, and
   the provider-named API module is removed.
3. The collector requests `source=all, limit=50`.
4. Both articles and posts map into the existing candidate/store contract.
5. Actual article outlet or post handle remains attributable.
6. `related_coin_ids` remains explicitly untrusted.
7. The news-feed ingestor performs zero Hermes calls.
8. Collection uses existing canonicalization and persistence with stable-URL
   identity.
9. Replaying an unchanged item, a translated/syndicated same-URL variant, or a
   cosmetic metadata update does not create another research job.
10. The news worker type cannot represent or launch a discovery task.
11. Existing Hermes research remains unchanged; the existing entity-extraction
    call also performs bounded recent-story reconciliation without another LLM
    call.
12. Social posts become `social_signal`, not `news_event`.
13. Entity Manager merges only a supplied same-entity memory ID at confidence
    `>= 0.8`; uncertain, missing, stale, or wrong-entity matches fail open to a
    separate memory.
14. Duplicate/update merges preserve every publisher URL, evidence item, source
    research ID, and available image in existing JSON context.
15. The SQLite queue schemas and durable Supabase entity/publishing schemas do
    not change; the only Supabase schema change is the forward migration that
    removes the eight explicitly retired temporary pipeline tables.
16. Feed/API image fields come from durable entity-memory context, never from
   LLM-authored media; unsafe or absent URLs clear URL, kind, origin, and
   attribution, and public APIs expose no partial media metadata.
17. Research claims are unique across concurrent workers, default concurrency
   is two with ten candidates per cycle, and queued work is crash-recoverable.
18. Every research cycle reports pending count and oldest age and emits a PM2
   warning when the configured count or age threshold is reached.

## Cutover Checklist

1. Run one article/post collection against the intended existing store.
2. Run research and confirm every Hermes call is `source_aware_research`.
3. Run the existing news entity manager and inspect one article memory and one
   social memory.
4. Confirm replay does not duplicate observations, research, or memory.
5. Send two recent articles about one event through Entity Manager and confirm
   one memory row retains both entries in `context.story_sources`.
6. Send two distinct events about the same entity and confirm they remain two
   memory rows.
7. Update the deployed process commands so the collector and researcher use the
   same already-existing store implementation.
8. Remove the former scout modules, preview command, source configuration,
   rollout modes, and deployment references.
9. Confirm two Hermes lanes stay inside VPS CPU/memory limits and that backlog
   count and oldest age decline over multiple production cycles.
10. Apply the retirement migration only after all deployed news workers use the
    same local `NEWS_SQLITE_PATH` and the Polymarket/editor workers use
    `pipeline.sqlite`.

PM2 starts the SQLite-backed feed ingestor and research-only worker as separate
processes. The one research process owns the bounded two-lane pool. News
candidates, deduplication, research, statuses, and queues remain in
`news.sqlite`; only final entity records cross the Supabase boundary.
