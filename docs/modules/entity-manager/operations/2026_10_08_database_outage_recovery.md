# 8 October — database outage and article queue protection

**Later recovery:** the owner upgraded to Pro, database access recovered and
the selected article received an accepted private receipt. The subsequent
[cleanup and overnight baseline](2026_10_08_pro_upgrade_cleanup_and_overnight_baseline.md)
records the 269-job selected recovery, historical archive and protected
restart. The timestamps and blocked state below are the earlier incident
evidence, not the current operating status.

The News article code remains scoped through Entity Manager. This repair adds
no downstream integration, provider fallback, web search or claim/evidence
contract. Existing Editor, Publisher and Polymarket schedules have their own
database dependency; restarting a process cannot repair that hosted dependency.

## Incident evidence

At **11:33:31 UTC / 17:03:31 IST**, all seven PM2 processes were online, but the
latest completed News job was **00:03:48 UTC / 05:33:48 IST**. Since the previous
morning's activation there were 630 completed jobs and 687 new dead letters;
544 of the failures were labelled entity resolution. That label combined real
identity problems with temporary storage failures.

The reproduced outage message was:

```text
Article placement is held because catalogue/history coverage failed:
article managed catalogue search: Error: Connection terminated due to connection timeout;
article legacy catalogue search: Error: article entity lookup failed: Could not query the database for the schema cache. Retrying.;
article legacy source entity lookup: Error: entity_memories lookup failed: Could not query the database for the schema cache. Retrying.
```

Direct verified-TLS queries using the configured restricted Research identity
could not establish a connection within 15 seconds or a single diagnostic
45-second window. An independent management SQL query also timed out. The
official project metrics endpoint returned HTTP 504. Hosted logs recorded
several small settings/monitor queries taking 10–15 seconds. Host disk and
memory were available, and Supabase's public status reported no active regional
incident. These observations establish project database unavailability; they
do not identify its CPU, memory or connection-limit root cause.

The latest sampled Editor, Publisher and Polymarket runs also failed with
upstream database timeouts. There is no claim that their schedules completed
successfully merely because PM2 reports them online.

## Implemented protection

- Probe the actual private Research context reader and legacy catalogue reader
  before allowing article claims. Use the existing restricted writer function
  and verified TLS; introduce no admin fallback or new database grants.
- Cache healthy probes for 30 seconds and back off failed probes through
  30, 60, 120, 240 and 300 seconds. Probes are shared across concurrent cycles.
  A later storage failure invalidates the gate; stale probe completion cannot
  reopen it. Non-article source policy remains independent.
- Bound legacy HTTP reads to 15 seconds. Private reads keep their existing
  connection/statement/query limits. No timeout is increased blindly.
- Preserve Supabase error codes and causes. Distinguish transient connection,
  schema-cache, network and overload errors from permanent missing-schema or
  identity errors. Mixed permanent/transient coverage failures remain held.
- Prepare initial article context before incrementing an execution attempt.
  Dependency failure becomes `storage_transient` / `retry_wait`, without a new
  paid reservation. Heartbeats cover this read; ownership and freshness are
  checked again before execution starts.
- A transient history failure after paid decisions retains the same durable
  results and allowance. Storage outage remains retryable at the execution
  attempt cap, while the original freshness deadline still expires normally.
  No unknown paid dispatch is replaced or released.
- Stop a worker's remaining batch when storage fails, then let the shared
  claim gate stop further article claims. Idle workers do not repeatedly peek
  throughout an otherwise empty batch.

The availability gate protects initial admission; per-job coverage and lease
checks remain authoritative if a dependency fails after a successful probe.

## Backup and recovery boundary

Research was drained before operational changes. News was briefly stopped for
a consistent online SQLite backup and then restarted. The verified private
backup is **1,612,546,048 bytes**, SHA-256:

```text
29a8fb360ba2d587fca8562bb033b9f9abb9fdf1d1bad3fe2f9ac65caa10e2b6
```

The host-private backup and receipt are under
`packages/collectors/.data/backups/db-outage-20261008/`. Credentials, article
bodies and database files are excluded from Git; this document is the portable
handoff, not a requirement to retrieve that private archive from GitHub.

Read-only audit at **11:49:28 UTC / 17:19:28 IST** found 446 News dead letters
with the exact outage coverage prefix since 00:04 UTC. All had a complete,
untruncated 2xx source capture and no canonical Research packet. **445** had
no reservation or matching V4 paid result for their exact root assignment. One job had
seven settled paid decisions and was excluded from pre-decision recovery:
`work_b8f83ca261198a3e90e982b3bf8d9140`.

