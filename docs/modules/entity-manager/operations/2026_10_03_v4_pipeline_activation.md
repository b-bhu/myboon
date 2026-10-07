# Issue 299 — production pipeline activation

> Historical record for the 3 October implementation/validation phase. For the current article contract, scope and operating checkpoint, use the [working PRD](../PRDs/v4_prd.md) and [5 October handoff](2026_10_05_v4_entity_manager_checkpoint_handoff.md). These dated results do not establish the current profile/model settings or new article semantic quality.

Date: 2026-10-03. Times below are UTC; add 05:30 for Kolkata.

The four internal pipeline processes have restarted and their running configuration has been saved in PM2. News is producing accepted private knowledge through the shared Research and Entity Manager workers. Polymarket collection and intake are running, but its current material signals select standard research and are deferred by the existing light-only configuration. This record supersedes the **operating status** in the earlier [live validation record](2026_10_03_v4_live_validation_record.md), which remains the evidence for its earlier frozen candidate.

Scope remains Scout → Intake → Research → Entity Manager → private durable shared knowledge. No downstream integration, historical bulk replay or historical freshness rewrite was performed. The existing `myboon-api` process was not restarted, reloaded or reconfigured.

## Running processes and persistence

| Process | Final PID | Status | Restart count |
|---|---:|---|---:|
| `myboon-news-feed-ingestor` | 1861434 | online | 0 |
| `myboon-polymarket-data-engineer` | 1861502 | online | 0 |
| `myboon-feed-v3-research` | 1848825 | online | 8 |
| `myboon-feed-v3-entity-manager` | 1848772 | online | 0 |
| Protected `myboon-api` | 1719088 | online, unchanged | 1 |

Research's eight restarts belong to the earlier startup failure caused by the root-owned classification SQLite files. A verified backup preceded a narrowly scoped ownership/permission repair; the classification database was retained. Its restart count did not increase during the final operating window.

Both shared workers started at approximately 15:08:43–45. Only the collectors were subsequently stopped and started at 15:45:18–39 to load the corrected capacity calculation. Research and Entity Manager continued running. Every targeted PM2 action compared the API's PID, status, restart count and uptime to the original baseline (`1719088`, `online`, `1`, `1791000387540`).

PM2 saved the running configuration at 15:47:17. The saved definitions were verified against the four exact scripts and working directories. `dump.pm2` and its backup have mode `0600`. Persistent private release configuration is in `/home/ubuntu/.config/myboon/entity-v4-release-20261003` (directory `0700`, files `0600`); it contains no API definition. No host reboot or API action occurred.

The active route is `openai-codex/gpt-5.6-luna`, with both News and Polymarket configured in the shared workers. Novelty, evidence reuse, bounded follow-up, managed context and the private writer are composed. Standard search and deep research remain disabled. The version is `myboon.entity-v4.release.20261003.v1`; the immutable V4 policy digest remains `0cbf04b5bb2e8884e8f259a839e1accd834c47af55ca8806187c15177698138e`.

## Source ownership and real data

Both actual source stores were upgraded additively, backed up and verified through disposable restores. Both authorities are at revision **2**, state `running`, with shared collector/intake/research/entity ownership and legacy queue admission disabled. The News and Polymarket initialize/resume receipt chains are retained with their exact reviewed execution-time evidence.

News started first and produced real packets and accepted private commits before Polymarket was enabled. At the final hosted read-only snapshot, 15:46:41–50:

- News had **45 accepted operations**, **41 immutable knowledge items**, **153 evidence links**, **90 history events** and **38 grounded identities**.
- All checked effect groups had **zero orphan effects**: accepted receipts account for identities, items, evidence, item sources, membership changes, developments and history.
- Sixteen released unfinished operations remained held: nine for identity grounding and seven for returned-proposal validation. Their outcomes were preserved. There was no unexplained operation or planning-dispatch reconciliation hold at that snapshot.
- The previously retained AAVE/Stellar/Solana requests still had **2/1/1** paid dispatches. Unrelated commits and newer planning epochs caused no additional paid dispatch for those same requests.
- Polymarket had **zero managed source registrations or private commits**. Collection success is not evidence of a completed Polymarket Research/Entity write.

Polymarket's first cycle collected 2,280 markets, maintained 92 watchlist entries and delivered 45 signals. All 45 deferred. A read-only preview reproduced the original capacity deferral, then showed that excluding expired, unclaimable backlog removes the false capacity pressure. The same signals still require **standard** research and therefore defer under the current **light-only** capability. Existing decisions were not rewritten or retriaged, and research depths were not expanded.

