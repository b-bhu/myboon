# V4 runtime runbook (#444, scout stage)

One PM2 app in Sprint 1: the news scout, hosted by `packages/scout-news`.

| PM2 app | Script | Stage |
| --- | --- | --- |
| `myboon-v4-scout-news` | `src/run-scout.ts` | `scout-news` |

The script renames to `src/run.ts` when PR #473 merges. The analyst and
entity-manager stage apps are Sprint 2 work; they join this runbook when
their runners are wired.

The runner script is a placeholder until #440 wires it; every tick before
that fails harmlessly (autorestart is off — see below), it does not
restart-loop into `errored`.

## Schedule shape

The scout runs once per cycle and exits. PM2 starts it every 15 minutes
(`cron_restart: '*/15 * * * *'`) with `autorestart: false`. It is not a
resident process: `pm2 status` shows it `stopped` between ticks, and a
one-off manual run (`pm2 start myboon-v4-scout-news --update-env`) makes an
extra cycle.

## Off by default

`ecosystem.config.cjs` only registers the app when the invoking shell sets
`MYBOON_V4_RUNTIME_ENABLED=1`. After go-live, any `pm2 reload
ecosystem.config.cjs` must also set that flag, or the V4 app is left out of
the reload.

## Start (only after go-live approval)

CTO approves go-live after Backend Dev's local e2e passes. Then:

```sh
cp ~/.pm2/dump.pm2 ~/.pm2/dump.pm2.bak-$(date +%Y%m%d%H%M)
MYBOON_V4_RUNTIME_ENABLED=1 pm2 start ecosystem.config.cjs --only myboon-v4-scout-news
pm2 save
```

`pm2 save` runs only after the first tick confirms the app runs and exits;
the dump backup taken first is the rollback path.

## Stop

```sh
pm2 stop myboon-v4-scout-news
```

`pm2 stop` only kills the current tick; with `cron_restart`, PM2 brings a
stopped app back at the next 15-minute tick. The off-switch is setting
`SCOUT_ENABLED` in `ecosystem.config.cjs` (not .env): edit the value to
`'false'` (the ecosystem file carries it), then

```sh
MYBOON_V4_RUNTIME_ENABLED=1 pm2 restart ecosystem.config.cjs --only myboon-v4-scout-news --update-env
```

With `'false'`, each cron tick exits 0 immediately, before any DB client
or network connection is created: nothing runs and nothing is written.

## Logs

The app writes one JSON line per event (`{ ts, level, stage, msg, ... }`):

```sh
pm2 logs myboon-v4-scout-news --lines 200 | jq -c 'select(.level != "info")'
```

`health` lines carry the snapshot numbers below; filter with
`| jq 'select(.msg == "health")'`. One `health` line lands at the end of each
run, so 15-minute cadence is the expected rate.

## Health numbers (`health` log lines)

Service_role's atlas grants (20261026011119, 20261026011428) decide what the
health source can read. A metric it cannot read reports `null` with **no**
`errors` entry; a null is expected there, not a fault. A non-empty `errors`
array is a real failed read.

| Field | Meaning | Healthy | Bad |
| --- | --- | --- | --- |
| `queueDepth` | `ready` rows in `atlas.signal_queue` | Small, drains at the next tick | Growing for consecutive ticks: the scout enqueues faster than downstream consumes |
| `oldestClaimAgeMs` | Age of the oldest open claim | Always `null` (no claim-start column is granted) | — |
| `leaseExpiriesLastHour` | Leases that expired in the last hour | 0 | Sustained counts: claimants are dying mid-item |
| `deadLetterCount` | Items parked in `atlas.dead_letter` | Always `null` (INSERT-only grant) | Triage dead letters in the DB with a role that can read them; null does NOT mean zero |
| `advisoryLockHolder` | PID + start time of the lock owner | Always `null` (not exposed via PostgREST) | — |
| `signalsPerHour` | New `atlas.signals` rows in the window | Matches the scout's per-run enqueue rate | 0 across consecutive ticks while the scout still logs enqueue work: wiring or grant drift |

Any field with an entry in `errors` is one failed read among the six;
consecutive snapshots with the same entry mean the grant or schema is
missing, not that the scout's work is wrong.

## Restart behaviour

- No crash backoff on purpose: the run is batch-shaped, it starts under cron
  and exits. A crashing tick leaves the app `errored`/`stopped` until the
  next tick starts a fresh run; the previous failure stays in `pm2 logs` and
  in the run's `errors` fields, so diagnosing it is a lookup, not a race.
- If a tick must be delayed while long-running work drains, the runner
  completes its claims before exiting; `kill_timeout 30000` is the hard cap
  on a draining run during `pm2 stop` or a tick-time restart.
- `max_memory_restart '300M'` is a runaway guard, not a memory policy.

## Credentials

The app reuses the existing service credentials already present in the VPS
environment; the runner reads them from env. Never print, paste, or log
credential values in tickets or chat.

## Rollback

Pause the stage with the off-switch, not `pm2 delete`: set
`SCOUT_ENABLED: 'false'` in `ecosystem.config.cjs`, then
`pm2 restart ecosystem.config.cjs --only myboon-v4-scout-news --update-env` (MYBOON_V4_RUNTIME_ENABLED=1 set). With `'false'` every
tick exits 0 immediately, before any DB or network work.

Fully removing the app from the PM2 list (`pm2 delete
myboon-v4-scout-news`, then `pm2 save`) is not the off-switch; that
process-list change needs CTO approval. If it is approved, back up the
process list first (the dump backup step from Start), then delete and
`pm2 save`; re-adding the app later starts from the ecosystem file
again.

## Out of scope

- Alerting/monitoring rules for these snapshots are a later decision, not
  part of #444.
- The analyst and entity-manager stages, and any decision_queue reads, are
  Sprint 2 work; the service_role grants above stay scoped to what the scout
  needs.
- The dead-letter review flow (triage, retries) lives with the queue work;
  the health line only surfaces what the grants allow.