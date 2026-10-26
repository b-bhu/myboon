/**
 * #479: the Story analyst one-shot. Admits fresh signals, claims them as
 * worker 'analyst', links, and runs ONE logged Jev call per signal, exactly
 * like runAnalystOnce -- the entrypoint only wires the environment:
 *
 *   ANALYST_DATABASE_URL  required; the Postgres the analyst connects to
 *                         (service_role connection in a Supabase deployment).
 *   JEV_API_TOKEN         required; the shared team token, read by jevFromEnv
 *                         and never printed, logged or written.
 *   ANALYST_LIMIT         optional; claims per run (default 50).
 *   ANALYST_LEASE_MS      optional; claim lease (default 60000).
 *   ANALYST_BACKOFF_MS    optional; retry backoff base (default 60000).
 *   ANALYST_JEV_TIMEOUT_MS optional; per-call Jev timeout (default 30000).
 *
 * Run: pnpm --filter @myboon/analyst analyst:once
 * No .env files are read or created; the PM2 wiring belongs to the systems
 * manager (see packages/analyst/README.md). Not run by tests.
 */
import { Pool } from 'pg';

import { admitSignals, jevFromEnv, runAnalystOnce, type JevQuestion } from '../src/index.js';

/**
 * Constructor question skeleton: the per-call questions ({state, questions},
 * built by runAnalystOnce for every signal) always override it, but the
 * primary question (entity first) must come from here.
 */
const storyQuestions: Record<string, JevQuestion> = {
  entity: {
    type: 'choice',
    instructions: 'Which of the candidate entities is this signal mainly about? Choose exactly one candidate slug.',
    criteria: {},
  },
  item: {
    type: 'choice',
    instructions:
      'Which listed item does this signal mostly update? Pick its id, or new_story when the signal starts something none of the listed items cover, or adds_nothing when it adds nothing to any of them.',
    criteria: {},
  },
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') {
    console.error(`${name} is required (see packages/analyst/README.md)`);
    process.exit(1);
  }
  return value;
}

function optionalIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const pool = new Pool({ connectionString: requiredEnv('ANALYST_DATABASE_URL') });
const jev = jevFromEnv(storyQuestions);

try {
  const admitted = await admitSignals(pool);
  const run = await runAnalystOnce(pool, {
    jev,
    limit: optionalIntEnv('ANALYST_LIMIT', 50),
    leaseMs: optionalIntEnv('ANALYST_LEASE_MS', 60_000),
    backoffMs: optionalIntEnv('ANALYST_BACKOFF_MS', 60_000),
    timeoutMs: optionalIntEnv('ANALYST_JEV_TIMEOUT_MS', 30_000),
  });
  console.log(JSON.stringify({ admitted, ...run }));
} finally {
  await pool.end();
}