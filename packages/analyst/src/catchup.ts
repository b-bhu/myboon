/**
 * #391 the one-off catch-up script: drain the received backlog through the same D36 claim path the
 * live cron worker uses (claims go only through atlas.signal_claim, which is lease + SKIP LOCKED
 * safe against the 30-minute cron), while
 *   - the standing 24h rule in processNextD36 parks every signal older than 24 hours without an
 *     LLM call (parked_reason backlog_skip_24h), so only the fresh backlog is analysed,
 *   - PgDecisionSink runs with allowNewEntities: false, so a catch-up run cannot create shelves
 *     (an already active slug still files) and items copy the signal's occurred_at via the sink,
 *   - guard.check() runs before every signal and stops the loop fail-closed (Ollama balance below
 *     15% remaining, or the balance endpoint unreadable; reads are cached to <= 1/min).
 * It keeps ANALYST_ENABLED out of the picture: the only gate is ANALYST_CATCHUP_CONFIRM=yes,
 * because this claims and analyses real signals, so it cannot run by accident. Usage:
 *
 *   ANALYST_CATCHUP_CONFIRM=yes tsx src/catchup.ts [--max N] [--dry-run]
 *
 * --dry-run only logs the catchup_start backlog counts and exits; to keep it harmless it is
 * refused unless ANALYST_DATABASE_URL points at localhost/127.0.0.1. Every log line is one JSON
 * object: catchup_start (the backlog counts), one jev_call / target_dropped line per event,
 * catchup_quota_stop, and exactly one catchup_done with outcome counts and the request counters
 * (llm_calls, jev_calls, clef_calls count every call, success or failure).
 */
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

import type { AnalystConfig } from './config.js';
import { parseAnalystConfig } from './config.js';
import type { Decider } from './deciders.js';
import { PgDecisionSink, processNextD36, shelfSearchFromDb, type D36Options } from './d36-worker.js';
import { analystPoolConfig, loadAnalystDatabaseCa } from './db-pool.js';
import { defaultDeciders } from './runner.js';
import { createOllamaLlm, type JevLogEntry, type Llm } from './session.js';
import type { Db } from './states.js';
import { createQuotaGuard, readOllamaQuota, type QuotaGuard, type QuotaReading } from './ollama-quota.js';

const CONFIRM_ENV = 'ANALYST_CATCHUP_CONFIRM';

export type CatchupSummary = {
  stop_reason: 'idle' | 'quota' | 'max';
  processed: number;
  analysed: number;
  parked: number;
  failed: number;
  lost_claim: number;
  llm_calls: number;
  jev_calls: number;
  clef_calls: number;
  quota_checks: number;
  run_ms: number;
  last_quota: QuotaReading | null;
};

export type CatchupMainOptions = {
  /** The environment to parse; secrets are read from here only. */
  env: Record<string, string | undefined>;
  /** CLI arguments for the script; the CLI passes process.argv.slice(2), tests pass what they need. */
  argv?: string[];
  /** Pool factory for tests; the default is one pg Pool, max 2, on ANALYST_DATABASE_URL. */
  createPool?: (url: string) => Pool;
  /** LLM factory for tests; the default is the Ollama chat client on the configured key/model. */
  createLlm?: (c: AnalystConfig) => Llm;
  /** Decider factory for tests; the default is Jev primary, Clef fallback, a Clef shadow when on. */
  createDeciders?: (c: AnalystConfig) => { primary: Decider; fallback: Decider; shadow: Decider | null };
  /** Quota guard for tests; the default reads ollama.com's /api/balance (fail closed, <= 1 read/min). */
  quota?: QuotaGuard;
  /** Line sink for every log line (start, jev calls, drops, quota stop, done); default is stdout. */
  log?: (line: string) => void;
};

/** --dry-run (plan only, local databases only) and --max N (default: unlimited); a typo is refused. */
export function parseCatchupArgs(argv: string[]): { dryRun: boolean; max: number | null } {
  let dryRun = false;
  let max: number | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    const inline = arg.startsWith('--max=') ? arg.slice('--max='.length) : null;
    const raw = inline ?? (arg === '--max' ? argv[i + 1] : null);
    if (raw !== null) {
      if (raw === undefined || !/^\d+$/.test(raw)) throw new Error('--max must be a non-negative integer (--max 25)');
      if (inline === null) i += 1;
      max = Number(raw);
      continue;
    }
    throw new Error(`unknown argument ${arg} (supported: --max N, --dry-run)`);
  }
  return { dryRun, max };
}

// Hosts a --dry-run may touch: localhost and loopback only.
const DRY_RUN_HOSTS = new Set(['localhost', '127.0.0.1']);

