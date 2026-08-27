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
      restart_delay: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        PORT: '3000',
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
      restart_delay: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        POLYMARKET_MARKETS_RUN_ONCE: '0',
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
      restart_delay: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        NEWS_SQLITE_PATH: '.data/news.sqlite',
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
      restart_delay: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        ...HERMES_ENV,
        HERMES_COMMAND: '/root/.local/bin/mybooneditor',
        EDITOR_DRAFT_RUN_ONCE: '0',
        EDITOR_DRAFT_INTERVAL_MS: '3600000',
        EDITOR_DRAFT_BATCH_SIZE: '2',
        EDITOR_DRAFT_RECENT_MEMORY_LIMIT: '3',
        EDITOR_DRAFT_LANE_MEMORY_LIMIT: '20',
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
      restart_delay: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        PUBLISHER_RUN_ONCE: '0',
        PUBLISHER_INTERVAL_MS: '300000',
        PUBLISHER_BATCH_SIZE: '10',
        PUBLISHER_PREVIEW_ONLY: '0',
      },
    },
    {
      name: 'myboon-hermes-orphan-sweeper',
      script: 'src/hermes/run-orphan-sweeper.ts',
      interpreter: TSX,
      cwd: `${ROOT}/packages/collectors`,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        HERMES_ORPHAN_SWEEP_INTERVAL_MS: '300000',
        HERMES_ORPHAN_MAX_AGE_MS: '900000',
        HERMES_ORPHAN_KILL_GRACE_MS: '5000',
        HERMES_ORPHAN_WORKSPACE_ROOT: ROOT,
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
      restart_delay: 5000,
      // Must remain greater than FEED_V3_RESEARCH_DRAIN_GRACE_MS so the
      // runner can fence new claims and finish its bounded active call.
      kill_timeout: 180000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        ...HERMES_ENV,
        // Ownership/deep values come from the invoking shell when explicitly
        // supplied; otherwise the runner loads collectors/.env. Code defaults
        // remain safe-off when neither source defines them.
        ...RESEARCH_RUNTIME_ENV,
        FEED_V3_RESEARCH_RUN_ONCE: '0',
        FEED_V3_RESEARCH_INTERVAL_MS: '5000',
        FEED_V3_RESEARCH_BATCH_SIZE: '10',
        FEED_V3_RESEARCH_PROMPT_VERSION: 'research.synthesis.prompt.v1',
        FEED_V3_RESEARCH_URGENT_PRIORITIES: 'P0,P1',
        FEED_V3_RESEARCH_BACKGROUND_PRIORITIES: 'P2,P3',
        FEED_V3_RESEARCH_MAX_CONSECUTIVE_CLAIMS_PER_SOURCE: '2',
        FEED_V3_RESEARCH_RECOVERY_INTERVAL_MS: '30000',
        FEED_V3_RESEARCH_RECOVERY_LIMIT_PER_SOURCE: '100',
        FEED_V3_RESEARCH_DRAIN_GRACE_MS: '150000',
        FEED_V3_RESEARCH_RUNTIME_STATUS_PATH: '.data/feed-v3-research-runtime-status.json',
        FEED_V3_RESEARCH_RUNTIME_STATUS_STALE_MS: '60000',
        FEED_V3_RUNTIME_CONTROL_PATH: '.data/feed-v3-runtime-control.json',
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
      restart_delay: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        ...HERMES_ENV,
        ...ENTITY_OWNERSHIP_ENV,
        ...FEED_V3_POLICY_ENV,
        FEED_V3_RUNTIME_CONTROL_PATH: '.data/feed-v3-runtime-control.json',
        FEED_V3_ENTITY_RUN_ONCE: '0',
        FEED_V3_ENTITY_INTERVAL_MS: '30000',
        FEED_V3_ENTITY_BATCH_SIZE: '10',
        FEED_V3_ENTITY_RUNTIME_STATUS_PATH: '.data/feed-v3-entity-runtime-status.json',
        FEED_V3_ENTITY_RUNTIME_STATUS_STALE_MS: '60000',
      },
    },
  ],
}
