# Issue 299 — checkpoint through Entity Manager

Date: 5 October 2026 (IST).

Latest update: [6 October operational cleanup and overnight baseline](2026_10_06_operational_cleanup_and_overnight_baseline.md).
Research has resumed on Ollama GLM-5.3 Flash; automatic GPT fallback remains disabled.
The candidate-resolution migration is applied and the article fixes are loaded
in News intake, Research and Entity Manager. Editor and Publisher use the existing
legacy publication path. The orphan sweeper, catalogue maintenance and classification
shadow services and dedicated code are retired. The source fixes and retirement
changes are included in the cleanup commit on `main`. The dated snapshots below
describe earlier operating states.

Current specification: [V4 working PRD](../PRDs/v4_prd.md).

Boundary: **Scout → Intake → Researcher → Entity Manager → private durable knowledge.**

## Read this first

The article workflow is implemented and running for News; the dated operating snapshot below records its earlier activation. It organises captured articles into entity timelines: Jev decides placement, related memberships, novelty and relationships; Researcher uses Hermes to write the dated development; Entity Manager validates identities and durably saves the prepared item. New article packets have no formal claims/evidence arrays or evidence-reference admission requirement.

**There is no downstream integration in this checkpoint.** Do not add reader/consumer adapters, consumer checkpoints, V1 projections, API/UI changes, Editor, Publisher or X Desk work to the remaining #299 list. Internal entity/history lookup is required for organisation. New managed items remain private and are not already connected to the current story UI.

This is a repository checkpoint through Entity Manager, not a statement that every article completes. The delivery branch is `main`; `3e750f3` is the base preceding the checkpoint, not the revision containing its completed implementation. Use the checkpoint commit or updated `origin/main` to obtain the code and documentation together. Preserve existing unrelated user edits. Host-local credentials and runtime state are separate from repository delivery.

## What is in place

| Area | Implemented behaviour |
| --- | --- |
| Scout / Intake | Durable observation delivery, one logical work identity, saved decisions/next actions and source ownership/fencing. |
| Article capture | Captured source text, original/final URL provenance and separate publication/observation/capture dates. Required capture failures stay explicit; no web-search fallback. |
| Research decisions | Bounded metadata-aware candidates, required Jev primary/related decisions, wider lookup and a Jev-validated source-grounded creation proposal when no match remains. |
| History | Up to five latest legacy/private items per selected entity, loaded lazily; exact historical origins and separate targeted older-duplicate lookup. |
| Writing | Researcher asks Hermes for title, contextual `timelineSummary`, optional body and supported event time. Probability/relationship data stays internal. |
| Entity Manager | Deterministic article persistence; validates entities/references, saves one shared item/memberships/links or an exact duplicate-source attachment. No second article model planner. |
| Reliability | Durable saved results and reservations, Research-owned readiness, accepted receipts, restricted private writer, leases/epochs/revisions, retained holds and legacy compatibility. |

For example, one Bitcoin development may have Bitcoin as its primary entity and BlackRock as a related membership. That produces one item's prose with two memberships. U.S.–Iran diplomatic reporting should be judged against the conflict narrative rather than automatically filing it under each named country.

## Item shape and chronology

The packet discriminator is `myboon.research_packet.article.v1` / `packetKind: article`. The work row still uses the older research-contract version, so inspect the saved packet rather than identifying the flow by that work-row field alone.

Illustrative excerpt only; identifiers/source text are placeholders and this is not a recorded Jev response or a complete serialised packet:

```yaml
schemaVersion: myboon.research_packet.article.v1
packetKind: article
sourceSignal:
  title: Iran reviewing a US proposal delivered through Qatar
  canonicalUrl: "<original source URL>"
  publishedAt: null # Keep the actual source date when available.
article:
  title: Iran reviews a US proposal delivered through Qatar
  timelineSummary: >-
    According to the report, Iran is reviewing a US proposal delivered
    through Qatar, adding a diplomatic development to the U.S.–Iran conflict.
  body: null
  eventAt: null # Do not invent a date from publication time.
  sourceUrl: "<captured/final source URL>"
  capturedText: "<immutable captured article text>"
memberships:
  - entityId: "<U.S.–Iran Conflict entity ID>"
    name: U.S.–Iran Conflict
    role: primary
    relationship: same_topic_only
    priorItemId: null
    priorItemSource: null
```

The full packet also contains work/signal identity, timestamps/hashes, Jev decisions, limitations, readiness-related material and execution usage. See the typed contract linked below. There is no separate `connected_story` field: `timelineSummary` says what happened, while relationship decisions/references explain its connection internally. A verified continuation/branch can link an earlier `legacy` or `managed` item. History sorts using known event time, otherwise publication time, otherwise observation time; older accepted prose remains intact.

