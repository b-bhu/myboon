/**
 * Thin typed wrappers around the atlas queue functions for whoever consumes
 * the signal queue (the functions are defined by
 * supabase/migrations/20261025100100_atlas_queues.sql — this package runs no
 * SQL migrations of its own). Every wrapper is one
 * db.schema('atlas').rpc(...) call and throws a `scout-news:` Error naming
 * the rpc and the PostgREST message — never a URL or key — when it fails.
 *
 * PostgREST delivers the function results as JSON: bigint id and attempts
 * arrive as numbers, uuid and text as strings, timestamptz as an ISO
 * datetime string.
 */
import type { AtlasClaimedRow, AtlasDb, AtlasFailOutcome, AtlasRpcData } from './store.js';

export const CLAIM_LIMIT = 10;
export const LEASE = '5 minutes';
/** Heartbeat cadence for consumers; must stay well inside LEASE. */
export const HEARTBEAT_MS = 60000;

/** Consumer-facing aliases (same names as before the Supabase switch). */
export type ClaimedSignalRow = AtlasClaimedRow;
export type FailOutcome = AtlasFailOutcome;

/** queue_claim: the claimed rows, or [] when PostgREST answered with anything else. */
function claimedRows(data: AtlasRpcData | null): AtlasClaimedRow[] {
  return Array.isArray(data) ? data : [];
}

/** queue_fail: the function's outcome, or lost_lease when the lease is gone. */
function failOutcome(data: AtlasRpcData | null): AtlasFailOutcome {
  return data === 'retry' || data === 'dead_letter' ? data : 'lost_lease';
}

/** Claim up to `limit` ready (or lease-expired) rows and lease them to this consumer. */
export async function claim(
  db: AtlasDb,
  limit: number = CLAIM_LIMIT,
  lease: string = LEASE,
): Promise<ClaimedSignalRow[]> {
  const { data, error } = await db.schema('atlas').rpc('queue_claim', {
    p_queue: 'signal_queue',
    p_limit: limit,
    p_lease: lease,
  });
  if (error) {
    throw new Error(`scout-news: queue_claim failed: ${error.message}`);
  }
  return claimedRows(data);
}

/** Extend a lease. False when the token no longer owns the row. */
export async function heartbeat(
  db: AtlasDb,
  id: string | number,
  token: string,
  lease: string = LEASE,
): Promise<boolean> {
  const { data, error } = await db.schema('atlas').rpc('queue_heartbeat', {
    p_queue: 'signal_queue',
    p_id: id,
    p_token: token,
    p_lease: lease,
  });
  if (error) {
    throw new Error(`scout-news: queue_heartbeat failed: ${error.message}`);
  }
  return data === true;
}

/** Done: remove the queue row. False when the token no longer owns it. */
export async function complete(
  db: AtlasDb,
  id: string | number,
  token: string,
): Promise<boolean> {
  const { data, error } = await db.schema('atlas').rpc('queue_complete', {
    p_queue: 'signal_queue',
    p_id: id,
    p_token: token,
  });
  if (error) {
    throw new Error(`scout-news: queue_complete failed: ${error.message}`);
  }
  return data === true;
}

/** Failed: retry with backoff, dead-letter at max_attempts, or lost_lease. */
export async function fail(
  db: AtlasDb,
  id: string | number,
  token: string,
  error: string,
  backoff: string = '30 seconds',
): Promise<FailOutcome> {
  const { data, error: rpcError } = await db.schema('atlas').rpc('queue_fail', {
    p_queue: 'signal_queue',
    p_id: id,
    p_token: token,
    p_error: error,
    p_backoff: backoff,
  });
  if (rpcError) {
    throw new Error(`scout-news: queue_fail failed: ${rpcError.message}`);
  }
  return failOutcome(data);
}