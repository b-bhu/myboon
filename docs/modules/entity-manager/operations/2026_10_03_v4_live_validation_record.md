# Issue 299 — live validation and activation evidence

> Historical record for the 3 October implementation/validation phase. For the current article contract, scope and operating checkpoint, use the [working PRD](../PRDs/v4_prd.md) and [5 October handoff](2026_10_05_v4_entity_manager_checkpoint_handoff.md). These dated results do not establish the current profile/model settings or new article semantic quality.

Date: 2026-10-03

The owner authorized real Jev/Hermes calls and actual database data without a dollar budget gate, then resumed the remaining validation after selecting the working Codex subscription route. The final technical validation is complete: all integrated, database, recovery and live model checks described below pass, with the native output-token limitation explicitly recorded. Production activation and its observation window remain separate operational steps. Scope remains Scout → Intake → Research → Entity Manager → private durable shared knowledge. Downstream integrations and historical bulk replay remain excluded. This record follows the completed [offline validation](2026_10_03_v4_validation_record.md); its frozen candidate is retained separately from subsequent live fixes.

## Final validation gates

These are final validation results for the frozen Luna candidate. They are technical evidence, not executed source ownership approvals or a claim that production workers have restarted.

| Gate | Evidence/status |
|---|---|
| Actual source backup and restore | Passed for both News and Polymarket; original source files unchanged. |
| Actual old-schema copy upgrade | Passed; original table counts and sampled original columns preserved, no replay or ownership activation. |
| Hosted schema and dedicated credentials | Both V4 migrations applied; explicit PostgreSQL suite **28/28**, including under umask 077; actual authenticated permissions/strict TLS **12/12**. Existing public rows unchanged. |
| Live Jev classification | **80 valid responses** retained from the preceding paired evaluation, with typed/confidence acceptance and conservative abstentions documented in the Research report. |
| Live Hermes classification | Exact subscription route `openai-codex/gpt-5.6-luna`: **80/80 valid responses**, zero auxiliary calls/unknown outcomes, no reviewed false-known prediction. Two safe label differences remain documented. |
| Actual-data internal chain | Full Luna News + Polymarket + unrelated-evidence run **4/4 passed**; both positive receipts recovered after PostgreSQL/SQLite restart with **zero additional model calls**. |
| Final current-candidate regressions/compiler | **1,438 collector tests passed**, zero failed, five opt-in entries skipped and exercised separately. **195 API tests passed**. Collectors TypeScript, ecosystem syntax and diff checks passed. |
| Ownership/operator readiness | **25/25** actual read-only operator checks passed (21 expected activation refusals, four read-only successes); both existing backups revalidated. Original source authority/queues and stopped workers remain unchanged; current evidence must be rebound to execution-time revision/epochs before a switch. |
| Transport limit | Installed Hermes omits native `max_output_tokens` for Codex subscription requests. Profile settings and successful measured responses do not prove a hard provider output cap. |
| Production activation/restart | Not performed in this resumed validation request. Staged News-first ownership activation, fresh observation, then Polymarket remain operational work. |

## Actual deployment and data

The deployment is the current VPS, `srv1377229`, running Ubuntu PM2. Only `myboon-api` is online. The actual source files are `packages/collectors/.data/news.sqlite` and `packages/collectors/.data/pipeline.sqlite`; the unrelated root `news.sqlite` is untouched. Backups of approximately 1.24 GB and 363 MB were restored and verified. Read-only product backup was hardened to avoid initializing/upgrading the original source as a side effect.

The hosted Myboon Supabase project is `rrdvpdgebygfdstwknqc`, with PostgreSQL 17.6. Its catalogue has 1,653 entities and 47,598 legacy memories. Both V4 migrations (`20261003090000` and `20261003090001`) are now applied, with dedicated worker and context-only logins. The resumed authenticated probes preserve those public counts; all 16 private managed tables remain empty because live writes used isolated PostgreSQL. Actual retained source packets contain unrelated search results, and some legacy memories have incorrect entity attribution. These are explicit negative evaluation cases, not repaired production records and not authoritative knowledge.