function isLocalDbUrl(databaseUrl: string): boolean {
  try {
    return DRY_RUN_HOSTS.has(new URL(databaseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * The read-only counts the catchup_start line reports: the fresh backlog (due within
 * 24h, the only portion this script will analyse) and the older tail it will park.
 */
async function backlogCounts(db: Db): Promise<{ backlog_24h: number; older_than_24h: number }> {
  const { rows } = await db.query<{ backlog_24h: number; older_than_24h: number }>(
    `select count(*) filter (where occurred_at >= now() - interval '24 hours')::int as backlog_24h,
            count(*) filter (where occurred_at <  now() - interval '24 hours')::int as older_than_24h
       from atlas.signals where status = 'received'`,
  );
  return rows[0] ?? { backlog_24h: 0, older_than_24h: 0 };
}

/**
 * Parse the config first (the gates run before any pool exists), then wire the same stack as
 * analystMain — with catchup-specific knobs — drain the backlog and always end the pool. Errors
 * propagate to the entrypoint, which sets the exit code; the summary is returned on success only.
 */
export async function catchupMain(o: CatchupMainOptions): Promise<CatchupSummary> {
  const { dryRun, max } = parseCatchupArgs(o.argv ?? []);
  if (o.env[CONFIRM_ENV] !== 'yes') {
    throw new Error(`refusing to run; set ${CONFIRM_ENV}=yes to confirm draining the live backlog (it claims and analyses real signals)`);
  }
  const c = parseAnalystConfig(o.env);
  if (dryRun && !isLocalDbUrl(c.databaseUrl)) {
    throw new Error('--dry-run is only allowed against a localhost ANALYST_DATABASE_URL');
  }

  const log = o.log ?? ((line: string) => { console.log(line); });
  const startedAt = Date.now();
  const summary: CatchupSummary = {
    stop_reason: 'idle', processed: 0, analysed: 0, parked: 0, failed: 0, lost_claim: 0,
    llm_calls: 0, jev_calls: 0, clef_calls: 0, quota_checks: 0, run_ms: 0, last_quota: null,
  };

  const pool = o.createPool
    ? o.createPool(c.databaseUrl)
    : new Pool({ ...analystPoolConfig(c.databaseUrl, loadAnalystDatabaseCa(o.env)), max: 2 });
  try {
    log(JSON.stringify({ event: 'catchup_start', ...(await backlogCounts(pool)) }));
    if (dryRun) {
      summary.stop_reason = 'idle';
      summary.run_ms = Date.now() - startedAt;
      log(JSON.stringify({ event: 'catchup_done', ...summary }));
      return summary;
    }

    // Request counters: one increment per call, success or failure (#391 reporting).
    const calls = { llm: 0, jev: 0, clef: 0 };
    const rawLlm = o.createLlm ? o.createLlm(c) : createOllamaLlm({ apiKey: c.ollamaApiKey, model: c.llmModel, timeoutMs: c.timeoutMs });
    const llm: Llm = async (messages) => {
      calls.llm += 1;
      return rawLlm(messages);
    };
    const counted = (d: Decider): Decider => ({
      name: d.name,
      modelName: d.modelName,
      modelVersion: d.modelVersion,
      async decide(kase, signal) {
        if (d.name === 'jev') calls.jev += 1;
        else calls.clef += 1;
        return d.decide(kase, signal);
      },
    });
    const { primary, fallback, shadow } = o.createDeciders ? o.createDeciders(c) : defaultDeciders(c);
    const guard = o.quota ?? createQuotaGuard({ read: () => readOllamaQuota(c.ollamaApiKey) });

    const opts: D36Options = {
      llm,
      primary: counted(primary),
      fallback: counted(fallback),
      shadow: shadow === null ? null : counted(shadow),
      search: shelfSearchFromDb(pool),
      // No new entities during catch-up: a proposed shelf gets no item and no shelf is inserted.
      sink: new PgDecisionSink(pool, (e) => { log(JSON.stringify(e)); }, { allowNewEntities: false }),
      log: (e: JevLogEntry) => { log(JSON.stringify({ event: 'jev_call', ...e })); },
      leaseMs: c.leaseMs,
      timeoutMs: c.timeoutMs,
      backoffMs: c.backoffMs,
      maxAttempts: c.maxAttempts,
      // A catch-up claim is namespaced so it can be told apart from the live cron worker in logs.
      worker: `${c.worker}-catchup`,
    };

    for (;;) {
      if (max !== null && summary.processed >= max) {
        summary.stop_reason = 'max';
        break;
      }
      summary.quota_checks += 1;
      const check = await guard.check();
      if (check.reading) summary.last_quota = check.reading;
      if (!check.ok) {
        summary.stop_reason = 'quota';
        log(JSON.stringify({ event: 'catchup_quota_stop', ...(check.reading ?? {}), reason: check.reason ?? 'quota unreadable' }));
        break;
      }
      const result = await processNextD36(pool, opts);
      if (!result) break; // idle: the backlog is drained
      summary.processed += 1;
      summary[result.result] += 1;
    }

    summary.llm_calls = calls.llm;
    summary.jev_calls = calls.jev;
    summary.clef_calls = calls.clef;
    summary.run_ms = Date.now() - startedAt;
    log(JSON.stringify({ event: 'catchup_done', ...summary }));
    return summary;
  } finally {
    await pool.end();
  }
}

/**
 * The CLI (only when this file is the entrypoint — tests import catchupMain directly). The
 * confirm gate is enforced inside catchupMain, so the exit code and message are the same code
 * path; a refusal or a failed run prints the message and exits 1, never a secret value.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  catchupMain({ env: process.env, argv: process.argv.slice(2) }).catch((e: unknown) => {
    console.error(`catchup: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}