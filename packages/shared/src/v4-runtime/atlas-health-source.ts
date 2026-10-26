/**
 * V4 health source backed by the atlas schema, scout stage only (#444).
 *
 * The runner connects as service_role. Its atlas grants come from migrations
 * 20261026011119 (scout service_role grants) and 20261026011428 (atlas.signals
 * created_at / enqueued_at column grant). What service_role may read decides
 * what this source may query:
 *
 *   atlas.signal_queue — full SELECT (id, signal_id, priority, status,
 *                        attempts, max_attempts, available_at, lease_token,
 *                        lease_expires_at, last_error, created_at)
 *   atlas.signals      — SELECT only on signal_id, source, source_id and the
 *                        dedicated columns grant (created_at, enqueued_at)
 *   atlas.dead_letter  — INSERT only: the dead-letter depth is NOT readable
 *
 * priority exists on atlas.signals only outside its SELECT grant, so signals
 * readers never select it. Every metric is a head count: no rows travel over
 * the wire, which keeps the snapshot cheap enough to run every cycle.
 *
 * Where a metric is not backed by these grants the method returns null —
 * "not readable with current grants" — without querying for it. A null is a
 * value, not an error. Any Supabase error is thrown as Error(message); the
 * snapshot turns a throw into a null field plus one "<field>: <message>"
 * entry, so the two cases stay distinguishable in the health line.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

import type { V4HealthSource, V4Stage } from './health'

const SCOUT_STAGE: V4Stage = 'scout-news'

interface CountResult {
  count: number | null
  error: { message: string } | null
}

/** The subset of a supabase head-count chain this file uses. */
interface CountQuery extends PromiseLike<CountResult> {
  eq(column: string, value: string): CountQuery
  gte(column: string, value: string): CountQuery
  lt(column: string, value: string): CountQuery
}

interface AtlasTable {
  select(columns: string, options?: { count: 'exact'; head: true }): CountQuery
}

interface AtlasSchema {
  from(table: string): AtlasTable
}

interface AtlasClient {
  schema(schema: string): AtlasSchema
}

export function createAtlasHealthSource(client: SupabaseClient): V4HealthSource {
  // Cast to the structural subset above: SupabaseClient generics only know
  // the public schema, so the atlas tables are not in its database types.
  const atlas: AtlasSchema = (client as unknown as AtlasClient).schema('atlas')

  /** Exact head count over one atlas table; never returns rows. */
  async function exactCount(
    table: string,
    columns: string,
    apply: (query: CountQuery) => CountQuery,
  ): Promise<number> {
    const { count, error } = await apply(
      atlas.from(table).select(columns, { count: 'exact', head: true }),
    )
    if (error) throw new Error(error.message)
    if (count === null || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`${table} count was unavailable`)
    }
    return count
  }

  return {
    async queueDepth(stage: V4Stage): Promise<number | null> {
      if (stage !== SCOUT_STAGE) return null
      return exactCount('signal_queue', '*', (query) => query.eq('status', 'ready'))
    },

    // signal_queue stores no claim-start timestamp: lease_expires_at says
    // when a claim dies, not when it was claimed. No claim age to read yet.
    async oldestClaimAgeMs(): Promise<number | null> {
      return null
    },

    async leaseExpiries(stage: V4Stage, sinceMs: number): Promise<number | null> {
      if (stage !== SCOUT_STAGE) return null
      const sinceIso = new Date(sinceMs).toISOString()
      // Upper bound is the read time, not the snapshot clock: leases still
      // open at query time have not expired yet.
      const nowIso = new Date().toISOString()
      return exactCount('signal_queue', '*', (query) =>
        query
          .eq('status', 'leased')
          .gte('lease_expires_at', sinceIso)
          .lt('lease_expires_at', nowIso),
      )
    },

    // INSERT-only grant on atlas.dead_letter. Never query it; the snapshot
    // reads null instead of a fabricated zero.
    async deadLetterCount(): Promise<number | null> {
      return null
    },

    // Postgres advisory locks are not visible through the PostgREST API.
    async advisoryLockHolder(): Promise<{ pid: number; since: string } | null> {
      return null
    },

    async signalsSince(stage: V4Stage, sinceMs: number): Promise<number | null> {
      if (stage !== SCOUT_STAGE) return null
      const sinceIso = new Date(sinceMs).toISOString()
      // Only the granted signal_id column is selected; created_at is readable
      // through the 20261026011428 column grant.
      return exactCount('signals', 'signal_id', (query) =>
        query.gte('created_at', sinceIso),
      )
    },
  }
}