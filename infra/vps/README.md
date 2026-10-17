# infra/vps

VPS deployment and operations material for the Myboon server. Everything here
is repo documentation; nothing in this directory installs or changes anything
without a deliberate step (see deploy.sh / install-systemd.sh).

## Condition checker (Ref #346 PR 5, log-only)

`packages/collectors` ships a cron checker that watches five conditions and
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
- disk_high - `/` used > 80% (strictly greater; path overridable with
  `MYBOON_CONDITION_DISK_PATH`).

Silence rules: all seven PM2 apps are intentionally stopped right now, so a
staleness check whose app is not `online` in `pm2 jlist` stays silent - each
run writes one `condition_skipped` line naming what was skipped instead.
Missing pm2 output skips the checks too; it never reports a breach. Breach
lines repeat at most every 30 minutes while the condition persists and close
with one `condition_cleared` when they recover.

Bookkeeping:

- State file: `MYBOON_CONDITION_STATE` env var, else
  `~/myboon-logs/condition-state.json` (corrupt or missing file means fresh
  state; writes are tmp+rename).
- Cron log: `~/myboon-logs/condition-check.cron.log` (one summary JSON line
  per run).
- Run: `pnpm --filter @myboon/collectors pipeline-store:check` (always exits 0).
- The crontab line lives in `infra/vps/crontab.example` and is NOT installed;
  install only with Bucket's approval.