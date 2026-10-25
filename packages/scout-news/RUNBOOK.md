# V4 runtime stage runbook (#444)

Three PM2 apps, one per V4 pipeline stage, all hosted by `packages/scout-news`:

| PM2 app | Script | Stage |
| --- | --- | --- |
| `myboon-v4-scout-news` | `src/run-scout.ts` | `scout-news` |
| `myboon-v4-analyst` | `src/run-analyst.ts` | `analyst` |
| `myboon-v4-entity-manager` | `src/run-entity-manager.ts` | `entity-manager` |

The scripts are placeholders until #440 wires the runners and the #440/#441
queue tables land; launching before that will restart-loop into `errored`.

All three are **off by default**: `ecosystem.config.cjs` only registers them
when the invoking shell sets `MYBOON_V4_RUNTIME_ENABLED=1`. After go-live, any
`pm2 reload ecosystem.config.cjs` must also set that flag, or the V4 apps are
left out of the reload.

## Start (only after go-live approval)

CTO approves go-live after Backend Dev's local e2e passes. Then:

```sh
cp ~/.pm2/dump.pm2 ~/.pm2/dump.pm2.bak-$(date +%Y%m%d%H%M)
MYBOON_V4_RUNTIME_ENABLED=1 pm2 start ecosystem.config.cjs --only myboon-v4-scout-news,myboon-v4-analyst,myboon-v4-entity-manager
pm2 save
```

`pm2 save` runs only after the three apps are confirmed `online`; the dump
backup taken first is the rollback path.

## Stop

```sh
pm2 stop myboon-v4-scout-news myboon-v4-analyst myboon-v4-entity-manager
pm2 save
```

`pm2 save` after stopping keeps the stopped apps out of boot resurrection.

## Logs

Each app writes one JSON line per event (`{ ts, level, stage, msg, ... }`):

```sh
pm2 logs myboon-v4-scout-news --lines 200 | jq -c 'select(.level != "info")'
pm2 logs myboon-v4-analyst --lines 200 | jq '.msg' | sort | uniq -c
```

`health` lines carry the snapshot numbers below; filter with
`| jq 'select(.msg == "health")'`.

## Health numbers (`health` log lines)

| Field | Meaning | Healthy | Bad |
| --- | --- | --- | --- |
| `queueDepth` | Items waiting for this stage | Small, drains between cycles | Growing over hours: stage is slower than its producer |
| `oldestClaimAgeMs` | Age of the oldest open claim | Near one cycle interval | Above the lease time: a worker died holding work; also spikes when a stage is stuck |
| `leaseExpiriesLastHour` | Leases that expired in the last hour | 0 | Any sustained count: claims are timing out or workers crash mid-item |
| `deadLetterCount` | Items parked as dead letters | Flat | Rising: a poison message or a broken dependency needs triage; never erase, diagnose |
| `advisoryLockHolder` | PID + start time of the lock owner, null if free | Same PID for long stretches, or null | Lock held by a PID that is not this app: a stale or foreign holder blocks all stage work |
| `signalsPerHour` | Signals produced for this stage | Matches expected activity | 0 on an active stage: upstream is idle or the wiring is broken |

Any failed source read shows as `null` in its field with the message in
`errors`; treat a non-empty `errors` array on consecutive snapshots as a
source problem, not a stage problem.

## Restart behaviour

- Crash backoff: `exp_backoff_restart_delay 2000` starts at 2 s and grows
  x1.5 each unstable restart, capped by PM2 at 15 s.
- `min_uptime 30000` + `max_restarts 10`: ten restarts that each live under
  30 s put the app into `errored` instead of looping forever. An `errored`
  state needs manual triage, not just a restart.
- Memory: restarts above 300 MB (`myboon-v4-entity-manager`: 400 MB).
- `kill_timeout 30000` gives a draining runner half a minute to finish its
  current claim before SIGKILL.

## Credentials

The apps reuse the existing service credentials already present in the VPS
environment; runners read them from env. Never print, paste, or log credential
values in tickets or chat.

## Rollback

```sh
pm2 stop myboon-v4-scout-news myboon-v4-analyst myboon-v4-entity-manager
pm2 delete myboon-v4-scout-news myboon-v4-analyst myboon-v4-entity-manager
cp ~/.pm2/dump.pm2.bak-<timestamp> ~/.pm2/dump.pm2
pm2 resurrect
pm2 save
```

`resurrect` restores the pre-V4 process list from the backup; `pm2 save`
re-pins it.

## Out of scope

- Alerting/monitoring rules for these snapshots are a later decision, not part
  of #444.
- The runner scripts and queue access are wired after #440; until then there
  is nothing to start.