/**
 * #478: per-signal state rows and claim handling, backed by the atlas.signal_*
 * SQL functions. Every transition is a claim-token check inside the database,
 * so a worker that lost or outlived its lease cannot finish foreign work.
 */
import type { Pool } from 'pg';


/** A live claim as returned by atlas.signal_claim. */
export type Claim = { signalId: string; token: string; state: string; attempts: number };

/** Admit signals with no state row yet as 'received'. Returns how many were admitted. */
export async function admitSignals(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('select atlas.signal_admit() as n');
  return rows[0]?.n ?? 0;
}

/**
 * Claim up to o.limit signals in o.state for o.worker. Lease and backoff times
 * arrive as milliseconds and are converted to intervals explicitly, because
 * make_interval() only takes whole seconds and short leases (the tests use
 * 100ms) would otherwise round to zero. The terminal states ('dead_lettered',
 * 'deleted') are never claimable and raise from SQL.
 */
export async function claimSignals(
  pool: Pool,
  o: { state: string; limit: number; leaseMs: number; worker: string },
): Promise<Claim[]> {
  const { rows } = await pool.query<{
    signal_id: string;
    claim_token: string;
    state: string;
    attempts: string;
  }>(
    `select signal_id, claim_token, state, attempts
       from atlas.signal_claim($1, $2, ($3 || ' milliseconds')::interval, $4)`,
    [o.state, o.limit, o.leaseMs, o.worker],
  );
  return rows.map((r) => ({
    signalId: r.signal_id,
    token: r.claim_token,
    state: r.state,
    attempts: Number(r.attempts),
  }));
}

/**
 * Move a claimed signal to o.to ('analysed', 'parked', 'discarded', ...). False
 * when the claim no longer owns the row (swept, expired or advanced elsewhere);
 * raises from SQL ('illegal transition from -> to') when o.to is not allowed
 * from the row's current state. An advance starts the next stage with a full
 * retry budget (attempts reset, available_at = now()).
 *
 * The runner only needs Pool's query surface, so a checked-out PoolClient
 * works too -- #479 finishes the decision insert and the advance inside one
 * transaction on the same client.
 */
export async function completeClaim(
  db: Pick<Pool, 'query'>,
  claim: Claim,
  o: { to: string; parkReason?: string },
): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    'select atlas.signal_advance($1, $2::uuid, $3, $4) as ok',
    [claim.signalId, claim.token, o.to, o.parkReason ?? null],
  );
  return Boolean(rows[0]?.ok);
}

/** Retry with backoff or dead-letter on the attempt cap; 'lost_claim' when the claim is gone. */
export async function failClaim(
  pool: Pool,
  claim: Claim,
  o: { error: string; backoffMs: number },
): Promise<'retry' | 'dead_lettered' | 'lost_claim'> {
  const { rows } = await pool.query<{ outcome: string }>(
    `select atlas.signal_fail($1, $2::uuid, $3, ($4 || ' milliseconds')::interval) as outcome`,
    [claim.signalId, claim.token, o.error, o.backoffMs],
  );
  const outcome = rows[0]?.outcome;
  if (outcome !== 'retry' && outcome !== 'dead_lettered' && outcome !== 'lost_claim') {
    throw new Error(`unexpected signal_fail outcome: ${String(outcome)}`);
  }
  return outcome;
}

/** Clear expired claims (crashed workers) so their signals become claimable again; claims whose attempt cap is reached are dead-lettered (row + one atlas.dead_letter entry). */
export async function sweepExpiredClaims(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('select atlas.signal_sweep() as n');
  return rows[0]?.n ?? 0;
}