The post-fix collector reload completed a fresh Polymarket cycle at 15:45:40–42, collecting 2,280 markets with 93 watchlist entries. Its **15 delivered signals** all deferred for unsupported standard depth, with **no capacity-pressure deferrals** and no new Polymarket work. News's first cycle after its own restart finished at 15:45:36, delivering four new observations and four light-research admissions without intake failures. At the final source audit, two of those work rows were complete, one was waiting to retry and one was in the dead-letter queue; successful admission does not mean every assignment completed.

The final source audit completed at 15:54:14. All original **66 expired News rows and 45 expired Polymarket rows** matched the verified backups in every field, including attempts, leases, timestamps and canonical JSON. Both executed ownership receipts and all shared/legacy fences remained intact. News retained one genuine unknown Research outcome and had no current dispatch-intent reservation at that snapshot; Polymarket had no paid exposure.

## Activation fixes and verification

The activation added four narrowly scoped corrections to the earlier full validation candidate:

1. Report saved delivery decisions and work counts correctly, including lost acknowledgements and idempotent retry.
2. Stop ungrounded Entity proposals before provider dispatch and reuse an already recorded identical planning request across knowledge epochs. Returned invalid outcomes remain held rather than being bought again.
3. Repair the actual native Polymarket fence triggers to use its real lease columns. Trigger replacement is atomic and supports nested transactions. The actual repair changed two trigger definitions, wrote **zero source rows**, preserved source authority and allowed completion/cleanup while fencing new legacy claims and renewals.
4. Calculate triage capacity at the supplied time. Expired unclaimable work consumes no queue capacity; live leases and unresolved paid exposure remain conservatively counted.

The final merged verification passed **86 affected regressions**, **7 explicitly enabled isolated internal-chain tests**, the collectors TypeScript check and the diff check. The default regression invocation skipped the opt-in internal chain, which was then explicitly enabled and passed all seven tests. The unchanged Entity files retain their separately completed **31/31 PostgreSQL** validation. The earlier full candidate's 1,438 collector tests, 195 API tests and live decision/model evaluations are recorded in the linked live validation report; those totals are not presented as a rerun of the activation delta.

A 106.7-second post-reload read-only window confirmed stable process identities and restart counts, fresh running worker heartbeats and successful Luna synthesis/Entity calls. One earlier News synthesis reservation remains `execution_outcome_unknown` after structured output failed validation at 15:26:46. Its work is in the dead-letter queue. The exact assignment contains one settled novelty call and one unknown primary synthesis attempt, with no replacement synthesis reservation; the hold remained unchanged across the observation window. Other work continued successfully. No observer settled, released or relabelled this outcome.

The live source-obligation counter named `unknownPaidOutcomes` conservatively includes both `dispatch_intent` and `execution_outcome_unknown`. Its value of two at 15:51:14 partitions into one normal in-flight call and the one retained unknown outcome on a different assignment. It does not establish two unknown outcomes or contradict the separate private planning snapshot.

Production token counts are gateway estimates and monetary usage is unknown. The installed Codex transport does not enforce the profile's native output-token ceiling; that previously documented limitation remains. No USD approval gate was introduced.

## Frozen candidate and evidence

The final source/configuration/migration candidate contains **676 files**, with **12 changed or added paths** relative to the earlier full validation candidate. Source hashes were rechecked after activation. Credentials, runtime databases, mutable evidence documents and unrelated user changes are excluded.

| Artifact | SHA-256 |
|---|---|
| `activation-complete-candidate.json` | `e88afcd0af269c71562d9321c97b6494bba591aec2c56d194d8183508022fb10` |
| `activation-complete-candidate.tar.gz` | `bb0afb98db21c5766ecbcd471336d8988a8a9e59210e214906fcb36fdee08bd0` |
| `activation-complete-delta-validation.json` | `bbb0cf346a86521fac3c285cbcfae7c48361a256c156aba588be0ff45c224a25` |
| Final hosted read-only summary | `53e2cd3feb64f2fa7517936610c3346d6faaf824b9ffc84b936c005286c9dbdb` |
| Final post-reload health summary | `3d7bee891dd3f71b2e1d55f92eb74828138330a539214092dc31b4c044d92792` |
| Final read-only source audit | `41546f8137890b5002f27602b2f221011d3c22db391f0a27c3d932bc93fb9522` |

Private evidence is retained in `/tmp/myboon-v4-activation-20261003`. Its final activation evidence manifest binds the candidate, delta validation, protected API baseline, process actions/persistence, source ownership receipts, backup/restore proofs, actual trigger repair, capacity preview, fresh health/source audits and this record. Earlier evidence files remain unchanged.
