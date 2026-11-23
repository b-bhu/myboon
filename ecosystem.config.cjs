/**
 * PM2 ecosystem — myboon API and V4 pipeline services
 *
 * Start:   pm2 start ecosystem.config.cjs
 * Reload:  pm2 reload ecosystem.config.cjs
 * Stop:    pm2 stop all
 * Logs:    pm2 logs
 * Monitor: pm2 monit
 *
 * One-time VPS setup:
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 startup   ← run the printed command as root
 *
 * Env vars are loaded by each package from its own .env file.
 *
 * NOTE: Uses ./node_modules/.bin/tsx instead of `node --import tsx/esm`
 * because Node 22 has ERR_REQUIRE_CYCLE_MODULE bugs with the ESM loader.
 */
const ROOT = __dirname
const TSX = `${ROOT}/node_modules/.bin/tsx`

// #444 V4 runtime, Sprint 1 scope: the scout stage. #391 adds the analyst
// worker; #582 adds the web reader (15-min cron tick; still flag-off / not
// go-live'd). The old #480 myboon-entity-manager app
// (packages/analyst/src/entity-manager-run.ts) was retired in the #571
// cleanup. #593 registers the new entity manager, the separate
// @myboon/entity-manager package, as myboon-entity-manager below:
// ENTITY_MANAGER_ENABLED defaults to false in this file, so a plain reload
// never enables it; the shell/env turns it on.
//   myboon-scout            -> packages/scout-news/src/run.ts                (15-min cron tick)
//   myboon-analyst          -> packages/analyst/src/run.ts                    (30-min cron tick)
//   myboon-entity-manager   -> packages/entity-manager/src/run.ts             (tick at :00 and :45, flag off)
//   myboon-entity-manager-retry -> packages/entity-manager/src/run-retry.ts   (once a day, flag off, #621)
//   myboon-web-reader       -> packages/web-reader/src/run.ts                 (15-min cron tick)
//   myboon-latest-updates   -> packages/latest-updates/src/run.ts             (tick at :25 and :55, flag off, #634)
// Each V4 app runs one cycle and exits; PM2 starts it again at the next
// cron tick (cron_restart). autorestart stays off so a failing run neither
// loops nor hides in backoff: the crash state is visible until the next
// scheduled tick, and the health line carries what actually failed.
// NOT registered by default: V4_APPS joins `apps` only when
// MYBOON_V4_RUNTIME_ENABLED=1, so plain `pm2 start/reload` of this file never
// registers the V4 apps. After go-live, reloads of this file must also set
// MYBOON_V4_RUNTIME_ENABLED=1 or the V4 apps are left out of the reload.
// Go-live sequence (only after CTO approval, following Backend Dev local e2e):
//   1. Back up the current process list BEFORE anything else:
//        cp ~/.pm2/dump.pm2 ~/.pm2/dump.pm2.bak-$(date +%Y%m%d%H%M)
//   2. MYBOON_V4_RUNTIME_ENABLED=1 pm2 start ecosystem.config.cjs --only myboon-scout
//   3. pm2 save   (persists the new list; dump backup is the rollback path)
// Analyst go-live is the same sequence with:
//   MYBOON_V4_RUNTIME_ENABLED=1 pm2 start ecosystem.config.cjs --only myboon-analyst
const V4_APPS = [
  {
    name: 'myboon-scout',
    script: 'src/run.ts',
    interpreter: TSX,
    cwd: `${ROOT}/packages/scout-news`,
    watch: false,
    // One run per tick, then exit; autorestart must not fight that exit.
    autorestart: false,
    cron_restart: '*/15 * * * *',
    max_memory_restart: '300M',
    kill_timeout: 30000,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    env: {
      V4_STAGE: 'scout-news',
      // Off-switch: set in the shell, never by editing this tracked file:
      // `SCOUT_ENABLED=false MYBOON_V4_RUNTIME_ENABLED=1 pm2 restart ecosystem.config.cjs --only myboon-scout --update-env`
      SCOUT_ENABLED: process.env.SCOUT_ENABLED ?? 'false',
    },
  },
  {
    // Secrets ANALYST_DATABASE_URL, OLLAMA_API_KEY and JEV_API_TOKEN are never
    // set in this file; they come from the sourced .env. 30-min tick (#391).
    // Typical run is ~7.5 min for 20 signals (first prod run, Oct 30). Worst
    // case is 20 signals x 4 asks x (primary + fallback) 2 x 20s = 3200s, so a
    // rare slow run is cut short by the next tick. That is safe: PM2 runs one
    // process per app and cron_restart restarts (kills) rather than starting a
    // second copy, so runs never overlap; finished signals are already
    // committed (one transaction per save, on conflict no-op). A killed run's signal stays claimed until
    // its 300s lease expires and is retried with backoff.
    name: 'myboon-analyst',
    script: 'src/run.ts',
    interpreter: TSX,
    cwd: `${ROOT}/packages/analyst`,
    watch: false,
    // One run per tick, then exit; autorestart must not fight that exit.
    autorestart: false,
    cron_restart: '*/30 * * * *',
    max_memory_restart: '300M',
    kill_timeout: 30000,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    env: {
      V4_STAGE: 'analyst',
      // Off-switch: set in the shell, never by editing this tracked file:
      // `ANALYST_ENABLED=false MYBOON_V4_RUNTIME_ENABLED=1 pm2 restart ecosystem.config.cjs --only myboon-analyst --update-env`
      ANALYST_ENABLED: process.env.ANALYST_ENABLED ?? 'false',
      ANALYST_WORKER: 'myboon-analyst',
      ANALYST_LLM_MODEL: 'glm-5.3-flash',
      ANALYST_MAX_SIGNALS_PER_RUN: '40',
      ANALYST_LEASE_MS: '300000',
      ANALYST_TIMEOUT_MS: '20000',
      ANALYST_BACKOFF_MS: '60000',
      ANALYST_MAX_ATTEMPTS: '3',
      ANALYST_SHADOW: 'false',
      // #625 intake filter (near-duplicate / empty titles parked before the LLM). Off by default; the shell turns it on.
      ANALYST_INTAKE_FILTER_ENABLED: process.env.ANALYST_INTAKE_FILTER_ENABLED ?? 'false',
    },
  },
  {
    // #593 the entity manager: claims analyst handoffs and decides story /
    // park / duplicate per entity (the @myboon/entity-manager package). One
    // run per tick at :00 and :45, then exit. Secrets
    // ENTITY_MANAGER_DATABASE_URL, OLLAMA_API_KEY and optional JEV_API_TOKEN
    // are never set in this file; they come from the sourced .env.
    name: 'myboon-entity-manager',
    script: 'src/run.ts',
    interpreter: TSX,
    cwd: `${ROOT}/packages/entity-manager`,
    watch: false,
    // One run per tick, then exit; autorestart must not fight that exit.
    autorestart: false,
    cron_restart: '0,45 * * * *',
    max_memory_restart: '300M',
    kill_timeout: 30000,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    env: {
      V4_STAGE: 'entity-manager',
      // Off-switch: set in the shell, never by editing this tracked file:
      // `ENTITY_MANAGER_ENABLED=false MYBOON_V4_RUNTIME_ENABLED=1 pm2 restart ecosystem.config.cjs --only myboon-entity-manager --update-env`
      ENTITY_MANAGER_ENABLED: process.env.ENTITY_MANAGER_ENABLED ?? 'false',
      ENTITY_MANAGER_LLM_MODEL: 'glm-5.3-flash',
      ENTITY_MANAGER_MAX_PER_RUN: '20',
      // #621 default off = claim in the same way as before (atlas.em_claim, batch 20). On: claim only handoffs
      // with an entity, batch 60 (ENTITY_MANAGER_ENTITY_ONLY_MAX_PER_RUN). Needs the em_claim_scoped migration.
      ENTITY_MANAGER_CLAIM_ENTITY_ONLY: process.env.ENTITY_MANAGER_CLAIM_ENTITY_ONLY ?? 'false',
      // #695 persist the #690 markets pass across restarts from this tracked
      // file. Default on; the shell can still switch it off:
      // `ENTITY_MANAGER_MARKETS_ENABLED=false pm2 restart ecosystem.config.cjs --only myboon-entity-manager --update-env`
      ENTITY_MANAGER_MARKETS_ENABLED: process.env.ENTITY_MANAGER_MARKETS_ENABLED ?? 'true',
    },
  },
  {
    // #621 the entity manager's daily retry of handoffs with no entity: one run a day at
    // 20:15 UTC (1:45 AM IST), then exit. Off until ENTITY_MANAGER_RETRY_ENABLED=true; go live together with
    // ENTITY_MANAGER_CLAIM_ENTITY_ONLY=true on myboon-entity-manager, after DB Guy's
    // 20261113190000_atlas_em_claim_scoped migration is applied. Secrets come from the sourced .env.
    name: 'myboon-entity-manager-retry',
    script: 'src/run-retry.ts',
    interpreter: TSX,
    cwd: `${ROOT}/packages/entity-manager`,
    watch: false,
    autorestart: false,
    cron_restart: '15 20 * * *',
    max_memory_restart: '300M',
    kill_timeout: 30000,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    env: {
      V4_STAGE: 'entity-manager-retry',
      ENTITY_MANAGER_RETRY_ENABLED: process.env.ENTITY_MANAGER_RETRY_ENABLED ?? 'false',
      ENTITY_MANAGER_LLM_MODEL: 'glm-5.3-flash',
      ENTITY_MANAGER_RETRY_MAX_PER_RUN: '2000',
    },
  },
  {
    // #582 the web reader: fills the planned atlas.signals body columns for
    // linked tokens_xyz news signals (plain fetch first, headless Hermes
    // oneshot `--ignore-rules --provider ollama-cloud -m <model> -z <prompt>`
    // as the only fallback — never a browser toolset). One run of 50 signals
    // is bounded by 5 parallel x 10 sequential Hermes calls at the 90s cap.
    // Secrets WEB_READER_DATABASE_URL is never set in this file; it comes from
    // the sourced .env. Depends on DB Guy's migration PR (columns +
    // web_reader_worker role); go-live is the analyst sequence with
    // --only myboon-web-reader and needs Bucket's yes.
    name: 'myboon-web-reader',
    script: 'src/run.ts',
    interpreter: TSX,
    cwd: `${ROOT}/packages/web-reader`,
    watch: false,
    // One run per tick, then exit; autorestart must not fight that exit.
    autorestart: false,
    cron_restart: '*/15 * * * *',
    max_memory_restart: '300M',
    kill_timeout: 30000,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    env: {
      V4_STAGE: 'web-reader',
      // Off-switch: set in the shell, never by editing this tracked file:
      // `WEB_READER_ENABLED=false MYBOON_V4_RUNTIME_ENABLED=1 pm2 restart ecosystem.config.cjs --only myboon-web-reader --update-env`
      WEB_READER_ENABLED: process.env.WEB_READER_ENABLED ?? 'false',
      WEB_READER_HERMES_MODEL: 'glm-5.3-flash',
      WEB_READER_MAX_PER_RUN: '50',
      WEB_READER_BATCH_SIZE: '10',
      WEB_READER_MAX_PARALLEL_BATCHES: '5',
      WEB_READER_BODY_CAP_CHARS: '4000',
      WEB_READER_HERMES_TIMEOUT_MS: '90000',
    },
  },
  {
    // #634 the latest-updates job (packages/latest-updates): one run per tick
    // at :25 and :55, then exit. Secrets LATEST_UPDATES_DATABASE_URL and
    // OLLAMA_API_KEY are never set in this file; they come from the sourced
    // .env. The gate defaults to false in this file so a plain reload never
    // enables it; the shell turns it on.
    name: 'myboon-latest-updates',
    script: 'src/run.ts',
    interpreter: TSX,
    cwd: `${ROOT}/packages/latest-updates`,
    watch: false,
    // One run per tick, then exit; autorestart must not fight that exit.
    autorestart: false,
    cron_restart: '25,55 * * * *',
    max_memory_restart: '300M',
    kill_timeout: 30000,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    env: {
      V4_STAGE: 'latest-updates',
      // Off-switch: set in the shell, never by editing this tracked file:
      // `LATEST_UPDATES_ENABLED=false MYBOON_V4_RUNTIME_ENABLED=1 pm2 restart ecosystem.config.cjs --only myboon-latest-updates --update-env`
      LATEST_UPDATES_ENABLED: process.env.LATEST_UPDATES_ENABLED ?? 'false',
      LATEST_UPDATES_VISIBILITY: process.env.LATEST_UPDATES_VISIBILITY ?? 'dark',
    },
  },
]