## Where to work

Paths below are relative to `packages/collectors/src/`:

| Responsibility | Main seams |
| --- | --- |
| Contracts and packet validation | `signal-platform/contracts.ts`, `signal-platform/validation.ts`, `signal-platform/research-readiness.ts`; Research handoff in the same module. |
| Active Research composition | `research-engine/run-shared-research.ts`, `research-engine/shared-worker.ts`. |
| Placement / relationships / decisions | `research-engine/article-placement.ts`, `research-engine/durable-classification.ts`, `inference-gateway/classification-definitions.ts`. |
| Writing / new-entity proposal | `research-engine/structured-synthesizer.ts`, `research-engine/durable-synthesis.ts`, `research-engine/durable-article-proposal.ts`. |
| Internal catalogue and history | `research-gate/managed-context-reader.ts`. |
| Entity persistence | `entity-manager/article-persistence.ts`, `entity-manager/managed-canonical-processor.ts`, `entity-manager/postgres-knowledge-writer.ts`, `entity-manager/run-shared.ts`. |
| Provider/profile routing | `hermes/service.ts`, `hermes/profile.ts`, `inference-gateway/configuration.ts`, `inference-gateway/classification-configuration.ts`, `inference-gateway/hermes-adapter.ts`, `inference-gateway/classification-adapters.ts`. |
| Source authority / reporting | `signal-platform/source-ownership.ts`, `signal-platform/source-intake-ownership.ts`, `signal-platform/v4-operational-status.ts`. |

The [typed article contract](../../../../packages/collectors/src/signal-platform/contracts.ts) is authoritative for exact field names.

Applied migrations are `20261003090000_entity_manager_v4_private_knowledge.sql`, `20261003090001_entity_manager_v4_dedicated_logins.sql` and additive `20261004103000_entity_manager_article_private_knowledge.sql` under `supabase/migrations/`. Do not rewrite these applied migrations for a subsequent contract change.

Source desks are `packages/collectors/.data/news.sqlite` and `.data/pipeline.sqlite`. Private PostgreSQL contains the managed library and transactional writer receipts. Public memories are a separate compatibility surface, not the destination for new article writes.

## Operating snapshot

Read-only observation at **12:56 IST on 5 October**: all five PM2 processes were online, with the same identities and restart counts recorded after the model-routing activation. Research and Entity heartbeats reported `running` / `active`; Research sources were `news`.

| Process | Role / schedule | PID at snapshot |
| --- | --- | ---: |
| `myboon-api` | Application API; protected and untouched | 1719088 |
| `myboon-news-feed-ingestor` | News observations; 10 minutes | 2043503 |
| `myboon-feed-v3-research` | News article Research; 5-second polling | 2043485 |
| `myboon-feed-v3-entity-manager` | News private writer; 5-second polling | 2043478 |
| `myboon-polymarket-data-engineer` | Market observations; 2 hours; collection only | 2043510 |

PIDs are dated observations, not future requirements. Polymarket Research and Entity admission remain disabled. Editor, Publisher, classification shadow, orphan sweeper and the defined 24-hour entity-maintenance worker remain inactive.

Actual four-process release configuration:
`/home/ubuntu/.config/myboon/article-release-20261005/article.ecosystem.private.config.cjs`.
It contains credentials and only the four pipelines; keep it private. Public `ecosystem.config.cjs` documents the broader roster/defaults and must not be used to start every listed process during a checkpoint handover. Pipeline stop/start actions must continue to exclude `myboon-api`.

Active source configuration is `ENTITY_V4_ACTIVE_SOURCES=news`, `FEED_V3_RESEARCH_ACTIVE_SOURCES=news`, `FEED_V3_ENTITY_ACTIVE_SOURCES=news`. Article workflow, managed writer and persistent ownership are enabled. Older generic novelty/reuse/follow-up flags remain off; article-specific Jev decisions are active. Their presence in source does not authorise enabling the older feature paths.

### Provider configuration and current limitation

- Jev decision model: `jev-1.13.0`.
- Hermes primary in every profile and pipeline: `ollama-cloud/glm-5.3-flash`.
- Automatic GPT fallback is now disabled in every profile. Codex credentials remain installed; normal calls use Ollama only.
- Shared explicit profile: `myboon-codex-production`. The name does not make Codex primary. Per-call overrides remain available for isolated validation.
- Production memory and user-profile memory are disabled; article/entity context is supplied by Myboon.

