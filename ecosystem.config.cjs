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
      name: 'myboon-polymarket-researcher',
      script: 'src/polymarket/run-researcher.ts',
      interpreter: TSX,
      cwd: `${ROOT}/packages/collectors`,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        // Pre-research entity gate and read-and-conclude research engine
        // (src/research-gate/, src/research-engine/). Both ON by default;
        // flip a switch to '1' to fall back to the previous behavior
        // without a code change. The engine runs
        // `hermes chat --toolsets browser,web` - the hermes CLI must be
        // installed and authenticated on this box (see docs/DEPLOY.md,
        // "Hermes CLI prerequisite").
        RESEARCH_GATE_DISABLED: '0',
        RESEARCH_ENGINE_DISABLED: '0',
      },
    },
    {
      name: 'myboon-news-runner',
      script: 'src/news/run-news-supabase.ts',
      interpreter: TSX,
      cwd: `${ROOT}/packages/collectors`,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        NEWS_RUNNER_RUN_ONCE: '0',
        NEWS_RUNNER_INTERVAL_MS: '3600000',
        NEWS_RUNNER_BATCH_SIZE: '1',
      },
    },
    {
      name: 'myboon-news-entity-manager',
      script: 'src/entity-manager/run-news-supabase.ts',
      interpreter: TSX,
      cwd: `${ROOT}/packages/collectors`,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        ENTITY_MANAGER_NEWS_RUN_ONCE: '0',
        ENTITY_MANAGER_NEWS_INTERVAL_MS: '300000',
        ENTITY_MANAGER_NEWS_BATCH_SIZE: '20',
      },
    },
    {
      name: 'myboon-polymarket-entity-manager',
      script: TSX_CLI,
      args: 'src/entity-manager/run-polymarket.ts',
      interpreter: 'node',
      cwd: `${ROOT}/packages/collectors`,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        ENTITY_MANAGER_POLYMARKET_RUN_ONCE: '0',
        ENTITY_MANAGER_POLYMARKET_INTERVAL_MS: '300000',
        ENTITY_MANAGER_POLYMARKET_BATCH_SIZE: '20',
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
  ],
}
