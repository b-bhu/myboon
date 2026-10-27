/**
 * Signal claim state on atlas.signals (#478), driven by the SQL functions
 * created by supabase/migrations/20261027120000_atlas_signal_status.sql:
 *
 *   claimNext   -> atlas.signal_claim(p_lease interval, p_worker text, p_max_attempts integer)
 *   finishClaim -> atlas.signal_finish(p_signal_id, p_token, p_status,
 *                                      p_parked_reason, p_decision jsonb)
 *   failClaim   -> atlas.signal_fail(p_signal_id, p_token, p_error,
 *                                    p_backoff interval, p_max_attempts integer)
 *
 * Every call is one committed statement and clears the claim, so a crash or a
 * lost race is fenced by the token: a second worker re-claims only after
 * claim_expires_at, and a stale finish or fail is refused. Durations go to the
 * interval parameters as `(<ms> || ' milliseconds')::interval` with the number
 * passed as an untyped parameter.
 */
import type { Pool } from 'pg';

/** The database slice these functions need; a Pool satisfies it. */
export type Db = Pick<Pool, 'query'>;

/** One live claim: the returned token must be handed back to finish or fail. */
export type Claim = { signalId: string; token: string; attempts: number };

/** maxAttempts: an expired claim at or above it becomes dead instead of being handed out. Default 5. */
export type ClaimNextOptions = { leaseMs: number; worker: string; maxAttempts?: number };
export const DEFAULT_MAX_ATTEMPTS = 5;

/** The due received signal with claims first by next_attempt_at, or null when nothing is due. */
export async function claimNext(db: Db, o: ClaimNextOptions): Promise<Claim | null> {
  const { rows } = await db.query<{ signal_id: string; claim_token: string; attempts: number }>(
    `select signal_id, claim_token, attempts
       from atlas.signal_claim(($1 || ' milliseconds')::interval, $2, $3)`,
    [o.leaseMs, o.worker, o.maxAttempts ?? DEFAULT_MAX_ATTEMPTS],
  );
  const row = rows[0];
  return row ? { signalId: row.signal_id, token: row.claim_token, attempts: row.attempts } : null;
}

export type FinishOptions = {
  status: 'analysed' | 'parked' | 'written' | 'deleted';
  /** Required for parked; the finished signal's own claim stays clear otherwise. */
  parkedReason?: string;
  /** When set, inserted into atlas.decisions (at most one row per signal). */
  decision?: Record<string, unknown>;
};

/** Finish a claimed signal. False when the token no longer owns it. */
export async function finishClaim(db: Db, claim: Claim, o: FinishOptions): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    `select atlas.signal_finish($1, $2, $3, $4, $5) as ok`,
    [claim.signalId, claim.token, o.status, o.parkedReason ?? null, o.decision ?? null],
  );
  return rows[0]?.ok === true;
}

export type FailOptions = { error: string; backoffMs: number; maxAttempts: number };

/** Record a failed attempt: retry with backoff, dead at the cap, or lost claim. */
export async function failClaim(db: Db, claim: Claim, o: FailOptions): Promise<'retry' | 'dead' | 'lost_claim'> {
  const { rows } = await db.query<{ outcome: string }>(
    `select atlas.signal_fail($1, $2, $3, ($4 || ' milliseconds')::interval, $5) as outcome`,
    [claim.signalId, claim.token, o.error, o.backoffMs, o.maxAttempts],
  );
  const outcome = rows[0]?.outcome;
  return outcome === 'retry' || outcome === 'dead' || outcome === 'lost_claim' ? outcome : 'lost_claim';
}