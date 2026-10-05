# Article workflow validation and pipeline activation — 2026-10-05

> Activation snapshot ending at 07:13 IST on 5 October. Later PM2 identities and Ollama-primary/Codex-backup settings are recorded in the [checkpoint handoff](2026_10_05_v4_entity_manager_checkpoint_handoff.md) and [profile-routing record](2026_10_05_hermes_profile_routing.md). The test results and production examples below remain evidence for this activation.

The owner requested a restart after the article-based implementation. Four internal pipeline processes are online with the new article contract. Real News articles have completed Jev decisions, Researcher writing through Hermes, and deterministic private Entity Manager persistence. This record supersedes the deferred validation and operating status in the [implementation handoff](2026_10_04_article_researcher_implementation.md); that document remains the historical record of the implementation-only pass.

Scope is Scout → Intake → Research → Entity Manager → private durable knowledge. Research and Entity Manager accept **News only**. Polymarket collection runs, with no Polymarket Research/Entity activation. No downstream, API/UI, publisher or X Desk integration was performed. Historical failures, unknown paid outcomes and public memories were not replayed or rewritten.

## Process configuration and protected API

| Process | PID after final Research start | Status |
|---|---:|---|
| `myboon-news-feed-ingestor` | 2004017 | Online |
| `myboon-polymarket-data-engineer` | 2004075 | Online; collection only |
| `myboon-feed-v3-research` | 2008230 | Online; News article workflow |
| `myboon-feed-v3-entity-manager` | 2003901 | Online; News private writer |
| Protected `myboon-api` | 1719088 | Online and unchanged |

Collectors and Entity Manager started at approximately **01:17:34–36 UTC / 06:47:34–36 IST**. The final Research start was **01:40:35 UTC / 07:10:35 IST**, after targeted activation fixes. Research's restart count remains the earlier historical value of eight; it did not enter a new crash loop. Every process-control action checked the API against its original PID, online status, restart count of one and uptime `1791000387540`. No API restart, reload or environment change occurred.

The four-process configuration is retained at `/home/ubuntu/.config/myboon/article-release-20261005/article.ecosystem.private.config.cjs`, with directory/file permissions `0700`/`0600`. It contains no API process. PM2 persistence is saved; its dump and backup permissions are `0600`. Credentials are omitted from this record and from the nonsecret evidence manifest.

Enabled flags are article workflow, managed writer and persistent source ownership, with `ENTITY_V4_ACTIVE_SOURCES=news`, `FEED_V3_RESEARCH_ACTIVE_SOURCES=news` and `FEED_V3_ENTITY_ACTIVE_SOURCES=news`. The pre-existing source authority remains revision two; this activation did not perform another ownership transition. Legacy V4 novelty/reuse/follow-up flags remain off; article novelty and relationships run through their separate explicitly active Jev workloads. The writer prompt version is `research.article-story.prompt.20261005.v2`. Jev uses `jev-1.13.0`; Hermes uses the working paid Codex subscription route `openai-codex/gpt-5.6-luna`. There is no dollar-budget approval gate.

## Database, backups and validation

The additive migration `20261004103000_entity_manager_article_private_knowledge.sql` was rehearsed in isolated PostgreSQL and then applied to the actual Myboon project. The migration service initially recorded version `20261005011550`; the unique new migration-history entry was reconciled to the repository version `20261004103000`, after checking that target version was absent. Earlier applied migrations were unchanged.

The article content, relationship and source-attachment tables use forced RLS and narrow owner grants. Actual dedicated Research and Entity logins passed TLS/context checks and direct-table-denial checks. Research can execute the named context function; only the dedicated Entity worker can execute the article writer. API roles were not granted access. Source response hashes and captured-text hashes are distinct: original HTTP bytes can differ from extracted text, while both remain retained and the captured-text hash verifies stored text.

Fresh News and Polymarket SQLite backups passed integrity, table-count and isolated restore checks before startup. Source main files remained unchanged during the backup/restore rehearsal. Their SHA-256 values are:

- News: `a0ab56502d81b085fe8e5acdeab76ffa9e06570f29808c52609191d2669e2365`.
- Polymarket: `85ed645ee9a2a2aafa82bdd78c3ad061317f481f6a82ea54e3da1e25c606da90`.

