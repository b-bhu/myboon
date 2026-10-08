# Entity Manager V4 — Working PRD

Updated: 8 October 2026 (UTC).

Issue: [#299 — Entity Manager V4](https://github.com/b-bhu/myboon/issues/299).

Status: the News article checkpoint is implemented, but hosted database unavailability has stopped live progress. The [8 October outage record](../operations/2026_10_08_database_outage_recovery.md) records dependency checks, queue protections and the remaining live recovery requirement. The [7 October recovery record](../operations/2026_10_07_article_pipeline_recovery.md) retains the earlier input, URL, duplicate and paid-outcome validation. The [checkpoint handoff](../operations/2026_10_05_v4_entity_manager_checkpoint_handoff.md) records the boundary and remaining work.

This is the current specification. It replaces the earlier claim/evidence requirements for new articles. The [pre-checkpoint PRD snapshot](2026_10_05_v4_prd_pre_checkpoint_snapshot.md) preserves the original issue mapping, earlier contracts and dated implementation/authorization history. Historical validation results apply to the contract and date they tested.

## 1. Scope and checkpoint boundary

**Scout → Intake → Researcher → Entity Manager → private durable entity knowledge.**

The product goal is to organise incoming articles, signals and events into useful chronological entity histories. Preserve what happened, where it belongs, its source and its relationship to earlier developments.

The checkpoint ends when Entity Manager has committed one shared item or an explicit duplicate/source-attachment outcome, with a durable receipt, or retained an actionable hold/failure. It does not end at model output alone.

**All downstream integration is outside #299's current scope and is not a checkpoint requirement.** No production knowledge-reader framework, consumer adapter/checkpoint, V1 projection, API/UI, Editor, Publisher or X Desk integration is included. Researcher's internal catalogue/history lookup and Entity Manager's identity/reference validation are part of this pipeline.

Also excluded: new collectors, deep research or web-search activation, automatic entity merging, broad ontology expansion, historical bulk replay/rewrite/deletion and automatic deferred-signal reconsideration. Polymarket collection runs separately; its Research and Entity processing remain disabled.

## 2. Required pipeline behaviour

### Scout and Intake

1. Preserve source identity, title, original URL, publication time when available and observation time. Deliver the observation reliably, including recovery of an earlier unsuccessful delivery.
2. Save the intake decision together with its required work or a durable acknowledged delivery obligation. Re-delivery must not create another logical job.
3. Obtain and retain the captured article text. Research operates on this capture, not the headline alone. Fetching the supplied source URL is not a web search.

### Researcher, in sequence

1. Validate that the captured article and its provenance are available; retain an explicit failure when they are missing, unsafe, incomplete or outside admission limits.
2. Retrieve entity candidates using names, aliases, summaries and scope metadata; rank exact/relevant identities before the 32-candidate bound. Include narrative and asset candidates, not only organisations or countries named in the headline.
3. Ask **Jev** to select one primary entity and independently judge meaningful related memberships. Preserve typed choices, probabilities, confidence and decision identity/version. Required article decisions use Jev; Hermes is not their semantic fallback.
4. If no entity matches, perform bounded wider catalogue lookup. A remaining no-match can request a source-grounded entity proposal from Hermes. Check its exact name/aliases across public and private identities before admitting creation; Jev must confirm an existing identity when found, or validate a genuinely new proposal. Incomplete or ambiguous identity coverage, uncertain decisions and rejected proposals remain explicit holds/failures.
5. Retrieve **up to the latest five items per selected entity**, from supported legacy and private history. Load history only for selected entities; preserve item IDs and storage origins. Separate targeted older-item lookup and source idempotency protect against duplicates outside the five-item window.
6. Ask Jev for novelty and story relationships: `duplicate`, `direct_continuation`, `related_story_branch`, `same_topic_only`, `unrelated` or `uncertain`. Choose the relationship and its supplied item/origin together; a continuation or branch cannot be offered without a valid target. One bounded Jev reconciliation may resolve a primary duplicate versus new-information conflict; unresolved cases remain held. Already-known requires one primary exact target. Related exact matches can remain contextual history without competing for that shared reuse effect. Raw probabilities are internal data, not prose.
7. **Researcher uses Hermes to write** the development's title, contextual `timelineSummary` and optional body from the article, selected entity scope and connected history. Describe what happened with natural source attribution; do not invent causes, resolutions or event dates.
8. Save and hand off the article packet, prepared memberships, historical references, source capture, dates and Research-owned readiness outcome. Saved decisions/results are reused on recovery where their identity remains valid.

Researcher does not produce new formal claim arrays, verified-fact dossiers, evidence tuples or claim-to-evidence edges. Internal retrieval storage still uses some legacy `evidence` names for captured source material; those names do not reinstate claim-verification requirements.

### Entity Manager

1. Check for an already accepted receipt before attempting another effect.
2. Validate the prepared packet, active entity identities and exact historical references. Entity Manager consumes Researcher's placement and prose; the article path has no second freeform model planner.
3. Validate new-entity proposals against existing identities. A conflicting/equivalent catalogue identity or ambiguous context produces a retained hold; it does not silently create a duplicate entity or merge entities.
4. Commit **one immutable shared item**, its primary/related entity memberships, valid prior-development links and captured source provenance. The same item can belong to Bitcoin and BlackRock without making independently rewritten copies.
5. For a valid duplicate, record the source attachment/reuse outcome against the durable existing target rather than creating another item. This does not guarantee that every duplicate avoids all earlier model calls.
6. Commit effects and their accepted receipt within the private writer transaction. Keep leases, owner/epoch fences, expected revisions and replay identity intact. Unresolved work is retained with a reason.

## 3. Article and timeline contract

New handoffs use `schemaVersion: myboon.research_packet.article.v1` and `packetKind: article`. The complete typed contract is [`ArticleResearchPacketV1`](../../../../packages/collectors/src/signal-platform/contracts.ts); the SQLite work row's `researchContractVersion` remains `myboon.research_packet.v1`, so that work-row field alone does not identify the new packet kind.

| Data | Meaning |
| --- | --- |
| Entity name, aliases, summary and scope | Describe the topic and help select its appropriate coverage. |
| `article.title` | Identifies this particular development. |
| `article.timelineSummary` | Reader-facing account of what happened, with relevant context. This is the story entry; there is no extra `connected_story` prose field. |
| `article.body` | Optional fuller detail about the same development. |
| `article.eventAt` | Actual event time only when supported by the article; otherwise `null`. |
| `sourceSignal.publishedAt`, packet `observedAt`, `article.capturedAt` | Separate publication, observation and capture timestamps. Never relabel them as a known event time. |
| Source URLs, captured text and hashes | Immutable provenance. Original URL and captured/final URL are retained where available; HTTP-response hash and extracted-text hash are distinct. |
| `memberships` | One primary plus meaningful related entities, Jev decisions and any exact prior/duplicate target with its `legacy` or `managed` origin. |
| `memberships[].contextualDuplicateTarget` | Optional related exact match retained for audit under already-known novelty and one primary reuse target. It does not authorize another writer effect or an entity/item merge. |
| `novelty`, limitations and open questions | Internal decision/audit material and explicit uncertainty; not fabricated claims. |

Internal history orders by known event time, otherwise publication time, otherwise observation time. A new development appends history; it does not overwrite earlier accepted prose. Source attribution is retained even though formal claims/evidence edges are removed.

Placement examples express intended quality, not guaranteed model answers:

- Iran reviewing a US proposal delivered through Qatar: primarily **U.S.–Iran Conflict**; country or mediator memberships require substantive relevance. A diplomatic branch need not directly resolve a shipping-disruption development.
- BlackRock adding Bitcoin: primarily **Bitcoin**, with **BlackRock** related when substantively involved. Persist one item with both memberships.
- Grayscale's AI outlook: judge the scope of existing company/AI/investment entities; do not automatically create a generic AI bucket.

Existing legacy packets and memories retain their explicit compatibility paths. Their claim/evidence validation is not imposed on new article packets. The current UI/story reader still reads legacy memories, not these private items; connecting it is excluded from this checkpoint.

## 4. Storage and recovery requirements

- Source-local **SQLite** owns observations, delivery obligations, intake/research jobs, captures, saved packets/decisions, readiness, reservations, retry state and source authority. News and Polymarket retain separate database files.
- Private **PostgreSQL** owns managed entities/items, memberships, article provenance/relationships, plans, leases, holds and receipts in the writer's transaction domain. Existing public memories and publishing inputs remain separate.
- Dedicated Research and Entity identities use verified TLS and narrow named-function permissions. No public API projection or direct managed-table mutation grant is introduced. Applied migrations are not edited in place.
- **D1:** retain older incomplete research without automatically promoting, permanently rejecting or bulk rerunning it. Explicit bounded assessment is a separate operator path.
- **D2:** an unknown paid dispatch outcome retains the same reservation and logical allowance. Recover only using supported retained proof; otherwise hold for intervention. Timeout does not authorise a replacement call or reset limits.
- Known primary-provider authentication/billing failure may invoke the configured native backup. This is distinct from automatically replacing an unknown paid outcome.
- Source ownership and writer fences prevent concurrent legacy/V4 effects. Retirement and rollback must preserve observations, accepted knowledge, history and receipts.
- Calls, tokens, output size and wall time have configured operational limits. New light/standard work has 180 seconds, capture is bounded to 3 MB per source/9 MB total, and fetch has a 30-second deadline. Jev receives the whole source up to 48,000 characters, with a separate 96,000-byte serialized-state bound; larger inputs hold without truncation. Candidate decision summaries are bounded to 1,000 characters and historical decision titles to 500, while stored profiles/history remain intact. New source-grounded entity proposals bind 16,000 input/4,000 output token allowances into the actual request; historical attempts retain their saved limits. The owner authorised real provider/database validation without a USD approval gate; this PRD adds none. Unknown monetary cost must remain unknown.
- Classification input validation precedes paid reservation/dispatch intent. A confirmed received-but-rejected response gets a durable rejection receipt and exact settlement; crash recovery consumes matching saved proof without redispatch. A genuine unknown transport outcome remains held. Historical validation-shaped errors are not proof that no dispatch happened.
- Temporary catalogue/history connection, schema-cache and network failures are storage availability failures, not evidence of an ambiguous entity. Article claims require both configured storage readers to pass a bounded availability probe. Failed probes back off from 30 seconds to five minutes. A failure discovered after a probe closes article admission for the rest of the batch. Pre-decision storage failures wait without consuming an execution attempt or making a paid call; later transient coverage failures retain their saved paid decisions and ordinary retry state. Freshness, lease ownership and operator controls still apply. Genuine missing-schema, identity and reference errors remain explicit holds/failures.
- News can use explicit bounded P3/light capacity overrides to admit fresh work while counting retained unknown paid exposure. Defaults, urgent reservations and per-assignment budgets remain intact. The temporary 7 October operating policy and its reversal conditions are in the recovery record; this does not authorize replay of uncertain attempts.

## 5. Acceptance and checkpoint status

| Requirement | Current evidence / status |
| --- | --- |
| Durable source delivery, logical intake identity and required next action | Implemented; covered by the earlier source/ownership validation and subsequent article startup checks. |
| Captured article input without new claims/evidence contract | Implemented and exercised by article contract, readiness and private-persistence regressions; real accepted News items contain no formal evidence rows. |
| Jev placement, related memberships, novelty and latest-five relationships | Implemented and exercised in affected tests/live activation. Broad semantic accuracy remains to be evaluated. |
| Researcher-authored dated prose with preserved source/dates | Implemented and persisted for real News articles; editorial quality still needs review. |
| One item, multiple memberships, valid history links, duplicate attribution | Implemented; five isolated PostgreSQL article tests and live accepted-item checks passed. |
| Receipt-first replay, restricted writer, leases/fences and unknown-outcome holds | Earlier database/recovery validation plus article persistence checks; retained holds/failures are not automatically cleared. |
| Legacy compatibility and public-memory isolation | Affected compatibility checks passed; activation verified existing public counts were unchanged. Downstream exposure is excluded. |
| Runtime activation and provider routing | Seven PM2 processes are online, but hosted database connections time out; process status is not completion evidence. Research admission is protected while the database is unavailable. News-only Research/Entity authority and Ollama routing are preserved; API excluded from process actions. See the dated outage record for activation and remaining proof. |

The [activation record](../operations/2026_10_05_article_pipeline_activation.md) records affected test groups, migration/permission/restore checks, real accepted items and retained failures. Counts from overlapping test runs must not be summed into a unique total. The later [profile-routing record](../operations/2026_10_05_hermes_profile_routing.md) records 159 focused tests, a passing collectors TypeScript check and live native/typed backup probes.

The [6 October verification](../operations/2026_10_06_article_failure_fixes.md) records 328 passing regressions, six isolated PostgreSQL article tests, actual Jev/Ollama decisions and isolated persistence of a real model-authored packet. The candidate-resolution migration and runtime fixes were activated on 6 October; see the [restart record](../operations/2026_10_06_service_retirement_and_restart.md). This checkpoint does not establish universal completion or model accuracy. Source-fetch/admission, entity-resolution, structured-output and configured-limit failures remain. Exact follow-up work and operational constraints are in the [handoff](../operations/2026_10_05_v4_entity_manager_checkpoint_handoff.md).

## 6. Current operating configuration

- Research and Entity configured sources: `news`. Hosted database availability currently blocks useful progress. Research must wait for both storage readers before claiming articles; Entity Manager retains pending items. Polymarket is collection-only.
- Article workflow, managed writer and persistent source ownership are enabled for the active source. Older generic V4 novelty/reuse/follow-up flags remain off; required article Jev workloads have their own active lifecycle.
- Jev: `jev-1.13.0`.
- Hermes primary everywhere: `ollama-cloud/glm-5.3-flash`.
- Automatic native GPT fallback is disabled in every profile at the owner's request. Codex credentials remain installed; normal pipeline calls use Ollama only.
- Every programmatic inference call selects a profile explicitly. Shared default: `myboon-codex-production`; its name does not make Codex primary. Both production memory stores are disabled; article/entity context is request-owned.
- Ollama billing was restored on 6 October. A real typed article-writing request through `myboon-codex-production` succeeded on GLM-5.3 Flash with one dispatch, zero repairs/tools and no fallback. Research was not resumed by that isolated validation.
- Publisher was started on 6 October at the owner's request. It runs the existing editor-draft publication path every five minutes, with up to ten drafts per cycle. Its first cycle completed with zero eligible drafts; this does not add downstream integration for V4 managed items. See the [Publisher startup record](../operations/2026_10_06_publisher_restart.md).
- Editor is running hourly on the existing legacy public-memory path, with two bundles per cycle, up to three new memories and ten lane memories. It uses the standard Hermes launcher with the explicit production profile.
- Orphan sweeper, catalogue maintenance and classification-shadow services, commands and dedicated code are removed. Required live Jev decisions and per-call Hermes cleanup remain enabled. Historical migrations and audit records remain intact.

Delivery branch: `main`. The article checkpoint (`124f565`), 6 October fixes/service removals and 7 October repairs (`b63ecae`, `b50963a`) are delivered on `origin/main`; the candidate-resolution migration is applied to production. The 8 October outage record distinguishes code protection from live database recovery. Host-local credentials, runtime configuration and private operational receipts remain outside Git. The handoff is the entry point for another maintainer; historical records and the archived PRD preserve earlier implementation detail.