Ten eligible IDs were dry-run through the existing canonical recovery operator;
all matched `synthesis_pending` and no rows changed. Four eligible rows are
already at attempt count three. Their attempt counts, original deadlines,
source captures and ledger must remain unchanged during recovery.

A stricter root-wide audit at **12:08:50 UTC / 17:38:50 IST** also checks sibling
jobs: an old canonical packet or paid execution on the same assignment makes
the initial count insufficient for recovery. **270** jobs pass the complete
root-wide packet, V4 record, paid-execution and reservation checks. All 270
also have full 2xx captures within the actual 48,000-character source bound.
Do not confuse extracted-text characters with HTTP-response `byteLength`.
The first proposed example was stopped before any mutation because an archived
sibling had a canonical packet.

One stricter candidate, `work_3810b1b07df41a40a67a35560faca49a`, was restored to
`synthesis_pending` through the canonical backup-gated recovery path. Its
**12,827-character** capture, attempt count and original freshness deadline
(`2026-10-08T23:25:13.747Z`) are unchanged; no paid state was created or reset.
The private audit receipt is retained alongside the backup. The other 269
clear candidates have not been recovered pending live acceptance proof.

Recovery must use explicit work IDs, a verified backup receipt and the existing
CAS-fenced audit path. Recheck freshness, exact root paid state, saved capture
and absence of a canonical packet before applying. Prove one eligible article
reaches an accepted private receipt before expanding the selected batch. Keep
the other historical identity/source failures and all unknown paid holds.

## Activation and outstanding live proof

Research loaded the protection and resumed with the storage gate enabled.
The first production gate observation at **12:08:29 UTC / 17:38:29 IST** reported
`available=false`, with zero new claims/leases, execution events or dead letters
since its reload. All 87 unknown paid holds were retained. A final small
timeout-message correction was loaded after its focused regressions passed.
News resumed after the backup; the other schedules stayed online. PM2 state
was saved privately. This is safe waiting, not a successful article run.

Final Research reload: **12:12:37 UTC / 17:42:37 IST**, PID **2476251**, restart
count **11**. News is PID **2473914**. Entity Manager, Editor, Publisher and
Polymarket retained their process identities. The availability snapshot at
**12:13:39 UTC / 17:43:39 IST** still reported `available=false`.

Research re-probes automatically and can resume claims when both readers pass;
it does not need another process restart solely to reopen admission. The
selected recovery remains subject to its original deadline. The remaining
bulk recovery is deliberately deferred until a real accepted item is verified.

The hosted database restart is an external dependency: the configured connector
has log/query access but no restart operation, and this host has no configured
Supabase management access token. A restart/access request has been sent to the
owner. Do not infer that the restart happened from elapsed time or an `online`
PM2 state.

The API identity at the beginning of this incident was PID **2468463**, restart
count **2**, uptime **1791458762801**. Every pipeline action asserts that this
identity is unchanged. The older 7 October API identity is dated evidence and
is not the baseline for this task. No API source, process, test or restart is
included.

Outstanding proof: both production readers healthy; a selected recovery saved
with an accepted Entity Manager receipt and matching capture hash; subsequent
normal News progress; and successful existing-path Editor, Publisher and
Polymarket scheduled runs. Database restart by itself is not that proof.

## Scoped verification

Run from `packages/collectors/`:

```bash
pnpm exec tsx --test src/research-engine/article-placement.test.ts src/research-gate/managed-context-reader.test.ts src/research-engine/v4-shared-worker.test.ts
pnpm exec tsx --test src/research-engine/context-availability.test.ts src/research-engine/run-shared-research.test.ts
pnpm exec tsx --test src/signal-platform/operator-recovery.test.ts
pnpm exec tsc --noEmit -p tsconfig.json --pretty false
```

Completed checks:

| Check | Result |
| --- | --- |
| V4 worker, including delayed-read expiry and revoked-claim tests | 34 pass. |
| Article placement and managed context | 25 pass. |
| Availability gate, active runner and shared worker | 60 pass. |
| Canonical recovery operator | Four pass. |
| Final timeout/connection-message coverage correction | Nine managed-context tests pass; overlaps the 25-test group. |
| Collectors TypeScript | Pass. |
| Whitespace validation | Pass. |
| Verified backup and one canonical requeue | Complete; immutable capture, attempt/deadline and paid-state assertions pass. |
| Production accepted-item/hash and scheduled-run validation | Blocked by hosted database unavailability. |

The focused message regression reproduced the untyped connection-refused
misclassification before the correction; both that message and the fetch
abort timeout now classify as transient. No full-repository suite, API/UI
check or paid provider replay was run. The initial dry-run and queue audit
used production SQLite read-only; the one authorized recovery used the
canonical audited apply path. Context tests use isolated fixtures.
