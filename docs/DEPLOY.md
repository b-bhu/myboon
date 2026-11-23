# VPS Deploy — myboon

## Processes managed by PM2

The tracked `ecosystem.config.cjs` holds two groups: apps that are always
registered, and the gated V4 apps, which join the process list only when the
invoking shell sets `MYBOON_V4_RUNTIME_ENABLED=1` (without that flag they are
absent from the list).

### Always-registered apps (the ungated `apps` list)

| Name | Package | Schedule |
|------|---------|---------|
| `myboon-api` | `packages/api` | persistent HTTP server (port 3000) |

The old pipeline (`packages/collectors`) and its apps (`myboon-polymarket-data-engineer`,
`myboon-news-feed-ingestor`, `myboon-feed-v3-research`, `myboon-feed-v3-entity-manager`,
`myboon-editor-draft`, `myboon-publisher`) were deleted in
[#484](https://github.com/b-bhu/myboon/issues/484). If any of them still shows in
`pm2 list` on the VPS, `pm2 delete` it and run `pm2 save`.

### Gated V4 apps (registered only when `MYBOON_V4_RUNTIME_ENABLED=1`)

Each V4 app runs one cycle and exits; PM2 starts it again at the next cron
tick (`cron_restart`, `autorestart` off). Every gate flag defaults to false in
the tracked file, so a plain start/reload never registers or enables them.

| Name | Package | Schedule |
|------|---------|---------|
| `myboon-scout` | `packages/scout-news` | `*/15 * * * *` |
| `myboon-analyst` | `packages/analyst` | `*/30 * * * *` |
| `myboon-entity-manager` | `packages/entity-manager` | `0,45 * * * *` |
| `myboon-entity-manager-retry` | `packages/entity-manager` | `15 20 * * *` |
| `myboon-web-reader` | `packages/web-reader` | `*/15 * * * *` |
| `myboon-latest-updates` | `packages/latest-updates` | `25,55 * * * *` (added in #634; gate off, visibility `dark`) |

The orphan sweeper, entity-catalogue maintenance and classification-shadow services were retired on 6 October 2026. Their dedicated application code and commands are removed. Historical migrations and audit records remain intact. Required live Jev decisions and per-call Hermes process cleanup remain enabled.

PM2 is the source of truth for VPS runtime. `infra/vps/systemd/*` is deprecated and should not be installed for the current Feed pipeline.

---

## Analyst worker (myboon-analyst)

`myboon-analyst` (`packages/analyst`) runs one cycle and exits; PM2 starts it
again at the 30-minute cron tick (`*/30 * * * *`, `autorestart` off). The seven
persistent registrations in the table above are unchanged: like the gated
scout, the analyst joins the process list only when
`MYBOON_V4_RUNTIME_ENABLED=1`, and a plain `pm2 start/reload` of the ecosystem
file never registers it. Secrets (`ANALYST_DATABASE_URL`, `OLLAMA_API_KEY`,
`JEV_API_TOKEN`) come only from the sourced `.env`; they are never set in the
ecosystem file. Config check: `pnpm exec tsx scripts/check-ecosystem.ts`.

A typical run takes ~7.5 min for 20 signals (first prod run, Oct 30, 2026).
The worst case is 20 signals x 4 asks x (primary + fallback) 2 x 20s = 3200s
(~53 min), so a rare slow run is cut short by the next tick. That is safe:
finished signals are already committed (one transaction per save). PM2 runs one process per app and `cron_restart` restarts (kills) rather than
starting a second copy, so runs never overlap. A killed run's signal stays
claimed until its 300s lease expires and is retried with backoff.

```bash
# Go-live (register). Back up the process list BEFORE anything else:
cp ~/.pm2/dump.pm2 ~/.pm2/dump.pm2.bak-$(date +%Y%m%d%H%M)

# From the repo root as the PM2 user. Source the .env silently —
# never echo it; secrets must stay out of history and the ecosystem file:
set -a; . ./.env; set +a
MYBOON_V4_RUNTIME_ENABLED=1 pm2 start ecosystem.config.cjs --only myboon-analyst
pm2 save

# Switch on / off (ANALYST_ENABLED defaults to false; set in the shell,
# never by editing the tracked ecosystem file):
ANALYST_ENABLED=true MYBOON_V4_RUNTIME_ENABLED=1 pm2 restart ecosystem.config.cjs --only myboon-analyst --update-env && pm2 save
ANALYST_ENABLED=false MYBOON_V4_RUNTIME_ENABLED=1 pm2 restart ecosystem.config.cjs --only myboon-analyst --update-env && pm2 save
```

---

## Entity manager (myboon-entity-manager)

`myboon-entity-manager` (`packages/entity-manager`) runs one cycle and exits;
PM2 starts it again at the hourly :00 and :45 ticks (`0,45 * * * *`,
`autorestart` off). Like the gated scout and analyst, it joins the process list
only when `MYBOON_V4_RUNTIME_ENABLED=1`, and a plain `pm2 start/reload` of the
ecosystem file never registers it. Secrets (`ENTITY_MANAGER_DATABASE_URL`,
`OLLAMA_API_KEY`, optional `JEV_API_TOKEN`) come only from the sourced `.env`;
they are never set in the ecosystem file. Config check:
`pnpm exec tsx scripts/check-ecosystem.ts`.

```bash
# Go-live (register). Back up the process list BEFORE anything else:
cp ~/.pm2/dump.pm2 ~/.pm2/dump.pm2.bak-$(date +%Y%m%d%H%M)

# From the repo root as the PM2 user. Source the .env silently —
# never echo it; secrets must stay out of history and the ecosystem file:
set -a; . ./.env; set +a
MYBOON_V4_RUNTIME_ENABLED=1 pm2 start ecosystem.config.cjs --only myboon-entity-manager
pm2 save

# Switch on / off (ENTITY_MANAGER_ENABLED defaults to false; set in the shell,
# never by editing the tracked ecosystem file):
ENTITY_MANAGER_ENABLED=true MYBOON_V4_RUNTIME_ENABLED=1 pm2 restart ecosystem.config.cjs --only myboon-entity-manager --update-env && pm2 save
ENTITY_MANAGER_ENABLED=false MYBOON_V4_RUNTIME_ENABLED=1 pm2 restart ecosystem.config.cjs --only myboon-entity-manager --update-env && pm2 save
```

---

## Latest updates (myboon-latest-updates)

`myboon-latest-updates` (`packages/latest-updates`) runs one cycle and exits;
PM2 starts it again at the :25 and :55 ticks (`25,55 * * * *`, `autorestart`
off). Like the other gated V4 apps, it joins the process list only when
`MYBOON_V4_RUNTIME_ENABLED=1`; a plain `pm2 start/reload` of the ecosystem file
never registers it. Secrets (`LATEST_UPDATES_DATABASE_URL`, `OLLAMA_API_KEY`)
come only from the sourced `.env`; they are never set in the ecosystem file.
Config check: `pnpm exec tsx scripts/check-ecosystem.ts`.

Visibility stays `dark`, the default in the tracked file. Going live
(`LATEST_UPDATES_VISIBILITY=live`) is a separate later step and is not done
here.

```bash
# Go-live (register). Back up the process list BEFORE anything else:
cp ~/.pm2/dump.pm2 ~/.pm2/dump.pm2.bak-$(date +%Y%m%d%H%M)

# From the repo root as the PM2 user. Source the .env silently —
# never echo it; secrets must stay out of history and the ecosystem file:
set -a; . ./.env; set +a
MYBOON_V4_RUNTIME_ENABLED=1 pm2 start ecosystem.config.cjs --only myboon-latest-updates
pm2 save

# Switch on / off (LATEST_UPDATES_ENABLED defaults to false; set in the shell,
# never by editing the tracked ecosystem file):
LATEST_UPDATES_ENABLED=true MYBOON_V4_RUNTIME_ENABLED=1 pm2 restart ecosystem.config.cjs --only myboon-latest-updates --update-env && pm2 save
LATEST_UPDATES_ENABLED=false MYBOON_V4_RUNTIME_ENABLED=1 pm2 restart ecosystem.config.cjs --only myboon-latest-updates --update-env && pm2 save
```

A plain `pm2 start` or `pm2 restart` of `ecosystem.config.cjs` without
`--only` would also revive the legacy `myboon-feed-v3-entity-manager`
registration; always use `--only`.

---

## First-time VPS setup

```bash
# 1. Install PM2 globally
npm install -g pm2

# 2. Clone repo and install deps
git clone <repo> myboon && cd myboon
pnpm install

# 3. Create .env files (never committed)
#    packages/api/.env

# 4. Start all processes
pm2 start ecosystem.config.cjs

# 5. Save process list and enable startup on reboot
pm2 save
pm2 startup   # run the printed command as root/sudo
```

---

## Day-to-day operations

```bash
# Pull latest and reload (zero-downtime for API)
# Apply pending Supabase migrations first when new migrations exist.
# - supabase/migrations/20260818145731_drop_retired_pipeline_tables.sql
#   (removes only retired temporary pipeline tables after the SQLite cutover)
# Currently pending (entity pipeline rebuild):
# - supabase/migrations/20260728_entity_memories_drop_source_marker.sql
#   (safe to apply: every source_marker WRITE was removed in the rebuild;
#   this drops the CHECK-constraint allowance for that memory_type)
infra/vps/deploy.sh

# Or manually:
git pull --ff-only && pnpm install --frozen-lockfile
pnpm --filter @myboon/shared build
pnpm --filter @myboon/tx-parser build
# Remove only retired registrations; reload reviewed apps without deleting API.
pm2 delete myboon-news-researcher 2>/dev/null || true
pm2 delete myboon-polymarket-researcher 2>/dev/null || true
pm2 delete myboon-news-entity-manager 2>/dev/null || true
pm2 delete myboon-polymarket-entity-manager 2>/dev/null || true
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save

# Watch all logs
pm2 logs

# Watch a specific process
pm2 logs myboon-api
pm2 logs myboon-feed-v3-research

# Process status overview
pm2 list

# Interactive monitor (CPU/memory/logs)
pm2 monit

# Restart a single process
pm2 restart myboon-polymarket-data-engineer
pm2 restart myboon-news-feed-ingestor
pm2 restart myboon-feed-v3-research
pm2 restart myboon-feed-v3-entity-manager

# Stop everything
pm2 stop all

# Delete all (nuclear — re-run start after)
pm2 delete all
```

---

## .env reference

Each package loads its own `.env` via `dotenv/config`. PM2 sets `cwd` to the package directory so dotenv finds the right file.

### `packages/api/.env`
```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
TOKENS_API_KEY=
INTERNAL_DASHBOARD_TOKEN=
INTERNAL_POLYMARKET_CATALOG_WRITE_TOKEN=
PORT=3000
```

### Internal dashboard web environment

The public web deployment may host `/internal/entities` and
`/internal/polymarket`, but these routes are not public data. Configure these
values in the deployment provider's private
environment-variable store only. Do not add secret values to source files,
GitHub issues, CI logs, or browser-accessible `NEXT_PUBLIC_*` variables.

```text
INTERNAL_DASHBOARD_TOKEN=
INTERNAL_DASHBOARD_SESSION_SECRET=
INTERNAL_DASHBOARD_AUTH_BYPASS=0
INTERNAL_POLYMARKET_CATALOG_WRITE_TOKEN=
INTERNAL_API_BASE_URL=https://internal-api.example.com
```

Use the same `INTERNAL_DASHBOARD_TOKEN` for the API and web deployments. Use a
separate `INTERNAL_POLYMARKET_CATALOG_WRITE_TOKEN` for catalog draft and
publish operations. Configure write tokens only on the API and web server.
Generate all secrets independently with at least 32 random bytes, for example:

```bash
openssl rand -base64 48
```

For local UI development only, `INTERNAL_DASHBOARD_AUTH_BYPASS=1` skips the web
dashboard login/session prompt. The bypass is ignored when `NODE_ENV=production`
and never disables API read or write credentials. Keep it unset or `0` in every
deployed environment.

`INTERNAL_API_BASE_URL` is server-to-server only. Keep the API on a private
network or allow it only from the web deployment where the platform supports
network allowlists. The browser must never call the API host directly.

Before deploying the API, apply pending migrations, including the Polymarket
catalog tables and draft/publish RPCs:

```bash
pnpm dlx supabase db push
```

---

## Smoke test (after deploy)

```bash
curl http://localhost:3000/health
# {"status":"ok"}

pnpm --filter @myboon/api smoke
```
