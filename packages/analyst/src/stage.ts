/**
 * #478: one stage run. Claims signals in the `from` state, asks Jev for a
 * decision per claim, and completes the claim to the `to` state on success;
 * failures and timeouts go back with exponential backoff and dead-letter at
 * the attempt cap. Claims are processed one at a time: Jev throughput is the
 * bottleneck anyway, and sequential calls keep the decision log honest and
 * the pool connections few.
 */
import type { Pool } from 'pg';

import { callJev, type JevPort } from './jev.js';
import { claimSignals, completeClaim, failClaim } from './states.js';

export type StageRun = { claimed: number; advanced: number; retried: number; deadLettered: number };

export type StageOptions = {
  stage: string;
  from: string;
  to: string;
  jev: JevPort;
  limit: number;
  leaseMs: number;
  backoffMs: number;
  timeoutMs: number;
};

type SignalCase = { signal_id: string; text: string | null; excerpt: string | null; link: string | null };

export async function runStageOnce(pool: Pool, o: StageOptions): Promise<StageRun> {
  const claims = await claimSignals(pool, {
    state: o.from,
    limit: o.limit,
    leaseMs: o.leaseMs,
    worker: `analyst:${o.stage}`,
  });
  const run: StageRun = { claimed: claims.length, advanced: 0, retried: 0, deadLettered: 0 };
  if (claims.length === 0) return run;

  const { rows } = await pool.query<SignalCase>(
    'select signal_id, text, excerpt, link from atlas.signals where signal_id = any($1)',
    [claims.map((c) => c.signalId)],
  );
  const byId = new Map(rows.map((r) => [r.signal_id, r]));

  for (const claim of claims) {
    const signal = byId.get(claim.signalId);
    // signals.text carries the headline ("text = title" since #440) and
    // excerpt the summary; together with the link that is Jev's whole view
    // of the signal.
    const inputCase = {
      signal_id: claim.signalId,
      title: signal?.text ?? null,
      text: signal?.excerpt ?? null,
      link: signal?.link ?? null,
    };
    const outcome = await callJev(pool, o.jev, {
      signalId: claim.signalId,
      stage: o.stage,
      inputCase,
      timeoutMs: o.timeoutMs,
    });

    if (outcome.status === 'success') {
      if (await completeClaim(pool, claim, { to: o.to })) run.advanced += 1;
    } else {
      const result = await failClaim(pool, claim, {
        error: outcome.error,
        backoffMs: o.backoffMs,
      });
      if (result === 'retry') run.retried += 1;
      if (result === 'dead_lettered') run.deadLettered += 1;
    }
  }
  return run;
}