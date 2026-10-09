# 9 October — Supabase availability diagnosis and engineer handoff

## Current checkpoint

At **02:40 UTC / 08:10 IST, 9 October 2026**, the pipelines are blocked by
database availability despite the organisation being on **Pro**. Upgrading the
plan restored access on 8 October, but it did not establish sustained health.
No infrastructure recovery or compute resize has been performed in this
diagnosis. **The current compute size and exact resource bottleneck remain
unverified.**

Project: `rrdvpdgebygfdstwknqc`, `myboon`, Tokyo (`ap-northeast-1`), PostgreSQL
`17.6.1.084`. The management API reports `ACTIVE_HEALTHY`; this status does not
mean actual database queries work. The public Supabase status page reported no
active incident at the observation time.

This checkpoint preserves the #299 boundary: Scout → Intake → Researcher →
Entity Manager → private durable knowledge. Editor and Publisher remain on
their existing legacy path; Polymarket remains collection-only. No downstream
integration, API change, permission expansion or new evidence/claims contract
is part of this work.

## Confirmed evidence

| Observation | Result |
| --- | --- |
| Latest completed News work | 00:45:21 UTC / 06:15:21 IST, 9 October. |
| Local pipeline host | Load average about 0.15; about 3.8 GB RAM and 15 GB disk available. No local resource pressure found. |
| Restricted direct database connection | Verified-TLS configuration; connection did not complete within 10 seconds. No diagnostic SQL ran. |
| Independent REST read | `entities?select=id&limit=1` did not respond within 10 seconds. |
| Database transport | TCP connected in 277 ms; PostgreSQL's SSL response took 4,030 ms; TLS setup had not completed at the 12-second deadline. |
| Supabase metrics endpoint | No response within 20 seconds. Resource values could not be collected. |
| Internal database monitoring | Supabase `postgres_exporter` queries took approximately 10.7–14.4 seconds, with repeated SQLSTATE `57014` statement timeouts. |
| REST service logs | Repeated `PGRST002` schema-cache failures; SQLSTATE `57014` while loading the schema; HTTP `503` on `pipeline_runs` writes. |

These independent paths establish that the problem extends beyond one article,
one Node client, or the Researcher's input limits. Slow internal monitoring and
connection setup are consistent with database resource pressure or an instance
problem. **CPU exhaustion, memory/swap pressure, depleted disk I/O allowance,
blocking queries and connection saturation have not been distinguished.**
The sampled logs did not establish an out-of-memory event, full disk or
connection-slot exhaustion. A slow checkpoint or planner row estimate alone
does not prove either disk exhaustion or an actual connection count.

## Work and process state

At 02:30 UTC / 08:00 IST, all seven PM2 entries were online with stable process
identities. The protected `myboon-api` identity remained PID **2468463**, restart
count **2**, uptime **1791458762801**. No API action, source edit, test or request
was performed.

The News store held **12,104 complete**, **77 research pending**, **one synthesis
pending**, **45 dead letters**, **zero retry waits** and **zero active leases**.
Completed work rose by **363** from the 8 October cleanup baseline. The 45
fresh terminal failures remain visible; they were not cleared in this diagnosis.
There are **93 unknown paid outcomes**, six more than the baseline. Those holds
must remain reserved until durable/provider evidence reconciles them.

The deployed availability gate checks both Research storage readers before
claiming work. It backs off to one probe every five minutes during continued
failure and blocks new claims/paid dispatch while unavailable. It automatically
reopens after a successful probe. Original job freshness deadlines still pass
during the outage; this protection does not promise every pending job can later
be recovered. Collector/Editor/Publisher errors remain visible separately.

## Recovery action for the project owner

1. Open [Infrastructure](https://supabase.com/dashboard/project/rrdvpdgebygfdstwknqc/settings/infrastructure)
   and record the **actual compute size**. Check database reports for CPU,
   memory/swap, disk I/O allowance and connections around **00:40–02:40 UTC**.
2. If the project is still **Nano**, change it to **Micro**. Supabase states that
   paid Nano is billed at the same compute price as Micro, and a plan upgrade
   does not automatically resize existing instances. The resize incurs
   database downtime; confirm the dashboard's current pricing before applying.
3. If already Micro or larger, use **Restart project** in
   [Project Settings](https://supabase.com/dashboard/project/rrdvpdgebygfdstwknqc/settings/general)
   as temporary recovery if the database remains unresponsive. A restart can
   interrupt the API's database requests even though its PM2 process is left
   untouched. It is not proof of a lasting fix.
4. If restart/resize does not restore queries, or the failure recurs, send
   Supabase support the project reference, time window and confirmed evidence
   above. Determine the actual bottleneck before paying for further compute or
   changing query/pool limits.

The connected Supabase tools can inspect metadata/logs and execute SQL, but
expose **no project restart or compute-resize operation**. No management access
token is configured in the current shell. This recovery therefore needs the
owner's dashboard action or separately supplied infrastructure access. Pausing,
restoring, resetting or cloning the project is not a substitute for a restart.

Official references:

- [Connection-timeout troubleshooting](https://supabase.com/docs/guides/troubleshooting/failed-to-run-sql-query-connection-terminated-due-to-connection-timeout).
- [Compute and disk; paid Nano and Micro; resize downtime](https://supabase.com/docs/guides/platform/compute-and-disk).
- [Compute credits and billing](https://supabase.com/docs/guides/platform/manage-your-usage/compute).
- [HTTP API troubleshooting and disk I/O limits](https://supabase.com/docs/guides/troubleshooting/http-api-issues).

## Acceptance after the infrastructure action

The operator should keep diagnostics bounded and use the host's existing
restricted credentials without printing them. No broad tests or API request
are necessary to establish this recovery:

1. Confirm direct verified-TLS connection and a trivial read complete promptly;
   independently confirm the REST `entities` read returns successfully.
2. Record actual CPU, memory/swap, I/O and connection measurements. Once SQL is
   available, inspect `pg_stat_activity` and `pg_blocking_pids` for contention,
   then normalized `pg_stat_statements` for expensive queries. Avoid dumping
   article payloads or full statement parameters into the handoff.
3. Confirm both Research readers report healthy and the gate automatically
   resumes eligible work. Verify one fresh accepted Entity Manager receipt and
   the complete article/source-packet hash; compare durable counts, not only
   PM2 `online`.
4. Verify an actual successful cycle for each configured collector, legacy
   Editor and Publisher; an idle success is not output verification. Preserve
   the API's PID/restart/uptime identity throughout.
5. Retain new failures and paid holds. If outage jobs need recovery, use the
   existing backup-gated operator and its per-job eligibility checks; do not
   bulk reset dead letters, attempts, budgets or unknown provider outcomes.
6. Monitor through another overnight window and alert on sustained database
   failure, stalled accepted-work progress and growth of unknown paid holds.
   A single successful query or restart is not sufficient completion evidence.

No application source, runtime configuration, queue state, credentials or
database schema was changed by this diagnosis. Recovery acceptance above is
**pending**, not completed verification.

Prior baseline and canary evidence:
[8 October Pro upgrade and overnight baseline](2026_10_08_pro_upgrade_cleanup_and_overnight_baseline.md).
Existing outage controls and recovery implementation:
[8 October database outage recovery](2026_10_08_database_outage_recovery.md).
