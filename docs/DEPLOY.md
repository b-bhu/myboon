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

# pinned agent-browser HTTP-only reader used by the news fast path
pnpm --filter @myboon/collectors exec agent-browser --version
pnpm --filter @myboon/collectors exec agent-browser --json --content-boundaries \
  --max-output 2000 read https://example.com
```

If the Hermes chat command fails, news browser fallback and the Polymarket
research engine cannot work; fix Hermes before starting, or set
`RESEARCH_ENGINE_DISABLED=1` (the researcher then uses the legacy retrieval
path, which additionally needs `python3.12` and the last30days script at
`/root/.agents/skills/last30days/scripts/last30days.py`). If only the
agent-browser smoke fails, news can still use Hermes browser fallback, but the
lower-CPU fast path is unavailable. Version 0.34.0 requires Node.js 24 or newer.

Known news article URLs are first retrieved by a public-only HTTP client that
validates every redirect before requesting it and pins the validated DNS address
through connection. The retrieved bytes are then exposed on a random, one-use
loopback URL for pinned `agent-browser`'s HTTP-only `read` command; agent-browser
never receives the external URL. A successful conversion must report
`lifecycle.launched=false`; its bounded content is treated as untrusted evidence
and passed to structured Hermes. A blocked, short, or timed-out conversion may
fall back to Hermes browser/web chat only with agent-browser native domain
containment set to the already-vetted redirect hosts. Contained source-URL
fallback excludes the separate Hermes `web` tool because it does not inherit
agent-browser network policy. Invalid, private, or
incompletely vetted destinations fail closed and never reach that fallback.
`NEWS_AGENT_BROWSER_DIRECT_READ_ENABLED=0` is the fast
kill switch, while `NEWS_HERMES_BROWSER_FALLBACK_ENABLED=0` disables fallback.

All programmatic Hermes calls go through `HermesService`. Browser chat and
structured one-shot work have independent cross-process budgets, controlled by
`HERMES_BROWSER_MAX_CONCURRENCY` and `HERMES_STRUCTURED_MAX_CONCURRENCY`, so a
long browser queue cannot starve entity/editor calls. Chat calls are tagged
`--source tool`; the service captures Hermes' exact `session_id` and deletes
that session after the call. On timeout it signals the complete Unix process
group, keeps the concurrency lease through the SIGKILL grace period, and confirms
group exit so browser descendants do not survive as orphan Chrome processes.
Interactive Hermes sessions are not selected or pruned by this lifecycle.

If a machine was interrupted before exact cleanup completed, inspect only the
programmatic session lane first, then prune it explicitly:

```bash
hermes sessions prune --source tool --older-than 1h --dry-run
hermes sessions prune --source tool --older-than 1h --yes
```

Repeat with `--profile myboonfeed` for the news profile. Never run an
unfiltered session prune on the production host.

---

## Pipeline state lives in SQLite on this box

Temporary pipeline state lives in local SQLite files, not Supabase:

```
packages/collectors/.data/pipeline.sqlite # Polymarket candidates/research/queues
packages/collectors/.data/news.sqlite     # news candidates/dedupe/research/queues
```

- These files are the pipelines' queues and working memory. Deleting either loses
  in-flight work. It is not in git and is not reproducible from Supabase.
- Backlog / per-stage status for both Polymarket and news:
  `pnpm --filter @myboon/collectors pipeline-store:status`
- Verified online backups for both `pipeline.sqlite` and `news.sqlite`:
  `pnpm --filter @myboon/collectors pipeline-store:backup`
  (run it on a cron; it is cheap)
- The three production news workers must all use the same `NEWS_SQLITE_PATH`.
- News Entity Manager reads research packets from `news.sqlite` and writes only
  final `entities` and `entity_memories` records to Supabase.
- Supabase product tables remain available to the app/API, including `entities`,
  `entity_memories`, `published_narratives`, and `entity_published_history`.
- Migration `20260818145731_drop_retired_pipeline_tables.sql` removes the retired
  Supabase news, Polymarket working-state, and editor-draft tables. It does not
  touch either local SQLite file or any durable entity/publishing table.

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
TOKENS_API_KEY=
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
TOKENS_API_KEY=
NEWS_SQLITE_PATH=.data/news.sqlite

# --- Hermes (central service: src/hermes/) ---
# HERMES_COMMAND=hermes            # override the CLI binary if not on PATH
# HERMES_BROWSER_MAX_CONCURRENCY=2
# HERMES_BROWSER_CONCURRENCY_LOCK_DIR=/tmp/myboon-hermes-slots
# HERMES_STRUCTURED_MAX_CONCURRENCY=4
# HERMES_STRUCTURED_CONCURRENCY_LOCK_DIR=/tmp/myboon-hermes-structured-slots
# Legacy HERMES_MAX_CONCURRENCY/HERMES_CONCURRENCY_LOCK_DIR are browser fallbacks
# NEWS_HERMES_PROFILE=myboonfeed   # news worker chat profile
# NEWS_HERMES_TOOLSETS=browser,web
# NEWS_AGENT_BROWSER_DIRECT_READ_ENABLED=1
# NEWS_AGENT_BROWSER_READ_TIMEOUT_MS=30000
# NEWS_AGENT_BROWSER_MAX_OUTPUT_CHARS=40000
# NEWS_HERMES_BROWSER_FALLBACK_ENABLED=1
# EDITOR_DRAFT_HERMES_TIMEOUT_MS=600000

# --- Research gate + engine (entity pipeline rebuild) ---
# Both ON by default. Kill switches, '1' disables:
# RESEARCH_GATE_DISABLED=0         # skip the pre-research entity-memory check
# RESEARCH_ENGINE_DISABLED=0       # fall back to legacy planner/last30days path
# RESEARCH_ENGINE_HERMES_PROFILE=  # optional chat profile for engine runs

POLYMARKET_MARKETS_RUN_ONCE=0
POLYMARKET_RESEARCHER_RUN_ONCE=0
POLYMARKET_RESEARCHER_INTERVAL_MS=300000
ENTITY_MANAGER_POLYMARKET_RUN_ONCE=0
ENTITY_MANAGER_POLYMARKET_INTERVAL_MS=300000
ENTITY_MANAGER_POLYMARKET_BATCH_SIZE=20
ENTITY_MANAGER_POLYMARKET_MAX_AGE_MS=172800000  # only the latest 48h reaches Hermes
ENTITY_MANAGER_POLYMARKET_LEASE_MS=7200000
ENTITY_MANAGER_POLYMARKET_MAX_ATTEMPTS=3         # transient extraction attempts
ENTITY_MANAGER_POLYMARKET_RETRY_BASE_MS=300000   # exponential backoff, capped at 1h
NEWS_FEED_RUN_ONCE=0
NEWS_FEED_INTERVAL_MS=600000
NEWS_RESEARCHER_RUN_ONCE=0
NEWS_RESEARCHER_INTERVAL_MS=300000
NEWS_RESEARCHER_BATCH_SIZE=10
NEWS_RESEARCHER_CONCURRENCY=2
NEWS_RESEARCH_BACKLOG_WARN_COUNT=20
NEWS_RESEARCH_BACKLOG_WARN_AGE_MS=3600000
ENTITY_MANAGER_NEWS_RUN_ONCE=0
ENTITY_MANAGER_NEWS_INTERVAL_MS=300000
ENTITY_MANAGER_NEWS_BATCH_SIZE=20
ENTITY_MANAGER_HERMES_TIMEOUT_MS=600000
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