Historical source freshness and article-completeness limitations are retained. All pending canonical work found in the original stores is expired; restored-copy schema upgrades do not automatically replay it. Missing old V4 ledgers are not evidence of zero historical provider spending. Existing leases were absent at inspection, but production ownership receipts have not been constructed.

## Live fixes and provider boundary

The actual Hermes CLI rejects literal `-t none` before contacting a provider. The shared service translates callers' logical no-tools request to the installed `context_engine` toolset, verified to resolve to zero model tools. Both structured inference and classification adapters now explicitly request that toolset and `--ignore-rules`. The regression exercises real service argument construction for both adapters.

The installed CLI supports `--usage-file`; callers can now supply an absolute private receipt path. This exposes actual token usage, resolved provider/model and auxiliary calls during evaluation. Gateway estimates are not silently treated as measured CLI usage.

Default-profile OpenRouter health returned the expected JSON through `openrouter/stealth/space-bunny-alpha`, but its CLI receipt shows one main call and one auxiliary title-generation call. A separate profile, `myboonv4validation20261003`, disables title generation, compression, memory and fallback without modifying any existing profile. Its health receipt shows one provider call and zero auxiliary calls. The supported title-generation setting is documented by [Hermes configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration). Monetary usage remains unknown even when the CLI numeric estimate is zero.

The existing Ollama credential is the same stored key across the active profiles; the second environment-seeded pool entry has no configured token in the inspected environment files. The observed HTTP 403 is retained as a provider limitation. Successful OpenRouter evaluation does not establish that the configured Ollama route is healthy or that different models have equivalent behavior.

Live source evaluation also exposed value-positive follow-up judgments without an executable follow-up route. Research now resolves safe admitted follow-up URLs before buying a value classification and supplies the exact admitted routes and access bounds in its state. Missing, unsafe, already-captured or outside-allowlist routes preserve the baseline without a classifier call.

The private migration no longer attempts an unconditional SUPERUSER-property alteration that the hosted non-superuser deployer cannot execute. It rejects pre-existing elevated/login/inherited reserved roles, creates minimal roles, transfers ownership through temporary SET-only authority and revokes that authority. This passed the actual catalogue/schema and role-parity rehearsal.

The PM2 Editor wrapper path now resolves through the runtime account's home directory. This is existing-process compatibility, not downstream implementation or a claim that the Editor was restarted.

## Evidence ownership

- [Actual hosted database and role-parity validation](2026_10_03_v4_live_database_validation.md).
- [Actual source, backup/restore and operational validation](2026_10_03_v4_live_operations_validation.md).
- [Live Research/model evaluation](2026_10_03_v4_live_research_validation.md).
- Private command outputs, bounded public-source exports and usage receipts: `/tmp/myboon-v4-live-20261003/`.

Runtime credentials are never part of candidate snapshots. Source exports and raw model responses are held in the private task directory. Natural historical examples without independent novelty labels do not count as accuracy measurements; passing classification policy and recovery checks does not establish production savings.

## Requested Ollama model trial after the pause

The owner requested `nemotron-3-nano:30b`. For that trial, the collectors' actual primary-model setting, structured gateway default, classification default/allowed route and configuration example used that exact model with `ollama-cloud`. Ollama's live cloud model list includes this exact API name; no `-cloud` suffix is required when calling its hosted API. The subsequent Codex subscription trial below supersedes this primary route.

The live Hermes trial used the existing configured credential in a separate profile, with ambient rules/tools, auxiliary title generation, compression and fallback disabled. It reached Ollama once and returned HTTP 403: `your subscription payment is past due`. The CLI reported one API call, zero auxiliary calls and no model response or measured token/cost usage. Changing the model did not clear the credential's billing rejection. No pipeline was restarted.

Scoped route/definition configuration regressions passed **17/17**, and the collectors TypeScript check exited **0**. Evidence: `/tmp/myboon-v4-live-20261003/nemotron-configuration-tests.log`, `nemotron-typescript.log`, `nemotron-health.stdout`, `nemotron-health.stderr` and `nemotron-health-usage.json`. The earlier paused dedicated-login assertion correction remains outside this bounded model trial; these results do not claim that the previously paused full validation phase was completed.

## Requested Codex subscription route trial after the pause

