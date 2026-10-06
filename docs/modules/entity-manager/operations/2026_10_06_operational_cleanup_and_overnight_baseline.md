# Operational cleanup and overnight baseline

Date: 6 October 2026, UTC. Implementation scope remains Scout → Intake → Researcher → Entity Manager. Existing Editor and Publisher services continue their legacy publication path; no V4 downstream integration was added.

All seven remaining PM2 services are online. The six non-API services were restarted with the fixes, their previous logs were archived, and the PM2 process list was saved. `myboon-api` was not restarted or reconfigured: PID 1719088, restart count 1 and uptime identity 1791000387540 remained unchanged. Its HTTP health endpoint returned 200.

Research and Editor use Ollama Cloud / `glm-5.3-flash`. Automatic GPT fallback remains disabled. Polymarket continues collection and source delivery; its Research and Entity Manager admission remain disabled.

## Corrections activated

- Saved PANews retrieval plans now accept the reviewed publisher migration to `panews.io`. An unapproved starting host or unrelated redirect is still rejected, and every resolved address must be public.
- Deterministic extraction can read a publisher's structured `articleBody` when its article URL matches the fetched page. Conflicting or unrelated article records fall back to visible-page extraction. This preserves article text while excluding large navigation and metadata payloads.
- Research and structured writing select the newest immutable capture of the original article. Older captures remain available as history.
- Article writing passes its approved input, output and cost allowances to the provider gateway. The production synthesis policy is `myboon.entity-article.synthesis.20261006.v2`, with 64,000 input tokens and 16,000 output tokens; these are bounds, not a target response size.
- Active admission budget policy v3 allows 180 seconds, at most two generation calls and one structured-response repair. The second call is available for repairing a received response; an unknown paid outcome is still held. The policy was explicitly refreshed for 275 undispatched queued jobs, without resetting dispatched reservations.
- Research health counts all unresolved paid reservations. The previous bounded-list calculation could hide older holds beyond its first 1,000 records.
- Polymarket no longer inserts or reports backpressure for a retired legacy research queue. Observation storage and source delivery continue.
- Normal interval overlap is quiet. A genuinely prolonged run still produces a bounded warning, so normal processing time does not flood error logs.

The earlier candidate-resolution, relationship-consistency, safe HTTP and article-extraction fixes are also active. Entity identity collisions still require a real placement decision; no heuristic attachment or automatic merge was introduced.

## Queue cleanup and retained failures

Before changing work states, the News, Polymarket and classification SQLite databases were backed up through SQLite's online backup API. All three backups passed `quick_check`. Every cleanup transition records the original work JSON, prior status, reason and backup receipt in `signal_platform_cleanup_events`. Source identities, article chronology, original attempts and accepted knowledge were preserved.

The first recovery pass admitted 218 source-capture jobs and 114 saved article packets. The latter contained historical Jev creation decisions that now collide with existing entities. Replaying Entity Manager does not ask Jev to make a new decision, so all 114 packets were quarantined again. They require a separately admitted fresh Research placement decision; they are not counted as recovered articles.

The 218 recoverable source-capture jobs were requeued. Their processing deadlines were explicitly renewed; their source publication dates were not changed. Historical failures, expired work, unavailable sources and unresolved placement or paid outcomes were archived with their original failure records. At the baseline, 21,011 canonical work records were archived across News and Polymarket.

There are 31 retained reservations with unknown paid outcomes. The initial 27 were reconciled against the full local reservation set and authoritative saved-response references; none had a matching response that could safely settle the call. Four additional startup attempts hit the old output/time bounds before the final policy refresh and were also quarantined. These calls were not silently resent or marked successful. One separately fenced reservation that had never been dispatched was released without a provider call.

Six abandoned SQLite pipeline runs and 18 abandoned public database pipeline runs from July/August were closed as failed, with cleanup attribution and before-state receipts. Existing failed-run history, legacy candidate/result records, private hold history and accepted items were retained. Those historical records are not the active queue owner.

At the baseline, the active canonical queues had **zero `dead_letter` and zero `retry_wait` records**. Archived cases remain available for review; this is not a claim that every historical article was recovered.

## Verification

Focused retrieval, source safety, capture selection, placement, persistence, budget durability, queue-boundary and interval tests passed. The collectors TypeScript check passed. One optional PostgreSQL integration test was skipped; actual production Entity Manager writes were verified separately.

A real PANews request succeeded through the reviewed domain migration. A captured Benzinga page reduced from roughly 31,000 characters of page content to its complete 3,855-character structured article body, without truncation.

Fresh Ollama Research output completed through Entity Manager after activation, including the Canary Capital staked INJ ETF development, a Trump memecoin gala development, and LayerZero's ZRO buyback. At the verification snapshot, private article items increased from 433 to 437 and accepted receipts from 641 to 645. Public memories remained at 47,598. The existing Publisher independently increased published narratives from 1,649 to 1,651.

## Baseline for the next morning

The machine-readable baseline was captured at **2026-10-06 15:28:24 UTC**:

`packages/collectors/.data/backups/operational-cleanup-20261006/overnight-baseline.json`

| Queue | Complete | Research pending | Synthesis leased | Archived | Dead letter / retry wait |
| --- | ---: | ---: | ---: | ---: | ---: |
| News | 10,799 | 268 | 1 | 16,924 | 0 / 0 |
| Polymarket | 600 | 0 | 0 | 4,087 | 0 / 0 |

All 2,096 News source deliveries and 643 Polymarket source deliveries were delivered at that snapshot. Non-API error logs were empty. Work can advance after this timestamp; the baseline is the comparison point, not a frozen queue.

For the next check, compare:

1. PM2 process identity and restart counts against the saved baseline; confirm API identity separately.
2. New completions, accepted receipts, retries, dead letters and paid holds since the baseline. Separate historical quarantines from fresh failures.
3. Queue age and delivery progress, Research provider health, and Entity Manager acceptance.
4. Editor and Publisher progress on their existing path; Polymarket observation delivery without Research admission.
5. New log content after the saved byte offsets, rather than counting the archived historical errors again.

The private host-local archive contains the three database backups, cleanup plans and transition receipts, reservation reconciliation, abandoned-run receipts, compressed previous logs and protected PM2 action receipts. Verification outputs are under `/tmp/myboon-operational-cleanup-20261006/`. These files are operational evidence and are excluded from repository delivery.

The source fixes, service retirements and updated handoff are included in the cleanup commit on `main`. Credentials, databases, backups and PM2 runtime state remain host-local and are excluded from repository delivery.
