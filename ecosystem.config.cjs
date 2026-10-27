/**
 * PM2 ecosystem — myboon API and feed pipeline services
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
 * Collectors also allow the monorepo root .env as a fallback.
 *
 * NOTE: Uses ./node_modules/.bin/tsx instead of `node --import tsx/esm`
 * because Node 22 has ERR_REQUIRE_CYCLE_MODULE bugs with the ESM loader.
 */
const ROOT = __dirname
const TSX = `${ROOT}/node_modules/.bin/tsx`
const TSX_CLI = `${ROOT}/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs`
const HERMES_ENV = {
  INFERENCE_GATEWAY_HERMES_PROFILE: process.env.INFERENCE_GATEWAY_HERMES_PROFILE
    ?? 'myboon-codex-production',
  INFERENCE_GATEWAY_PRIMARY_PROVIDER: process.env.INFERENCE_GATEWAY_PRIMARY_PROVIDER
    ?? 'ollama-cloud',
  INFERENCE_GATEWAY_PRIMARY_MODEL: process.env.INFERENCE_GATEWAY_PRIMARY_MODEL
    ?? 'glm-5.3-flash',
  // Browser sessions are long and expensive; structured calls are short.
  // Separate pools prevent browser research from starving entity/editor work.
  HERMES_BROWSER_MAX_CONCURRENCY: '2',
  HERMES_BROWSER_CONCURRENCY_LOCK_DIR: '/tmp/myboon-hermes-slots',
  HERMES_STRUCTURED_MAX_CONCURRENCY: '4',
  HERMES_STRUCTURED_CONCURRENCY_LOCK_DIR: '/tmp/myboon-hermes-structured-slots',
}
// One declaration is injected into the shared Entity worker. The source-
// specific Entity PM2 registrations are intentionally absent.
const ENTITY_OWNERSHIP_KEYS = [
  'FEED_V3_ENTITY_MODE',
  'FEED_V3_ENTITY_ACTIVE_SOURCES',
  'FEED_V3_ENTITY_SHADOW_SOURCES',
  'FEED_V3_LEGACY_ENTITY_DISABLED_SOURCES',
  'FEED_V3_CUTOVER_RECEIPT_PATH',
  'FEED_V3_SHADOW_SAMPLE_BASIS_POINTS',
]
const ENTITY_OWNERSHIP_ENV = Object.fromEntries(
  ENTITY_OWNERSHIP_KEYS
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
)
const RESEARCH_OWNERSHIP_KEYS = [
  'FEED_V3_RESEARCH_MODE',
  'FEED_V3_RESEARCH_ACTIVE_SOURCES',
  'FEED_V3_RESEARCH_SHADOW_SOURCES',
  'FEED_V3_LEGACY_RESEARCH_DISABLED_SOURCES',
  'FEED_V3_CUTOVER_RECEIPT_PATH',
  'FEED_V3_SHADOW_SAMPLE_BASIS_POINTS',
]
// Policy/safety keys shared by both horizontal workers so shared Research and
// shared Entity always agree on cutover policy, triage admission, classifier,
// provider health, and deep activation. Values come from the invoking shell
// when explicitly present; otherwise each runner loads collectors/.env whose
// code defaults remain safe-off. These are injected into the two shared apps
// only; source-specific News/Polymarket Research/Entity apps are not registered.
const FEED_V3_POLICY_KEYS = [
  'FEED_V3_CUTOVER_POLICY',
  'FEED_V3_TRIAGE_ALLOWED_DEPTHS',
  'FEED_V3_TRIAGE_CLASSIFIER_ENABLED',
  'FEED_V3_TRIAGE_PROVIDER_HEALTH',
  'FEED_V3_DEEP_RESEARCH_ENABLED',
]
const FEED_V3_POLICY_ENV = Object.fromEntries(
  FEED_V3_POLICY_KEYS
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
)
const RESEARCH_RUNTIME_KEYS = [
  ...RESEARCH_OWNERSHIP_KEYS,
  ...FEED_V3_POLICY_KEYS,
  'FEED_V3_DEEP_RESEARCH_WORKER_EXECUTABLE',
  'FEED_V3_DEEP_RESEARCH_WORKER_CONTRACT_VERSION',
  'FEED_V3_DEEP_RESEARCH_WORKER_ARGS_JSON',
  'FEED_V3_DEEP_RESEARCH_APPROVED_DOMAINS',
  'FEED_V3_DEEP_RESEARCH_CAPABILITIES',
  'FEED_V3_DEEP_RESEARCH_PROVIDER',
  'FEED_V3_DEEP_RESEARCH_MODEL',
  'FEED_V3_DEEP_RESEARCH_PROMPT_VERSION',
  'FEED_V3_DEEP_RESEARCH_MAX_BROWSER_NAVIGATIONS',
  'FEED_V3_DEEP_RESEARCH_MAX_SEARCH_QUERIES',
  'FEED_V3_DEEP_RESEARCH_MAX_HTTP_FETCHES',
  'FEED_V3_DEEP_RESEARCH_MAX_OUTPUT_BYTES',
  'FEED_V3_DEEP_RESEARCH_CPU_QUOTA_PERCENT',
  'FEED_V3_DEEP_RESEARCH_MEMORY_MAX_BYTES',
  'FEED_V3_DEEP_RESEARCH_TASKS_MAX',
  'FEED_V3_DEEP_RESEARCH_REASONING_EFFORT',
  'FEED_V3_DEEP_RESEARCH_MAX_CONCURRENCY',
  'FEED_V3_DEEP_RESEARCH_RATE_MAX_CALLS',
  'FEED_V3_DEEP_RESEARCH_RATE_WINDOW_MS',
  'FEED_V3_DEEP_RESEARCH_AUDIT_TEMP_ROOTS',
  'FEED_V3_DEEP_RESEARCH_AUDIT_PROFILE_ROOTS',
  'FEED_V3_DEEP_RESEARCH_AUDIT_LIMIT',
  'FEED_V3_DEEP_RESEARCH_AUDIT_INTERVAL_MS',
  'FEED_V3_DEEP_RESEARCH_RUNTIME_STATUS_PATH',
]
const RESEARCH_RUNTIME_ENV = Object.fromEntries(
  RESEARCH_RUNTIME_KEYS
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
)