The owner requested Hermes's existing Codex subscription authentication with the exact model `gpt-5.6-luna`. The installed Hermes provider name for this OAuth route is `openai-codex`. The actual collectors environment, structured gateway default, classification default/approved route and configuration example now select `openai-codex/gpt-5.6-luna`. The collectors environment selects the dedicated `myboonv4codex20261003` profile, which inherits existing subscription OAuth credentials and disables title generation, compression, memory and model fallback. Existing profiles and the global Hermes model selection were not changed. ChatGPT sign-in provides subscription access, as described in [OpenAI authentication documentation](https://learn.chatgpt.com/docs/auth).

**All four live calls succeeded**: a JSON health response, a registered Research novelty decision for an unrecorded retained source, an exact-duplicate context transformation returning `already_known`, and the production `StructuredResearchSynthesizer` using the actual retained News source capture through the configured inference gateway. Native CLI receipts confirm `openai-codex/gpt-5.6-luna` for every call, four main calls, zero auxiliary calls and 7,374 total tokens. The health receipt reports subscription cost status `included`; this is not a separate API-key billing route.

The synthesis packet preserved the original observation timestamp, cited the retained evidence, attributed its claim to the source and produced zero independently verified facts. The duplicate context was explicitly constructed for evaluation; it was not written to production knowledge. These bounded checks establish that the requested route works through the current transport, decision adapter and production synthesis schema. They do not establish the earlier OpenRouter evaluation's accuracy metrics for Luna, complete Entity Manager validation for this model, or authorize historical replay.

Scoped route/definition configuration regressions passed **17/17** and the collectors TypeScript check exited **0** after the route change. `git diff --check` also passed. Only `myboon-api` was online at that PM2 inspection; pipelines remained stopped. At that point the broader validation phase was paused. The owner's subsequent resume and completed dedicated-login correction, full model evaluation and integrated checks are recorded below.

Private evidence: `/tmp/myboon-v4-live-20261003/codex-luna-health-usage.json`, `codex-luna-adapter-smoke.ts`, `codex-luna-adapter-smoke.json`, `codex-luna-adapter-smoke.log`, `codex-luna-adapter-{1,2,3}-usage.json`, `codex-luna-synthesis-packet.json`, `codex-luna-configuration-tests.log` and `codex-luna-typescript.log`.

## Completed resumed validation

The final current-code collector run discovers every `.test.ts` file under `src` using `rg`, runs all 187 files with concurrency four and passes **1,438 tests with zero failures**. Five opt-in top-level entries are skipped in that run. They are exercised by the explicit **28/28** PostgreSQL run, **7/7** synthetic internal-chain run and **4/4** real-provider internal-chain run; these counts overlap and must not be added as unique tests. All 28 API test files run from a disposable working directory and pass **195/195**, without mutating the API's actual swap database. The collectors TypeScript check exits **0**. Exact commands and logs are `final-luna-regression-command.json`, `final-luna-regression.log`, `final-luna-regression-result.json`, `final-luna-api-command.json`, `final-luna-api-regression.log`, `final-luna-synthetic-chain.log` and `final-luna-typescript.log` in the private evidence directory.

The pending dedicated-login assertion is corrected: PostgreSQL 17 can retain equivalent executor grants from different grantors. The regression checks distinct role/parent/ADMIN/INHERIT/SET capabilities, verifies expected grantors and proves unchanged grants on reapplication, rather than assuming a single physical membership row. No migration defect was found. The first resumed live-chain attempt failed before a model call because a private shell umask made its public fixture TLS certificate unreadable to container PostgreSQL. The fixture now sets the public certificate to 0644 while its private key remains 0600 owned by PostgreSQL. The entire explicit PostgreSQL suite subsequently passes under umask 077; failed startup logs remain retained.

The final real-provider internal-chain run is `/tmp/myboon-v4-live-20261003/internal-chain-live-c60161fe-8d30-4b04-b298-3e34ca95bd42/`, with command log `luna-internal-chain-rerun.log`. It passes all three subcases and their enclosing test in one run: News retained source → Research → managed Entity accepted receipt; Polymarket original native odds → Research → managed Entity accepted receipt; and unrelated Baidu capture → no market claims/facts and failed Entity readiness. Both positive cases lose the SQLite completion acknowledgement, reopen SQLite/restart PostgreSQL and complete from the exact accepted private receipt before hydration/provider construction. Native CLI receipts measure **five Luna main calls, zero auxiliary calls and 18,311 tokens**. Research correctly bypasses Jev against empty private knowledge and no admitted follow-up URL; separate real Jev/Luna decision evaluation covers their decision behavior. Original historical dates, source authority and article-completeness caveats remain preserved.

