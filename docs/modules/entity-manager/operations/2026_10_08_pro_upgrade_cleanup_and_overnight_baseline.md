# 8 October — Pro upgrade, cleanup and overnight baseline

The owner upgraded the Supabase organisation to Pro and authorised a fresh
cleanup/restart. Management checks confirmed `plan=pro`, responsive SQL and
`transaction_read_only=off`. This clears the earlier database-availability
block; it does not establish that every article or semantic decision succeeds.

The implementation boundary remains **Scout → Intake → Researcher → Entity
Manager → private durable knowledge**. No downstream adapters, public
projection, API/UI change, web search or new claims/evidence contract was added.
Editor and Publisher retain their existing legacy path. Polymarket remains
collection-only, with no Research or Entity Manager authority.

## Accepted recovery before expansion

The selected outage canary completed with an accepted private receipt at
**14:29:45 UTC / 19:59:45 IST**:

- Work: `work_3810b1b07df41a40a67a35560faca49a`.
- Packet: `research_b858867404b7955df299ddabee7b68f9`.
- Item: `94229ffb-cd9e-53a8-861d-6bb986a8ea5e`.
- Title: “Cardano sets a 329 TPS mainnet throughput record, per Chainspect data”.
- Full captured text: **12,827 characters**, without truncation.
- SQLite packet, PostgreSQL source packet and stored article hash all match:
  `16664285cacb53c7e3e013c4f5f52a0eaa7b4d2716ae6995e6ab13234a621ec4`.
- Writer execution: `ollama-cloud / glm-5.3-flash`, no fallback.

This accepted receipt satisfied the required canary before selected bulk
recovery. It was not replayed during cleanup.

## Backup and bounded cleanup

Research and Entity Manager were drained, all six non-API processes stopped,
and both SQLite stores had zero active leases. Online backups were verified
against the source counts, integrity/schema/hash checks and actual restored
copies. Classification SQLite also passed its backup/integrity/hash check.
The News backup is **1,619,165,184 bytes**, SHA-256:

```text
dfffc63b18cbdb125abd637113d8ec8f21ebbf5691ec66ea536aa472df39f6e1
```

The private backup, original states, frozen plans and receipts are under
`packages/collectors/.data/backups/overnight-cleanup-20261008/`. These contain
private data and are excluded from Git. This document records the portable
handoff; a fresh checkout does not contain production databases or credentials.

The frozen News queue contained **833 dead letters**. Cleanup separated them:

- **269** exact database-outage jobs were requeued to `synthesis_pending`
  through the existing canonical, backup-gated recovery operator. Every job
  was rechecked for freshness, a full admissible source capture, and absence
  of a packet, V4 result, paid execution or reservation across its entire root
  assignment, including siblings. All attempts, original deadlines, immutable
  capture hashes and paid-state tables were preserved. Each transition has a
  canonical recovery audit event.
- **564** other historical terminal jobs were archived in an explicit frozen
  transaction with exact status/timestamp/work-JSON comparisons. Cleanup audit
  events retain their previous work state and reason. Failure details,
  attempts, deadlines, sources and artifacts remain stored. Hash checks
  covered the preserved source, readiness, ownership, packet, financial and
  execution records, plus every non-target work row. Archiving is not a fix or
  a claim that those articles succeeded.
- **84** already-pending Research jobs were preserved.
- Polymarket had no dead-letter/retry queue to clear.
- Two abandoned Publisher run records from **00:09 and 00:14 UTC** were closed
  as failed using exact ID/status/timestamp comparisons and a retained audit
  record. Their original records were saved privately. No publication data was
  deleted or resent.
- Twelve non-API PM2 logs were compressed, restored/hash-verified and then
  truncated while their processes were stopped. API logs were untouched.

All **87 historical unknown paid outcomes** remain held in the News reservation
table: 25 primary syntheses, two entity proposals and 60 classifications,
originating on 3–7 October. Archiving their queue rows does not release their
reservations. A timeout or missing response is not proof that a provider did
not execute; reconciliation still requires matching durable/provider proof.
One separate `reserved_not_dispatched` reservation also remains unchanged.

## Overnight baseline

Baseline: **15:15:25.887 UTC / 20:45:25.887 IST, 8 October**. Before restarting:

| News work status | Count |
| --- | ---: |
| Archived | 17,488 |
| Complete | 11,741 |
| Research pending | 84 |
| Synthesis pending | 269 |
| Dead letter / retry wait / active lease | 0 / 0 / 0 |

PostgreSQL at **15:13:39 UTC** held **1,589 accepted receipts** and **1,315
managed items**. These are independent counts: duplicate attachment can accept
a source without creating another item.

