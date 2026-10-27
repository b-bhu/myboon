/**
 * V4 health source backed by the atlas schema, scout stage only (#444, #478).
 *
 * The runner connects as service_role. Its atlas grants come from migrations
 * 20261026011119 (scout service_role grants) and 20261027120000 (signal
 * status column grants). What service_role may read decides what this source
 * may query:
 *
 *   atlas.signals — SELECT only on signal_id, source, source_id (20261026011119),
 *                   created_at (20261026011428) and the status/claim columns
 *                   (status, parked_reason, claim_token, claim_expires_at,
 *                   claimed_by, attempts, last_error, next_attempt_at, text,
 *                   excerpt, link, occurred_at). priority is NOT readable, so
 *                   signals readers never select it.
 *
 * The signal_queue table is gone (#478): the scout's insert defaults a new
 * signal to status 'received', unclaimed and due, so the queue depth is the
 * count of received rows still waiting for a claim. Every metric is a head
 * count: no rows travel over the wire, which keeps the snapshot cheap enough
 * to run every cycle.
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
  is(column: string, value: null): CountQuery
  not(column: string, op: 'is', value: null): CountQuery
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
    // queueDepth: received signals still waiting for a claim. The claimable
    // predicate on the DB is status = 'received' and claim_token is null and
    // next_attempt_at <= now(); the head-count API cannot express the due
    // time, so any row with a future next_attempt_at (backing off) is
    // included in the depth until it is claimed again.
    async queueDepth(stage: V4Stage): Promise<number | null> {
      if (stage !== SCOUT_STAGE) return null
      return exactCount('signals', 'status,claim_token', (query) =>
        query.eq('status', 'received').is('claim_token', null),
      )
    },

    // Received rows currently claimed (claim_token set). Leases wait inside
    // the claim expiry; without a claim-start timestamp the age and a plain
    // in-flight read are not readable, so only the windowed expiry count
    // below reports claim activity.
    async oldestClaimAgeMs(): Promise<number | null> {
      return null
    },

    async leaseExpiries(stage: V4Stage, sinceMs: number): Promise<number | null> {
      if (stage !== SCOUT_STAGE) return null
      const sinceIso = new Date(sinceMs).toISOString()
      // Upper bound is the read time, not the snapshot clock: claims whose
      // claim_expires_at passed the read time count as expired work waiting
      // to be retaken.
      const nowIso = new Date().toISOString()
      return exactCount('signals', 'status,claim_token,claim_expires_at', (query) =>
        query
          .eq('status', 'received')
          .not('claim_token', 'is', null)
          .gte('claim_expires_at', sinceIso)
          .lt('claim_expires_at', nowIso),
      )
    },

    // 'dead' is where failed attempts land (#478), and status is now
    // readable: the dead-letter depth is the count of dead signals.
    async deadLetterCount(stage: V4Stage): Promise<number | null> {
      if (stage !== SCOUT_STAGE) return null
      return exactCount('signals', 'status', (query) => query.eq('status', 'dead'))
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