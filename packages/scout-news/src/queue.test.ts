/**
 * The queue wrappers against a fake atlas client that records the exact rpc
 * calls: function names, argument names, and the error paths. The DB-side
 * behavior (lease retake, dead-lettering) is covered by scout.db.test.ts
 * against a real Postgres (PostgREST is not run locally).
 */
import { describe, expect, it } from 'vitest';

import { claim, CLAIM_LIMIT, complete, fail, heartbeat, LEASE } from './queue.js';
import type { AtlasClaimedRow, AtlasDb, AtlasDbError, AtlasDbResult, AtlasRpcData } from './store.js';

type RpcCall = { fn: string; args: Record<string, unknown> };

type FakeOptions = {
  /** Resolved rpc data for every call. */
  data?: AtlasRpcData;
  /** Postgrest error every rpc call reports. */
  error?: AtlasDbError;
};

/** A fake AtlasDb whose schema('atlas').rpc records (fn, args) and resolves the configured result. */
function fakeRpcDb(options: FakeOptions = {}) {
  const calls: RpcCall[] = [];
  const result: AtlasDbResult<AtlasRpcData> = options.error
    ? { data: null, error: options.error }
    : { data: options.data ?? null, error: null };

  const db: AtlasDb = {
    schema(schemaName: string) {
      if (schemaName !== 'atlas') {
        throw new Error(`unexpected schema: ${schemaName}`);
      }
      return {
        from() {
          throw new Error('queue wrappers must not touch tables directly');
        },
        rpc(fn: string, args: Record<string, unknown>) {
          calls.push({ fn, args: { ...args } });
          return Promise.resolve(result);
        },
      };
    },
  }
  return { db, calls };
}

const claimedRow: AtlasClaimedRow = {
  id: 42,
  ref_id: 'a'.repeat(64),
  attempts: 1,
  lease_token: '00000000-0000-0000-0000-000000000001',
  lease_expires_at: '2026-10-26T09:05:00.000Z',
};

describe('queue wrappers (fake atlas client)', () => {
  it('claims with the default limit and lease via queue_claim', async () => {
    const { db, calls } = fakeRpcDb({ data: [claimedRow] });

    await expect(claim(db)).resolves.toEqual([claimedRow]);
    expect(calls).toEqual([
      { fn: 'queue_claim', args: { p_queue: 'signal_queue', p_limit: 10, p_lease: '5 minutes' } },
    ]);
    expect(calls[0]?.args.p_limit).toBe(CLAIM_LIMIT);
    expect(calls[0]?.args.p_lease).toBe(LEASE);
  });

  it('claims with the given limit and lease and returns [] for an empty claim', async () => {
    const { db, calls } = fakeRpcDb({ data: [] });

    await expect(claim(db, 3, '2 minutes')).resolves.toEqual([]);
    expect(calls).toEqual([
      { fn: 'queue_claim', args: { p_queue: 'signal_queue', p_limit: 3, p_lease: '2 minutes' } },
    ]);
  });

  it('heartbeats via queue_heartbeat and treats a null result as a lost lease', async () => {
    const owned = fakeRpcDb({ data: true });
    await expect(heartbeat(owned.db, claimedRow.id, claimedRow.lease_token, '1 minute')).resolves.toBe(true);
    expect(owned.calls).toEqual([
      {
        fn: 'queue_heartbeat',
        args: { p_queue: 'signal_queue', p_id: 42, p_token: claimedRow.lease_token, p_lease: '1 minute' },
      },
    ]);

    await expect(heartbeat(fakeRpcDb().db, claimedRow.id, claimedRow.lease_token, '1 minute')).resolves.toBe(false);
  });

  it('completes via queue_complete and treats a null result as a lost lease', async () => {
    const owned = fakeRpcDb({ data: true });
    await expect(complete(owned.db, claimedRow.id, claimedRow.lease_token)).resolves.toBe(true);
    expect(owned.calls).toEqual([
      { fn: 'queue_complete', args: { p_queue: 'signal_queue', p_id: 42, p_token: claimedRow.lease_token } },
    ]);

    await expect(complete(fakeRpcDb().db, claimedRow.id, claimedRow.lease_token)).resolves.toBe(false);
  });

  it('fails via queue_fail with the error and backoff, reporting the outcome', async () => {
    const retry = fakeRpcDb({ data: 'retry' });
    await expect(fail(retry.db, claimedRow.id, claimedRow.lease_token, 'worker exploded', '0 seconds')).resolves.toBe('retry');
    expect(retry.calls).toEqual([
      {
        fn: 'queue_fail',
        args: { p_queue: 'signal_queue', p_id: 42, p_token: claimedRow.lease_token, p_error: 'worker exploded', p_backoff: '0 seconds' },
      },
    ]);

    const deadLetter = fakeRpcDb({ data: 'dead_letter' });
    await expect(fail(deadLetter.db, claimedRow.id, claimedRow.lease_token, 'worker exploded')).resolves.toBe('dead_letter');
    expect(deadLetter.calls[0]?.args.p_backoff).toBe('30 seconds');
  });

  it('treats a null queue_fail result as lost_lease', async () => {
    const { db } = fakeRpcDb();
    await expect(fail(db, claimedRow.id, claimedRow.lease_token, 'worker exploded')).resolves.toBe('lost_lease');
  });

  it.each([
    { fn: 'queue_claim', call: (db: AtlasDb) => claim(db) },
    { fn: 'queue_heartbeat', call: (db: AtlasDb) => heartbeat(db, 42, 't') },
    { fn: 'queue_complete', call: (db: AtlasDb) => complete(db, 42, 't') },
    { fn: 'queue_fail', call: (db: AtlasDb) => fail(db, 42, 't', 'boom') },
  ])('throws a scout-news message when $fn errors', async ({ fn, call }) => {
    const { db } = fakeRpcDb({ error: { message: 'permission denied for function' } });

    await expect(call(db)).rejects.toThrow(`scout-news: ${fn} failed: permission denied for function`);
  });
});