Both durable worker controls were resumed. The six named processes were
started individually and PM2 state saved privately. Every action asserted the
protected API identity: PID **2468463**, restart count **2**, uptime
**1791458762801**. No API process action, source change, test or request was
performed.

### Actual fresh cycles

Read-only follow-through at **15:20:44 UTC / 20:50:44 IST**:

| Process | Fresh evidence | PM2 PID / restart count |
| --- | --- | --- |
| `myboon-news-feed-ingestor` | Completed at 15:15:56 UTC: 50 candidates, 16 new, zero failures. | 2490981 / 2 |
| `myboon-feed-v3-research` | Both storage readers healthy; successful Ollama synthesis and durable handoffs. | 2490928 / 11 |
| `myboon-feed-v3-entity-manager` | Fresh accepted private receipts; News completions rose from 11,741 to 11,744. | 2490875 / 1 |
| `myboon-polymarket-data-engineer` | SQLite run ledger completed at 15:15:45 UTC: 2,456 markets fetched, 98 watchlist updates, 29 deliveries, zero failures. Collection only. | 2491035 / 1 |
| `myboon-editor-draft` | First cycle hit a statement timeout at 15:15:46 UTC; PM2 restarted it. PostgreSQL records the next run succeeding at 15:16:00 UTC with zero eligible bundles/drafts/failures. No subsequent stderr growth during this observation. | 2491241 / 4 |
| `myboon-publisher` | PostgreSQL records successful cycles at 15:15:36 and 15:20:37 UTC; zero eligible drafts/publications. | 2491139 / 1 |

All seven PM2 entries were online, with the protected API identity unchanged.
One Entity Manager lease was still in flight. **Zero fresh dead letters/retry waits**
and **87 unchanged unknown paid outcomes** were observed at this checkpoint.
The Editor's initial transient error remains in the fresh log/run history;
it was not hidden by another log cleanup. Its hourly schedule has produced
one clean recovery cycle, not a second scheduled hourly run in this window.
Publisher's idle success is not publication-output verification.

Two explicit post-restart acceptances were checked against both PostgreSQL
article/source-packet hashes and the pre-recovery SQLite full-capture hashes:

- `work_a64f0954726cc56644de0ab2e6f17885`, accepted **15:17:35 UTC**,
  205-character source, item `f0fed6dd-db16-5150-bea4-85a3cc0fc50b`, hash
  `fb29d06d8a4024e045f942b76caa99e4b545fe3799b9a9a6e9514b33778f716d`.
- `work_b0cffaef5bc52946934008495dce26b6`, accepted **15:18:42 UTC**,
  2,274-character source, item `0966480c-37af-582a-8abd-10cbd72311c4`, hash
  `8e2336e74862f063e14a64129f9d08619229730f1044a2e795178a682546b430`.

Both writer packets used **Ollama Cloud / GLM-5.3 Flash**, valid structured
output and no fallback. This verifies preservation and actual persistence;
it is not independent verification of claims made by the source articles.

New failures after this baseline remain visible; do not archive them merely
to make the overnight totals zero. The full overnight result is pending.

## Next morning review

Compare actual durable progress since this timestamp, not only PM2 `online`:

1. Confirm all six process identities are stable and the API identity unchanged.
2. Count completed/accepted News work, pending work, new failures by reason,
   retry waits and lease ages. Check both article storage readers and original
   freshness deadlines. The recovered jobs retain their old expiry times.
3. Check new accepted items for full capture hash, dated prose, placement,
   meaningful related memberships and exact historical links. Treat broader
   Jev accuracy and prose quality as separate review, not completed validation.
4. Count unknown paid holds against **87** and inspect any new ones. Do not
   reset allowance/call state or resend uncertain calls.
5. Verify successful actual News collection, Polymarket collection, legacy
   Editor and Publisher cycles. Zero eligible Editor/Publisher input is a
   valid idle cycle, not proof of draft creation or publication.
6. Review new log errors against the archived pre-baseline logs. Preserve
   genuine source, input-bound, identity/history and model-output failures.

Use the existing host-private runtime configuration and read-only status tool
from `packages/collectors/`:

```bash
pm2 list
pnpm exec tsx src/signal-platform/run-status.ts
```

This operational cleanup changed no application source. The focused outage
regressions and collectors TypeScript results remain in the
[outage record](2026_10_08_database_outage_recovery.md); no broad tests or API/UI
checks were repeated. The temporary archive helper passed isolated preservation,
stale-state and idempotence fixtures; production apply additionally checked
the verified backup, exact frozen states and preserved-table hashes.

Issue **#299 remains open** for the overnight result and retained bounded
failures. Downstream integration remains outside this checkpoint.