module.exports = {
  apps: [
    {
      name: 'myboon-api',
      script: 'src/index.ts',
      interpreter: TSX,
      cwd: `${ROOT}/packages/api`,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      // PM2 counts an exit within min_uptime (30s) as an unstable restart; at
      // max_restarts (10) unstable restarts inside PM2's min_uptime*max_restarts
      // window (300s) the app goes to errored instead of looping. Restarts back
      // off via exp_backoff_restart_delay: 2s, x1.5 each, capped at 15s.
      min_uptime: 30000,
      exp_backoff_restart_delay: 2000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        PORT: '3000',
      },
    },
    {
      // #702 the calendar releases job (packages/api): saves past US macro
      // releases from Backpack into atlas.event_releases. One run per day at
      // 21:00 UTC (2:30 AM IST, after the day's US prints), then exit. Secret
      // CALENDAR_RELEASES_DATABASE_URL (calendar_worker) is never set in this
      // file; it comes from packages/api/.env. The gate defaults to false in
      // this file so a plain reload never enables it; the shell turns it on.
      name: 'myboon-calendar-releases',
      script: 'src/calendar/run-releases.ts',
      interpreter: TSX,
      cwd: `${ROOT}/packages/api`,
      watch: false,
      // One run per day, then exit; autorestart must not fight that exit.
      autorestart: false,
      cron_restart: '0 21 * * *',
      max_memory_restart: '200M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        // Off-switch: set in the shell, never by editing this tracked file:
        // `CALENDAR_RELEASES_ENABLED=false pm2 restart ecosystem.config.cjs --only myboon-calendar-releases --update-env`
        CALENDAR_RELEASES_ENABLED: process.env.CALENDAR_RELEASES_ENABLED ?? 'false',
      },
    },
    // #444: V4 apps are gated. Absent from the list unless the invoking shell
    // sets MYBOON_V4_RUNTIME_ENABLED=1.
    ...(process.env.MYBOON_V4_RUNTIME_ENABLED === '1' ? V4_APPS : []),
  ],
}
