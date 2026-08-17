# VPS Deploy — myboon

## Processes managed by PM2

| Name | Package | Schedule |
|------|---------|---------|
| `myboon-api` | `packages/api` | persistent HTTP server (port 3000) |
| `myboon-polymarket-data-engineer` | `packages/collectors` | Polymarket markets Data Engineer |
| `myboon-polymarket-researcher` | `packages/collectors` | Polymarket Researcher |
| `myboon-polymarket-entity-manager` | `packages/collectors` | Polymarket ResearchPacket to Entity Memory |
| `myboon-news-feed-ingestor` | `packages/collectors` | Structured article/social collection every 10 minutes |
| `myboon-news-researcher` | `packages/collectors` | Hermes source-aware research only |
| `myboon-news-entity-manager` | `packages/collectors` | News ResearchPacket to Entity Memory |
| `myboon-editor-draft` | `packages/collectors` | Entity Memory to Editor Draft |
| `myboon-publisher` | `packages/collectors` | Generic Editor Draft Publisher |

PM2 is the source of truth for VPS runtime. `infra/vps/systemd/*` is deprecated and should not be installed for the current Feed pipeline.

Note: `packages/collectors/src/polymarket/run-editor.ts` and `run-publisher.ts`
(the research-row editor/publisher lane) are intentionally NOT in PM2. The
production path is researcher → entity-manager → editor-draft → publisher.

---

## Hermes CLI prerequisite

Five processes shell out to the `hermes` CLI (both researchers, both
entity-managers, and editor-draft). The structured news-feed ingestor does not
use Hermes. Before starting PM2 the box needs:

```bash
# hermes installed, on PATH, and authenticated
hermes --version

# one-shot structured mode (gate, extractor, editor-draft)
hermes --ignore-rules -z 'Return exactly this JSON: {"ok": true}'

# chat/tool mode with page reading (news research AND the research engine)
hermes chat --profile myboonfeed --toolsets browser,web --quiet \
  --query 'Open https://example.com and return its <title> as JSON: {"title": "..."}'
```

If the last command fails, the news lane and the research engine cannot work;
fix hermes before starting, or set `RESEARCH_ENGINE_DISABLED=1` (researcher
falls back to the legacy retrieval path, which additionally needs `python3.12`
and the last30days script at
`/root/.agents/skills/last30days/scripts/last30days.py`).

---

## Pipeline state lives in SQLite on this box

Since the entity pipeline rebuild, all Polymarket pipeline state (candidates,
research rows, editor decisions, leases, run ledger) lives in a local SQLite
file, NOT in Supabase:

```
packages/collectors/.data/pipeline.sqlite
```

- This file is the pipeline's queue and memory. Deleting it loses all
  in-flight work. It is not in git and is not reproducible from Supabase.
- Backlog / per-stage status: `pnpm --filter @myboon/collectors pipeline-store:status`
- Backup: `pnpm --filter @myboon/collectors pipeline-store:backup`
  (run it on a cron; it is cheap)
- Supabase keeps only the product tables the app/API read: `entities`,
  `entity_memories`, `published_narratives`, `entity_published_history`.

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
#    packages/collectors/.env

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
# Currently pending (entity pipeline rebuild):
# - supabase/migrations/20260728_entity_memories_drop_source_marker.sql
#   (safe to apply: every source_marker WRITE was removed in the rebuild;
#   this drops the CHECK-constraint allowance for that memory_type)
infra/vps/deploy.sh

# Or manually:
git pull --ff-only && pnpm install --frozen-lockfile
pnpm --filter @myboon/shared build
pnpm --filter @myboon/tx-parser build
pnpm --filter @myboon/collectors build
# One-time structured-news cutover: remove the retired PM2 app name.
pm2 delete myboon-news-runner 2>/dev/null || true
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save

# Watch all logs
pm2 logs

# Watch a specific process
pm2 logs myboon-api
pm2 logs myboon-polymarket-researcher

# Process status overview
pm2 list

# Interactive monitor (CPU/memory/logs)
pm2 monit

