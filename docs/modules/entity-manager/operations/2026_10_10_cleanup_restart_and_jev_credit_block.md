# 10 October — cleanup, restart and Jev credit block

The owner authorised clearing old pipeline work and restarting the systems for
an overnight observation. All six non-API PM2 processes were started using their
existing saved settings. Research initially paused because Jev had no API
credits. **After the owner restored credits, Research resumed at 21:56 IST and
two fresh articles were accepted by Entity Manager.** All six pipelines remain
online. The initial blocker and the subsequent recovery are recorded below;
the complete overnight observation is still pending.

`myboon-api` remained online throughout: PID **2468463**, restart count **2**,
uptime **1791458762801**. No API restart, request, log cleanup or source change
was performed. Polymarket remains collection-only. No downstream integration
or application source change was introduced.

## Cleanup and preserved state

With all six pipelines stopped and no active work leases, News, Polymarket and
classification SQLite were backed up and verified. News and Polymarket backups
were also restored and checked. The verified News backup is **1,702,436,864
bytes**, SHA-256:

```text
08c6e9df9d50ee8a8c382098d39f977485ead0923a86995b99e75786b5174ae2
```

The frozen News backlog comprised **106 dead letters, 15 Research pending jobs
and one retry**. All **122** were archived through exact prior-state comparisons
and cleanup audit events. Original work JSON, source captures, failure details,
attempts, deadlines, packets, receipts and paid reservations were preserved.
Restored-copy checks verified preservation, stale-state refusal, transaction
rollback and idempotence before the live apply. Archiving removes old work from
the active queue; it does not mean those articles succeeded.

Polymarket had no active backlog. Both source delivery outboxes had no pending
entries, and PostgreSQL had no abandoned runs marked `running`. Historical
legacy failures and publication records were retained. Twelve non-API logs
totalling **42,038,834 bytes** were compressed and hash-verified before truncation
while stopped; API logs were untouched.

Private backups, frozen plans, before/after states, audit receipts, diagnostic
results and operator helper hashes are retained on this VPS under
`packages/collectors/.data/backups/overnight-cleanup-20261010/`, excluded from
Git. Verified backup files remain; the disposable restored/rehearsal copies
were removed after successful live validation, freeing approximately 2.1 GB.
A fresh checkout does not contain production data or credentials.

## Restart baseline and actual progress

Restart baseline: **15:58:38.951 UTC / 21:28:38.951 IST, 10 October**.

| Store | Complete | Archived | Pending / retry / dead letter / leases |
| --- | ---: | ---: | --- |
| News | 12,155 | 17,610 | 0 / 0 / 0 / 0 |
| Polymarket | 600 | 4,087 | 0 / 0 / 0 / 0 |

The **149** historical unknown provider outcomes stayed held, along with the
one `reserved_not_dispatched` reservation. No uncertain execution was released
or replayed. PostgreSQL held **2,003 accepted receipts** and **1,651 managed
items** before restarting.

Both durable worker controls were initially resumed. Six exact PM2 names were
started individually, preserving their saved batch sizes, credentials, source
modes and Ollama Cloud / GLM-5.3 Flash writer settings. PM2 state was saved
privately. The bounded history cache and five-minute healthy storage probes
from commit `86b983304f9d3b88f6a78a1a0a199ff840d4822b` are active after this restart;
Research reported a healthy check at 15:58:55 UTC and its next probe five minutes
later.

Follow-through at **16:03:04 UTC / 21:33:04 IST**:

| Process | Fresh evidence | PID / restart count |
| --- | --- | --- |
| `myboon-news-feed-ingestor` | Completed 15:59:22 UTC: 50 feed items, 48 new candidates, seven admitted jobs, zero intake failures. | 2710587 / 2 |
| `myboon-polymarket-data-engineer` | Completed 15:58:54 UTC: 2,152 markets fetched, 95 watchlist updates, zero new candidates. Collection only. | 2710650 / 1 |
| `myboon-editor-draft` | PostgreSQL records a successful cycle finishing 15:58:59 UTC: zero eligible bundles, drafts or failures. | 2710712 / 4 |
| `myboon-publisher` | PostgreSQL records a successful cycle finishing 15:58:51 UTC: zero eligible drafts or publications. | 2710772 / 1 |
| `myboon-feed-v3-research` | Started, checked both storage readers and processed seven jobs; now draining with zero active leases because Jev rejected requests. | 2710519 / 11 |
| `myboon-feed-v3-entity-manager` | Healthy idle cycles; no new Research packets reached it. | 2710458 / 1 |

All seven PM2 entries remained online with stable identities and zero fresh
stderr bytes at this observation. PM2 `online` and empty stderr do **not** mean
Research succeeded: failures are stored in the canonical queue and stdout.
There were **zero new accepted receipts, items or Research packets**. Editor and
Publisher idle success does not verify draft creation or publication output.

## New blocker and current operating state