// V4 remains explicitly opted in. Numeric spending limits have no production
// defaults here; runners require a reviewed policy when follow-up is enabled.
const ENTITY_V4_RUNTIME_KEYS = [
  'ENTITY_V4_ARTICLE_WORKFLOW_ENABLED',
  'ENTITY_V4_MANAGED_WRITER_ENABLED', 'ENTITY_V4_NOVELTY_ENABLED',
  'ENTITY_V4_RESEARCH_REUSE_ENABLED', 'ENTITY_V4_FOLLOWUP_ENABLED',
  'ENTITY_V4_SOURCE_OWNERSHIP_ENABLED', 'ENTITY_V4_ACTIVE_SOURCES', 'ENTITY_V4_POLICY_VERSION',
  'MYBOON_MANAGED_KNOWLEDGE_DATABASE_URL', 'MYBOON_MANAGED_KNOWLEDGE_DATABASE_CA',
  'ENTITY_V4_REUSE_POLICY_VERSION', 'ENTITY_V4_REUSE_MAX_EVIDENCE_AGE_MS', 'ENTITY_V4_REUSE_MAX_RESEARCH_AGE_MS',
  'ENTITY_V4_SYNTHESIS_POLICY_VERSION', 'ENTITY_V4_SYNTHESIS_MAX_INPUT_TOKENS',
  'ENTITY_V4_SYNTHESIS_MAX_OUTPUT_TOKENS', 'ENTITY_V4_SYNTHESIS_MAX_COST_USD_MICROS',
  'ENTITY_V4_ASSIGNMENT_POLICY_VERSION', 'ENTITY_V4_ASSIGNMENT_MAX_PROVIDER_CALLS',
  'ENTITY_V4_ASSIGNMENT_MAX_INPUT_TOKENS', 'ENTITY_V4_ASSIGNMENT_MAX_OUTPUT_TOKENS', 'ENTITY_V4_ASSIGNMENT_MAX_COST_USD_MICROS',
  'ENTITY_V4_FOLLOWUP_POLICY_VERSION', 'ENTITY_V4_FOLLOWUP_MAX_PROVIDER_CALLS',
  'ENTITY_V4_FOLLOWUP_MAX_INPUT_TOKENS', 'ENTITY_V4_FOLLOWUP_MAX_OUTPUT_TOKENS',
  'ENTITY_V4_FOLLOWUP_MAX_COST_USD_MICROS', 'ENTITY_V4_FOLLOWUP_MAX_SOURCES',
  'ENTITY_V4_FOLLOWUP_MAX_TOTAL_BYTES', 'ENTITY_V4_FOLLOWUP_MAX_BYTES_PER_SOURCE', 'ENTITY_V4_FOLLOWUP_MAX_WALL_TIME_MS',
]
const ENTITY_V4_RUNTIME_ENV = Object.fromEntries(ENTITY_V4_RUNTIME_KEYS
  .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]))
