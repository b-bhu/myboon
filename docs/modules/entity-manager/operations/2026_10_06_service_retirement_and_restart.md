# Service retirement and pipeline restart — 6 October 2026

The owner requested starting Editor, restarting Research and completely removing the Hermes orphan sweeper, entity-catalogue maintenance and classification-shadow services.

## Retirement

Removed the three PM2 registrations and their package commands, the complete `entity-maintenance` application directory/tests, the Hermes orphan-sweeper implementation/runner/tests, and the classification-shadow runner/tests.

Classification no longer supports the shadow lifecycle, outbox handoff/execution/retention, shadow sampling or separate shadow capacity. The maintenance-specific `entity.catalog_identity` workload is removed. Required live Jev article placement, proposal validation, memberships, relationships and novelty remain enabled. Research/Entity cutover evaluation and deep-research containment auditing are separate features and remain intact.

Editor writes no longer create or consult the retired catalogue-cleanup fence. Existing database tables, applied migrations, merge/redirect records and historical classification audits remain intact. No production records were purged. Historical shadow audit tags remain readable without an execution path. Per-call Hermes timeout, process-group termination and concurrency-slot cleanup remain enabled.

## Activation

Applied `20261006112717_article_entity_candidate_resolution.sql` to Myboon's actual database. The migration service generated timestamp `20261006142802`; only that new history entry was aligned with the repository timestamp. Function ownership and execution grants were preserved, and temporary owner-role/schema-create privileges were restored. Both dedicated Research/Entity logins verified TLS, candidate coverage, exact Raoul Pal identity lookup and denied direct private-table access.

Loaded the verified article fixes into Entity Manager and News intake, then resumed Research through the private four-pipeline release configuration. News remains the only Research/Entity source; Polymarket remains collection-only. Historical dead letters, holds and unknown paid outcomes were not reset or bulk replayed. Previously queued work keeps its saved policies.

Started Editor through the existing legacy-memory publication path. Its old launcher supplied a profile twice, so the ecosystem now uses the standard `hermes` command with the explicit shared profile. Full Editor prompts also exceeded Linux's argument limit (`spawn E2BIG`, 139,444 bytes for XRP). Reduced the older memory window from twenty to ten while retaining three new memories. The inspected XRP and Donald Trump prompts became 92,271 and 89,131 bytes. This context reduction does not establish a general solution for every possible oversized prompt.

Normal model calls use Ollama Cloud / GLM-5.3 Flash with automatic GPT fallback disabled. A real production-profile probe succeeded with one Ollama dispatch. Editor and Publisher retain their existing public-memory/draft inputs; no private V4 publishing/UI integration was added.

## Evidence

- 234 affected regressions passed with zero failures, cancellations or skips: inference gateway, Hermes, Editor, Publisher, SQLite draft contract, storage boundaries and article placement/durable classification.
- Collectors TypeScript and whitespace validation passed.
- Live Research succeeded on Ollama after restart. At 14:33:17 UTC an accepted Entity Manager receipt persisted the BitGo/Grayscale Hyperliquid Staking ETF article, including its timeline summary and Ollama provider/model.
- Editor's corrected first cycle finished at 14:36:27 UTC: two bundles fetched, two decisions saved and zero failures. XRP and Donald Trump both received `needs_more_research`, so neither became an eligible publication. Publisher continues its existing five-minute polling; publication readiness was not bypassed.
- API retained PID `1719088`, restart count `1` and uptime identity `1791000387540` through every process action.

The seven remaining PM2 services are API, News intake, Polymarket collection, Research, Entity Manager, Editor and Publisher. PM2 persistence was saved after the verified restart; its credential-bearing files remain private.

Host-local receipts are under `/tmp/myboon-service-retirement-20261006/`. Source changes were uncommitted at this operating snapshot and are included in the later cleanup commit on `main`. API code, environment and process were untouched by this work.