Five new jobs received **HTTP 402** from Jev. A separate valid, minimal request
using the configured `jev-1.13.0` model confirmed at **16:02:31 UTC / 21:32:31
IST** that the organisation has no available TypeSafe API credits. The provider
identifies this as `billing_error` and points to
[TypeSafe billing](https://console.typesafe.ai/settings/billing).
This is separate from Supabase: both storage readers responded successfully.

The current adapter categorises HTTP 402 as `invalid_structured_output`, which
is misleading for these five failures. It also retains their execution outcomes
as uncertain, raising the unknown-outcome count from **149 to 154**. These holds
were preserved; a billing error was not used to bypass reconciliation rules.
Two other new jobs failed required source retrieval. All **seven fresh dead
letters** remain visible for diagnosis; they were not cleared again to hide the
failed restart check. There were no pending/retry jobs or active work leases at
16:03:04 UTC; collection can admit additional work while Research is paused.

Research was put into durable `draining` mode after the failures appeared.
Its PM2 process remains online, but it claims no new jobs. Entity Manager stays
running and idle. News collection, Polymarket collection, Editor and Publisher
remain scheduled. No automatic account top-up, provider replacement or replay
was attempted.

## Resume and next morning review

1. Restore TypeSafe credits and verify one bounded Jev request succeeds before
   resuming Research. Do not resume solely because PM2 says `online`.
2. Review the five new held reservations with durable provider proof before any
   replay. Inspect freshness and retry authority for retained/new pending work;
   do not reset attempts, deadlines, allowance counters or uncertain outcomes.
3. Once the blocker is cleared, resume the existing durable Research control
   from `packages/collectors/` using the host's existing configuration:

   ```bash
   pnpm exec tsx src/signal-platform/run-runtime-control.ts --stage research --action resume --path /home/ubuntu/myboon/packages/collectors/.data/feed-v3-runtime-control.json --apply
   ```

4. Verify an actual fresh packet and an accepted private Entity Manager receipt,
   preserving the full source hash, dated writing and selected memberships.
5. For the morning observation, compare new collector runs, process restarts,
   queue failures, pending/lease ages and the **154** unknown outcomes against
   this checkpoint. Retain fresh errors. Distinguish collector/legacy idle
   cycles from the blocked end-to-end Research test.

The dedicated writer's optional operational-status request returned SQLSTATE
`42501` during a diagnostic. Read availability was established through the real
article-context and REST readers; aggregate persistence counts were checked
through the management SQL tool. No permissions were widened.

This operation ran backup/restore and isolated cleanup-safety checks, plus live
read/process/run/queue observations. No application tests, broad TypeScript
checks, API checks or new provider-routing changes were needed. The existing
[read-efficiency validation](2026_10_10_research_read_efficiency.md) remains the
implementation checkpoint. At the initial checkpoint, the complete overnight
Research test was unverified and blocked on Jev credits.

## Credits restored and Research resumed

The owner restored TypeSafe credits. A bounded request with the configured
`jev-1.13.0` model returned **HTTP 200** at **16:26:07 UTC / 21:56:07 IST**.
Both private article-context and REST readers passed a fresh availability
check at 16:26:11 UTC. The existing Research control was resumed at
**16:26:20.744 UTC / 21:56:20.744 IST**, revision **40**. No process restart,
provider change, queue replay or API action was needed.

The two freshly admitted jobs waiting while Research was paused then completed:

| Work | Development | Accepted UTC / IST | Item |
| --- | --- | --- | --- |
| `work_f0461983a025244ec7678ff74c8ca8b3` | Joao Wedson's altcoin-season outlook | 16:27:23 / 21:57:23 | `6de57bea-0150-524e-baf3-248b3f417366` |
| `work_5bef39b4f2fda561659a4a62525fe27d` | Hyperliquid protocol revenue and HYPE buybacks | 16:28:21 / 21:58:21 | `0c5bf472-9229-5044-843f-7fb8d039f5d5` |

Both have accepted PostgreSQL receipts. Their original full captures of
**2,970** and **1,530** characters remain untruncated; local packet SHA-256
hashes match the persisted article text hashes. PostgreSQL also confirms the
stored capture and response-byte hash match the immutable source packet.
Both writers used **Ollama Cloud / GLM-5.3 Flash**, valid structured output and
no fallback. This proves two successful end-to-end processing/persistence
examples, not independent accuracy of the articles or model judgements.

At **16:28:29 UTC / 21:58:29 IST**, News completions increased to **12,157**.
No pending/retry work or active leases remained, and no new dead letters or
unknown provider outcomes appeared after resumption. The seven earlier restart
failures and **154** uncertain outcomes remain preserved; they were not
automatically replayed. All six pipelines and the protected API retained their
same online identities and restart counts. Research and Entity Manager both
reported `running`.

Recovery diagnostics, before/after observations and accepted source-hash proof
are retained privately under the existing archive's `credit-recovery/`
directory. For the morning check, use the **21:56:20 IST resumption** and
**12,157 completions / seven existing dead letters / 154 uncertain outcomes**
checkpoint to identify subsequent work and failures. The full overnight result
remains pending.