# Restart a single process
pm2 restart myboon-polymarket-data-engineer
pm2 restart myboon-polymarket-researcher
pm2 restart myboon-polymarket-entity-manager
pm2 restart myboon-news-feed-ingestor
pm2 restart myboon-news-researcher
pm2 restart myboon-news-entity-manager
pm2 restart myboon-editor-draft
pm2 restart myboon-publisher

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
NEWS_FEED_API_KEY=
INTERNAL_DASHBOARD_TOKEN=
INTERNAL_ENTITY_WRITE_TOKEN=
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
INTERNAL_ENTITY_WRITE_TOKEN=
INTERNAL_POLYMARKET_CATALOG_WRITE_TOKEN=
INTERNAL_API_BASE_URL=https://internal-api.example.com
```

Use the same `INTERNAL_DASHBOARD_TOKEN` for the API and web deployments. Use a
separate `INTERNAL_ENTITY_WRITE_TOKEN` for privileged preview/apply operations,
and a separate `INTERNAL_POLYMARKET_CATALOG_WRITE_TOKEN` for catalog draft and
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

### `packages/collectors/.env`
```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
NEWS_FEED_API_KEY=

# --- Hermes (central service: src/hermes/) ---
# HERMES_COMMAND=hermes            # override the CLI binary if not on PATH
# NEWS_HERMES_PROFILE=myboonfeed   # news worker chat profile
# NEWS_HERMES_TOOLSETS=browser,web
# EDITOR_DRAFT_HERMES_TIMEOUT_MS=600000

# --- Research gate + engine (entity pipeline rebuild) ---
# Both ON by default. Kill switches, '1' disables:
# RESEARCH_GATE_DISABLED=0         # skip the pre-research entity-memory check
# RESEARCH_ENGINE_DISABLED=0       # fall back to legacy planner/last30days path
# RESEARCH_ENGINE_HERMES_PROFILE=  # optional chat profile for engine runs

POLYMARKET_MARKETS_RUN_ONCE=0
POLYMARKET_RESEARCHER_RUN_ONCE=0
ENTITY_MANAGER_POLYMARKET_RUN_ONCE=0
ENTITY_MANAGER_POLYMARKET_INTERVAL_MS=300000
ENTITY_MANAGER_POLYMARKET_BATCH_SIZE=20
NEWS_FEED_RUN_ONCE=0
NEWS_FEED_INTERVAL_MS=600000
NEWS_RESEARCHER_RUN_ONCE=0
NEWS_RESEARCHER_INTERVAL_MS=300000
NEWS_RESEARCHER_BATCH_SIZE=5
ENTITY_MANAGER_NEWS_RUN_ONCE=0
ENTITY_MANAGER_NEWS_INTERVAL_MS=300000
ENTITY_MANAGER_NEWS_BATCH_SIZE=20
EDITOR_DRAFT_RUN_ONCE=0
EDITOR_DRAFT_INTERVAL_MS=3600000
EDITOR_DRAFT_BATCH_SIZE=2
PUBLISHER_RUN_ONCE=0
PUBLISHER_INTERVAL_MS=300000
PUBLISHER_BATCH_SIZE=10
PUBLISHER_PREVIEW_ONLY=0
```

---

## Smoke test (after deploy)

```bash
curl http://localhost:3000/health
# {"status":"ok"}

pnpm --filter @myboon/api smoke

# Pipeline: per-stage backlog + statuses (should list stages, not error)
pnpm --filter @myboon/collectors pipeline-store:status

# Watch the researcher's first cycle end-to-end. Expect gate verdicts in the
# result JSON (skippedRecentlyResearched / skipped[].reason gate_already_known)
# and engine outcomes (nothingFound count, research_backend research_engine).
pm2 logs myboon-polymarket-researcher --lines 100
```

After a restart following downtime, prefer a cautious first cycle: watch the
first few engine conclusions by hand before trusting the cadence. Kill
switches if anything misbehaves: `RESEARCH_GATE_DISABLED=1`,
`RESEARCH_ENGINE_DISABLED=1` (set in `packages/collectors/.env` or the
researcher's PM2 env, then `pm2 restart myboon-polymarket-researcher --update-env`).