The 5 October request at **12:22 IST** returned a subscription-past-due HTTP 403, and the earlier successful probes used Codex backup. On 6 October, billing was restored and an actual structured article request succeeded on Ollama GLM-5.3 Flash through the production profile, with no fallback. All twelve profiles remain configured for Ollama; live inference was not probed separately on every profile.

## Validation already completed

- 6 October fixes: 328 regressions, six isolated PostgreSQL article tests, collectors TypeScript and actual Jev/Ollama plus isolated writer verification passed. See the linked fix record for evidence boundaries and the later cleanup baseline for runtime activation.
- Article activation: 73 contract regressions, 68 startup/compatibility regressions, five isolated PostgreSQL article tests, 30 Jev/gateway/context regressions and seven final placement regressions passed. Groups overlap; do not add their counts as unique coverage.
- Private writer/context permissions, verified TLS, additive migration application, source SQLite integrity and restored-copy checks passed as recorded in the activation/database reports.
- Live activation accepted real News items with captured-text hashes and zero formal evidence rows. It also exposed a Bitwise article placed under a narrow ETF entity: persistence works, but semantic placement quality is not established by that fact.
- Provider/profile change: 159 focused Hermes/gateway/client/legacy Research tests, collectors TypeScript and whitespace checks passed; native default and typed production backup probes succeeded. The typed probe used one gateway dispatch, zero repairs and zero tools.

These results do not establish a clean historical full-suite run, broad Jev accuracy, universal article completion or production cost savings. The 3 October Jev/Hermes comparisons used the preceding contract and should not be presented as the new placement/relationship evaluation.

## Remaining work inside this boundary

1. Check overnight progress against the 6 October cleanup baseline. The source fixes are included in the cleanup commit on `main`, the candidate-resolution migration is applied, and News intake/Entity Manager/Research have loaded the fixes. Do not reapply or bulk-recover historical failures. Ollama is primary and automatic GPT fallback stays off. Exclude `myboon-api` from every process action.
2. Observe the repaired PANews redirects, IPv4/deadline handling and article extraction on fresh jobs. Continue reviewing inaccessible sources and genuinely long captures exceeding the unchanged 16,000-character admission bound. No silent truncation or web-search fallback.
3. Review candidate scope and meaningful related memberships with labelled examples, including conflict narratives, Bitcoin/BlackRock, AI outlooks and the observed narrow Bitwise placement. Evaluate latest-five relationships and older-duplicate behaviour separately from prose quality.
4. Inspect no-match, ambiguous-identity, creation-proposal and Entity-resolution holds. Validate improvements on bounded cases before any explicit single-item recovery; do not silently merge or create duplicate entities.
5. Inspect invalid structured output and configured call/token/wall-limit failures. Tune evidenced workload limits where appropriate; do not reset an assignment or resend an unknown paid attempt to make it pass.
6. Observe fresh article completion, dated prose, exact source attribution, duplicate attachment and receipt-based recovery after changes. Keep failures/unknown outcomes visible; process `online` is not proof every job succeeds.

Do not automatically replay old dead letters or incomplete packets. D1 retains older incomplete work for explicit assessment; D2 retains unknown paid outcomes and reservations. Operator assessment/reconciliation commands are prepared tools, not permission to clear a backlog. There is no new USD budget approval gate.

## Evidence and reading order

1. [Current PRD](../PRDs/v4_prd.md) — trimmed requirements and acceptance boundary.
2. [Article activation](2026_10_05_article_pipeline_activation.md) — migration/permission tests, activation fixes, accepted examples and retained failures.
3. [6 October cleanup baseline](2026_10_06_operational_cleanup_and_overnight_baseline.md) — current operating state, recovery and quarantine receipts; [fix validation](2026_10_06_article_failure_fixes.md) and [Hermes routing](2026_10_05_hermes_profile_routing.md) record the preceding changes.
4. [Historical PRD snapshot](../PRDs/2026_10_05_v4_prd_pre_checkpoint_snapshot.md), [4 October implementation](2026_10_04_article_researcher_implementation.md) and the 3 October reports — earlier design/contract detail, not current activation instructions.

Host-local receipts: `/tmp/myboon-article-activation-20261005/activation-evidence-manifest.json`, `/tmp/myboon-all-ollama-primary-result-20261005.json` and `/tmp/myboon-ollama-fallback-probes-20261005/`. These `/tmp` artifacts are not a portable handoff and may disappear. These docs record their conclusions without copying credentials or private prompts. Credentials and VPS runtime state remain host-local, outside Git.

This handoff establishes a reviewable checkpoint through Entity Manager. Downstream adoption is a separate future decision, not unfinished implementation added back to this list.
