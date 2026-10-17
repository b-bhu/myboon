# infra/vps

VPS deployment and operations material for the Myboon server. Everything here
is repo documentation; nothing in this directory installs or changes anything
without a deliberate step (see deploy.sh / install-systemd.sh).

## Condition checker (Ref #346 PR 5, log-only)

`packages/collectors` ships a cron checker that watches six conditions and
logs breaches through the shared JSONL error log (`appendErrorLog`, by default
`~/myboon-logs/errors.jsonl`). No push alerts.

- publish_stale - no published narrative for > 2h (max `published_at` on
  Supabase `published_narratives`); only checked while PM2 app
  `myboon-publisher` is online.
- draft_stale - no editor draft for > 3h (max `created_at` on the local
  SQLite `pipeline_editor_drafts` table in pipeline.sqlite, opened strictly
  read-only; `PIPELINE_SQLITE_PATH` overrides the path - Supabase
  `editor_drafts` is no longer written and is not read); only checked while
  PM2 app `myboon-editor-draft` is online. A missing or unreadable
  pipeline.sqlite or an empty table is a skip, never a breach.
- restart_burst - an app's `restart_time` rises by more than 5 within 15
  minutes (samples kept ~20 min in the state file).
- supabase_health_failed - the checker's own Supabase health probe
  (`createSupabaseHealthProbe`) failed on 3+ consecutive runs; runs even when
  all apps are stopped.
- config_missing - the Supabase env (`SUPABASE_URL` /
  `SUPABASE_SERVICE_ROLE_KEY`) is missing: a configuration error that
  breaches on its own and never counts toward supabase_health_failed. While
  the env is missing the probe and the published-narratives gatherer do not
  run and the consecutive probe-failure counter is left exactly as the
  previous run left it; when the env returns, one `condition_cleared`
  closes it.
- disk_high - `/` used > 80% (strictly greater; path overridable with
  `MYBOON_CONDITION_DISK_PATH`).

Silence rules: all seven PM2 apps are intentionally stopped right now, so a
staleness check whose app is not `online` in `pm2 jlist` stays silent - a
`condition_skipped` line is written only when the run's skip reasons differ
from the previous run's (both persisted in the state file): the first
sighting of a reason, an app status or pm2-availability change, or a
store/statfs failure appearing. Repeated runs with the same skipped checks
log nothing; the stdout summary still lists every skip of every run. When a
skip resolves - the app is online again, pm2 responds, the store is readable
- one `condition_cleared` per resolved reason closes it (condition
"<check>_skipped"), and gated checks resume. Missing pm2 output skips the
checks too; it never reports a breach. Breach lines repeat at most every 30
minutes while the condition persists and close with one `condition_cleared`
when they recover.

Bookkeeping:

- State file: `MYBOON_CONDITION_STATE` env var, else
  `~/myboon-logs/condition-state.json` (restart samples, breach/last-logged
  state, consecutive probe failures, last-known `myboon-publisher` /
  `myboon-editor-draft` statuses and active skip reasons; older files
  without the new fields still load; corrupt or missing file means fresh
  state; writes are tmp+rename).
- Cron log: `~/myboon-logs/condition-check.cron.log` (one summary JSON line
  per run).
- Run: `pnpm --filter @myboon/collectors pipeline-store:check` (always exits 0).
- The crontab line lives in `infra/vps/crontab.example` and is NOT installed;
  install only with Bucket's approval.

## Log rotation (Ref #346 PR 6)

Two layers, both documentation-only: nothing here has been installed on the
VPS, and nothing in this directory installs anything by itself.

1. PM2 app logs (`~/.pm2/logs/*.log` and per-app error logs) via the
   pm2-logrotate module, decided settings (max_size 50M, retain 7, compress):

   ```bash
   pm2 install pm2-logrotate
   pm2 set pm2-logrotate:max_size 50M
   pm2 set pm2-logrotate:retain 7
   pm2 set pm2-logrotate:compress true
   ```

   Check the active values afterwards with `pm2 conf pm2-logrotate`.

2. The persistent JSONL error log (`MYBOON_ERROR_LOG`, by default
   `~/myboon-logs/errors.jsonl` — `resolveErrorLogPath` in
   `packages/collectors/src/pipeline-store/error-log.ts`) lives outside PM2's
   log directory, so it needs a system logrotate rule:
   `infra/vps/logrotate/myboon-error-log` (size 50M, rotate 7, compress,
   copytruncate). Install with:

   ```bash
   sudo cp infra/vps/logrotate/myboon-error-log /etc/logrotate.d/myboon-error-log
   sudo logrotate -d /etc/logrotate.d/myboon-error-log   # dry-check, changes nothing
   ```

   If `MYBOON_ERROR_LOG` is set to a path other than
   `~/myboon-logs/errors.jsonl` in the workers' env, edit the path in the
   rule to match what the workers actually write.

3. The lane-store prune (Ref #346 PR 6) keeps SQLite row counts bounded; its
   NOT-installed daily crontab entry is documented in
   `infra/vps/crontab.example` and `docs/DEPLOY.md`.