The final decision set preserves **19/20** synthetic labels, **10/11** independently labeled actual-derived comparisons and **1/1** Solana/GPT identity-pollution label. One unsupported-access case returns `not_worthwhile` instead of `uncertain`, with the same baseline/no-investigation outcome. The other difference is the previously disputed different-date gold ATH comparison; both dated assertions remain for Research. The remaining 48 actual natural cases are unlabeled observations, not accuracy measurements. No labels, prompts, acceptance thresholds or production lifecycle modes were tuned to these outputs. See the Research report for measured calls, latency, native usage and confidence acceptance.

The output-token limitation is a concrete transport finding: installed `agent/transports/codex.py` omits `max_output_tokens` when `is_codex_backend` is true, even though the dedicated profile contains `max_tokens: 4096`. Repository admission/reservations and response checks use estimated token accounting; deadlines, one turn, zero tools/auxiliary work, disabled compression/memory/fallback and durable unknown-outcome holds are separate safeguards. These checks do not establish a hard native token ceiling or monetary savings. No unsupported endpoint parameter or hidden dependency patch was introduced.

Fresh hosted advisors preserve the existing unrelated public RLS/search-path findings. The 19 new private unindexed-FK INFO findings are documented as future growth/maintenance concerns, with current PK/unique recovery paths and append-only grants reviewed; they are not function-permission failures. Three unused-index INFO findings on empty managed tables do not justify removing the intended runtime indexes. Production-scale context latency and future hard-delete/retention performance remain unmeasured. `final-hosted-advisors.json` and the database report retain the exact findings and disposition.

The completed operations lane records **25/25** actual read-only checks: 21 expected authority/receipt/schema refusals and four successful status/drain dry-runs. Both saved backups pass fresh integrity, manifest and source-count checks, with unchanged original metadata, table sets and inventoried counts; another backup/restore is unnecessary. Source/control bytes remain unchanged. `/tmp/myboon-v4-live-20261003/activation-preview/final-operations-readiness.json` binds this evidence to the exact frozen candidate and Luna runtime inputs while explicitly preserving unapproved/unapplied production ownership. Its SHA-256 is `e5b72d5b6f9d8a732dfb0d9f40166b6f00150471ac5c50bb04405e1080508e19`.

## Final candidate and next operational boundary

The final frozen source/configuration/migration candidate contains **675 files**, including all resumed fixes and the Luna route. Archive: `/tmp/myboon-v4-live-20261003/final-luna-candidate.tar.gz`; manifest: `final-luna-candidate.json`; digests: `final-luna-candidate-digests.json`. Manifest SHA-256: `3e50fa72a40eed6f97bd1d58272752677bf10ef8fe5aac499667e23ca577dafa`. Archive SHA-256: `712ae0a1795891d0eb96c75c3c1cb8a34d17e4384ca8ec1141dd8552cb69c5e5`. Runtime credentials, source databases, mutable evidence documents and unrelated user changes are excluded. `final-luna-runtime-inputs.json` records the nonsecret profile configuration and installed Codex transport hashes separately.

`final-luna-evidence-manifest.json` inventories the consolidated private logs/receipts and binds the four final validation reports. The final read-only verification confirms all 675 source hashes match the frozen manifest, no task-owned PostgreSQL containers/networks remain, and only the unchanged existing API process is online.

Validation is complete for this candidate and its documented limitations. Original source stores are not upgraded/initialized by these tests, no real ownership receipt is signed/applied, and only the existing API process remains online. The next operational step is the staged News-first source initialization/ownership switch and controlled startup, followed by actual health observation before enabling Polymarket. Execution must refresh stopped-worker, actual source obligation and private lease/dispatch epoch evidence; stale drafts and isolated test receipts cannot authorize it. No historical bulk replay or downstream integration is included.