Verification runs passed: 73 focused contract regressions, 68 startup/compatibility regressions, five isolated PostgreSQL article tests, 30 affected Jev/gateway/context regressions, and the final seven article-placement regressions including long legacy titles. Some runs overlap; their counts are not a unique combined total. The collectors `pnpm exec tsc --noEmit` check passed after the final code change. This is affected-change validation, not a rerun of every historical repository test or a claim of full semantic quality evaluation.

## Activation fixes

Compiler and runtime checks found integration defects that source-only review could not prove: article/legacy union narrowing, readiness and worker typing, SQL quoting and scoped variable resolution, function ownership/default-grant handling, and response-byte versus captured-text hash validation. These were corrected before production admission.

Live startup then exposed duplicated candidate descriptions in Jev choices, insufficient output allowance for a full catalogue distribution, misleading Jev-only fallback error messages, alias filters that failed on comma-containing headlines, and eager history requests for every candidate that exhausted the database pool. Choices now reference the supplied profiles, retain raw probabilities, and have adequate bounded output allowance; failed Jev calls retain their actual category and do not use Hermes as semantic fallback. Alias filters are correctly quoted. History is retrieved lazily for **selected entities only**, with their latest five items and separate targeted older-duplicate lookup.

Long legacy history titles are explicitly excerpted only in Jev's bounded title field. Stored records and full Researcher writing context remain unchanged. Source captures are never silently truncated: the current article admission limit is 16,000 characters, and serialized decision state is capped at 96,000 bytes. Oversized captures and unavailable required sources remain explicit per-article failures.

## Real production outcomes and limits

At **01:40:58 UTC / 07:10:58 IST**, the database contained **six new article items** and seven registered article sources. All stored captured-text hashes verified. The new article items had **zero formal evidence rows**. Private Polymarket source count remained zero. Public entities and public memories remained at their pre-activation counts of **1,653** and **47,598**.

Accepted examples included:

- “Anchorage Digital cuts 17% of workforce amid prolonged crypto-market downturn,” published `2026-10-05T00:27:15Z`; primary entity Anchorage Digital.
- “Hill aides remain skeptical that crypto tax legislation will pass in 2026,” published `2026-10-04T22:48:36Z`; a source-grounded proposed narrative was persisted.
- “Bitwise CEO identifies investor attention as the next barrier to crypto adoption,” published `2026-10-05T00:20:23Z`; the model selected Bitwise NEAR ETF (NRR). This choice demonstrates persistence, but its narrow scope still needs editorial quality review.
- “Yemeni government announces full-scale counteroffensive against Houthis,” published `2026-10-05T01:03:01Z`.
- “Federal Reserve September meeting minutes highlighted in the week ahead,” published `2026-10-04T15:27:01Z`.
- “European demand outpaces US interest as Bitcoin markets diverge,” published `2026-10-04T22:35:23Z`.

At the preceding **01:38:13 UTC** queue observation, five work rows were complete, one was awaiting Entity processing, 20 were pending Research and **27 were dead-lettered**. Counts are time-bound snapshots and continue changing. Retained failures include earlier activation defects, source-fetch failures, captures above the admission limit, an unresolved structured creation proposal, and one Entity resolution rejection. Some earlier paid attempts retain unknown-outcome holds. None was automatically cleared, resettled or replayed after the fixes. Online processes and accepted articles do not imply that every input completes or that every placement is semantically correct.

The final observation at **01:43:13 UTC / 07:13:13 IST** confirmed all five process identities, including the protected API, remained online and unchanged after the final Research start. Research and Entity heartbeats were four and eight seconds old. The final Research process had run for approximately 158 seconds without another restart. News work created since activation was **nine complete, 31 dead-lettered, one leased by Entity and 12 pending Research**. PM2 was saved at `01:42:29 UTC`; all four saved pipeline environments retain article activation and News-only Research/Entity source lists. These outcomes, the compiler result and file/log hashes are retained in `activation-evidence-manifest.json`.

Nonsecret activation evidence, guarded PM2 action logs, repeated health observations, test logs, compiler output and backup/restore receipts are under `/tmp/myboon-article-activation-20261005/`, with compiler output also at `/tmp/myboon-article-typecheck-20261005.log`. The protected persistent configuration remains outside the repository. No commit, push or pull request was created during this activation.
