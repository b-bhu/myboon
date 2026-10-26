/**
 * Thin typed wrappers around the existing atlas queue functions (they are
 * defined by supabase/migrations/20261025100100_atlas_queues.sql — this
 * package runs no SQL migrations of its own).
 *
 * Bigint columns (id, attempts) arrive from node-postgres as strings, so those
 * row fields stay strings here; uuid and text arrive as strings, timestamptz
 * as Date.
 */
import type { Queryable } from './store.js';

export const CLAIM_LIMIT = 10;
export const LEASE = '5 minutes';
/** Heartbeat cadence for consumers; must stay well inside LEASE. */
export const HEARTBEAT_MS = 60000;

export const SQL_CLAIM = `select * from atlas.queue_claim('signal_queue', $1, $2::interval)`;
export const SQL_HEARTBEAT = `select atlas.queue_heartbeat('signal_queue', $1, $2, $3::interval)`;
export const SQL_COMPLETE = `select atlas.queue_complete('signal_queue', $1, $2)`;
export const SQL_FAIL = `select atlas.queue_fail('signal_queue', $1, $2, $3, $4::interval)`;

/** One claimed row of the signal queue (ref_id is the signal_id). */
export type ClaimedSignalRow = {
  id: string;
  ref_id: string;
  attempts: string;
  lease_token: string;
  lease_expires_at: Date;
};

export type FailOutcome = 'retry' | 'dead_letter' | 'lost_lease';

/** Claim up to `limit` ready (or lease-expired) rows and lease them to this client. */
export async function claim(
  client: Queryable,
  limit: number = CLAIM_LIMIT,
  lease: string = LEASE,
): Promise<ClaimedSignalRow[]> {
  const result = await client.query<ClaimedSignalRow>(SQL_CLAIM, [limit, lease]);
  return result.rows;
}

/** Extend a lease. False when the token no longer owns the row. */
export async function heartbeat(
  client: Queryable,
  id: string | number,
  token: string,
  lease: string = LEASE,
): Promise<boolean> {
  const result = await client.query<{ queue_heartbeat: boolean }>(SQL_HEARTBEAT, [id, token, lease]);
  return result.rows[0]?.queue_heartbeat ?? false;
}

/** Done: remove the queue row. False when the token no longer owns it. */
export async function complete(
  client: Queryable,
  id: string | number,
  token: string,
): Promise<boolean> {
  const result = await client.query<{ queue_complete: boolean }>(SQL_COMPLETE, [id, token]);
  return result.rows[0]?.queue_complete ?? false;
}

/** Failed: retry with backoff, dead-letter at max_attempts, or lost_lease. */
export async function fail(
  client: Queryable,
  id: string | number,
  token: string,
  error: string,
  backoff: string = '30 seconds',
): Promise<FailOutcome> {
  const result = await client.query<{ queue_fail: FailOutcome }>(SQL_FAIL, [id, token, error, backoff]);
  const outcome = result.rows[0]?.queue_fail;
  return outcome ?? 'lost_lease';
}