const COLLECTOR_OWNERSHIP_KEYS = [
  'ENTITY_V4_SOURCE_OWNERSHIP_ENABLED', 'FEED_V3_INTAKE_MODE',
  'FEED_V3_INTAKE_ACTIVE_SOURCES', 'FEED_V3_INTAKE_SHADOW_SOURCES',
  ...FEED_V3_POLICY_KEYS,
]
const COLLECTOR_OWNERSHIP_ENV = Object.fromEntries(COLLECTOR_OWNERSHIP_KEYS
  .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]))

// #444 V4 runtime, Sprint 1 scope: the scout stage only. The analyst and
// entity-manager stage entries are Sprint 2 work and stay out of the process
// list until their runners are wired.
//   myboon-scout -> src/run.ts
// The scout runs one cycle and exits; PM2 starts it again at every 15-minute
// cron tick (cron_restart). autorestart stays off so a failing run neither
// loops nor hides in backoff: the crash state is visible until the next
// scheduled tick, and the health line carries what actually failed.
// NOT registered by default: V4_APPS joins `apps` only when
// MYBOON_V4_RUNTIME_ENABLED=1, so plain `pm2 start/reload` of this file never
// registers the V4 app. After go-live, reloads of this file must also set
// MYBOON_V4_RUNTIME_ENABLED=1 or the V4 app is left out of the reload.
// Go-live sequence (only after CTO approval, following Backend Dev local e2e):
//   1. Back up the current process list BEFORE anything else:
//        cp ~/.pm2/dump.pm2 ~/.pm2/dump.pm2.bak-$(date +%Y%m%d%H%M)
//   2. MYBOON_V4_RUNTIME_ENABLED=1 pm2 start ecosystem.config.cjs --only myboon-scout
//   3. pm2 save   (persists the new list; dump backup is the rollback path)
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
        ENTITY_V4_READ_SOURCE: 'managed',
      },
    },
    {
      name: 'myboon-polymarket-data-engineer',
      script: 'src/polymarket/run-markets-data-engineer.ts',
      interpreter: TSX,
      cwd: `${ROOT}/packages/collectors`,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: 30000,
      exp_backoff_restart_delay: 2000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        PIPELINE_SQLITE_PATH: '.data/polymarket-lane.sqlite',
        POLYMARKET_MARKETS_RUN_ONCE: '0',
        ...HERMES_ENV,
        ...COLLECTOR_OWNERSHIP_ENV,
        POLYMARKET_MARKETS_PREVIEW_ONLY: '0',
        POLYMARKET_MARKETS_RUN_INTERVAL_MS: '7200000',
        // Backpressure: throttle candidate creation once pending_research
        // depth reaches these levels. Material moves get a bounded bypass up
        // to the hard ceiling, not an unbounded one - see
        // isMaterialCandidate/backpressureVerdict in markets-data-engineer.ts.
        POLYMARKET_MARKETS_BACKLOG_THRESHOLD: '100',
        POLYMARKET_MARKETS_BACKLOG_HARD_CEILING: '250',
      },
    },
    {
      name: 'myboon-news-feed-ingestor',
      script: 'src/news/run-news-feed-ingestor.ts',
      interpreter: TSX,
      cwd: `${ROOT}/packages/collectors`,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: 30000,
      exp_backoff_restart_delay: 2000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        NEWS_SQLITE_PATH: '.data/news-lane.sqlite',
        ...HERMES_ENV,
        ...COLLECTOR_OWNERSHIP_ENV,
        NEWS_FEED_RUN_ONCE: '0',
        NEWS_FEED_INTERVAL_MS: '600000',
      },
    },
    {
      name: 'myboon-editor-draft',
      script: 'src/editor-draft/run.ts',
      interpreter: TSX,
      cwd: `${ROOT}/packages/collectors`,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: 30000,
      exp_backoff_restart_delay: 2000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        NEWS_SQLITE_PATH: '.data/news-lane.sqlite',
        PIPELINE_SQLITE_PATH: '.data/polymarket-lane.sqlite',
        ...HERMES_ENV,
        HERMES_COMMAND: 'hermes',
        ENTITY_V4_READ_SOURCE: 'managed',
        EDITOR_DRAFT_RUN_ONCE: '0',
        EDITOR_DRAFT_INTERVAL_MS: '3600000',
        EDITOR_DRAFT_BATCH_SIZE: '2',
        EDITOR_DRAFT_RECENT_MEMORY_LIMIT: '3',
        EDITOR_DRAFT_LANE_MEMORY_LIMIT: '10',
        EDITOR_DRAFT_PRIOR_DRAFT_LIMIT: '10',
        EDITOR_DRAFT_PUBLISHED_HISTORY_LIMIT: '10',
      },
    },
    {
      name: 'myboon-publisher',
      script: 'src/publisher/run.ts',
      interpreter: TSX,
      cwd: `${ROOT}/packages/collectors`,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: 30000,
      exp_backoff_restart_delay: 2000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        NEWS_SQLITE_PATH: '.data/news-lane.sqlite',
        PIPELINE_SQLITE_PATH: '.data/polymarket-lane.sqlite',
        PUBLISHER_RUN_ONCE: '0',
        ENTITY_V4_READ_SOURCE: 'managed',
        PUBLISHER_INTERVAL_MS: '300000',
        PUBLISHER_BATCH_SIZE: '10',
        PUBLISHER_PREVIEW_ONLY: '0',
      },
    },
    {
      // One horizontal Research runner. Off is resident but performs zero
      // SQLite/provider/network I/O; shadow peeks only; active is guarded by
      // explicit source ownership and legacy-claimer disablement.
      name: 'myboon-feed-v3-research',
      script: 'src/research-engine/run-shared-research.ts',
      interpreter: TSX,
      cwd: `${ROOT}/packages/collectors`,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: 30000,
      exp_backoff_restart_delay: 2000,
      // Must remain greater than FEED_V3_RESEARCH_DRAIN_GRACE_MS so the
      // runner can fence new claims and finish its bounded active call.
      kill_timeout: 180000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        NEWS_SQLITE_PATH: '.data/news-lane.sqlite',
        PIPELINE_SQLITE_PATH: '.data/polymarket-lane.sqlite',
        ...HERMES_ENV,
        // Ownership/deep values come from the invoking shell when explicitly
        // supplied; otherwise the runner loads collectors/.env. Code defaults
        // remain safe-off when neither source defines them.
        ...RESEARCH_RUNTIME_ENV,
        FEED_V3_RESEARCH_RUN_ONCE: '0',
        ...ENTITY_V4_RUNTIME_ENV,
        FEED_V3_RESEARCH_INTERVAL_MS: '5000',
        FEED_V3_RESEARCH_BATCH_SIZE: '10',
        FEED_V3_RESEARCH_PROMPT_VERSION: 'research.synthesis.prompt.v2',
        FEED_V3_RESEARCH_URGENT_PRIORITIES: 'P0,P1',
        FEED_V3_RESEARCH_BACKGROUND_PRIORITIES: 'P2,P3',
        FEED_V3_RESEARCH_MAX_CONSECUTIVE_CLAIMS_PER_SOURCE: '2',
        FEED_V3_RESEARCH_RECOVERY_INTERVAL_MS: '30000',
        FEED_V3_RESEARCH_RECOVERY_LIMIT_PER_SOURCE: '100',
        FEED_V3_RESEARCH_DRAIN_GRACE_MS: '150000',
        FEED_V3_RESEARCH_RUNTIME_STATUS_PATH: '.data/feed-v3-research-runtime-status.json',
        FEED_V3_RESEARCH_RUNTIME_STATUS_STALE_MS: '60000',
        FEED_V3_RUNTIME_CONTROL_PATH: '.data/feed-v3-runtime-control.json',
        // #343: 'true' saves below-floor article placements as uncertain
        // memberships instead of holding them. Stays 'false' until Bucket says
        // yes; PM2 env wins over collectors/.env, so only this line turns it on.
        ARTICLE_PLACEMENT_SAVE_UNCERTAIN: 'false',
      },
    },
    {
      // One horizontal Entity worker replaces source-specific managers only
      // after a reviewed source-by-source ownership cutover. It is inert now.
      name: 'myboon-feed-v3-entity-manager',
      script: 'src/entity-manager/run-shared.ts',
      interpreter: TSX,
      cwd: `${ROOT}/packages/collectors`,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: 30000,
      exp_backoff_restart_delay: 2000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        NEWS_SQLITE_PATH: '.data/news-lane.sqlite',
        PIPELINE_SQLITE_PATH: '.data/polymarket-lane.sqlite',
        ...HERMES_ENV,
        ...ENTITY_OWNERSHIP_ENV,
        ...FEED_V3_POLICY_ENV,
        FEED_V3_RUNTIME_CONTROL_PATH: '.data/feed-v3-runtime-control.json',
        FEED_V3_ENTITY_RUN_ONCE: '0',
        ...ENTITY_V4_RUNTIME_ENV,
        FEED_V3_ENTITY_INTERVAL_MS: '30000',
        FEED_V3_ENTITY_BATCH_SIZE: '10',
        FEED_V3_ENTITY_RUNTIME_STATUS_PATH: '.data/feed-v3-entity-runtime-status.json',
        FEED_V3_ENTITY_RUNTIME_STATUS_STALE_MS: '60000',
      },
    },
    // #444: V4 apps are gated. Absent from the list unless the invoking shell
    // sets MYBOON_V4_RUNTIME_ENABLED=1.
    ...(process.env.MYBOON_V4_RUNTIME_ENABLED === '1' ? V4_APPS : []),
  ],
}
