import assert from 'node:assert/strict'
import test from 'node:test'

import type { SupabaseClient } from '@supabase/supabase-js'

import { createAtlasHealthSource } from './atlas-health-source'
import type { V4Stage } from './health'

const SCOUT: V4Stage = 'scout-news'
const OTHER_STAGE: V4Stage = 'analyst'
const SINCE_MS = Date.parse('2026-10-25T12:00:00.000Z') - 3_600_000
const EXPECTED_SINCE = new Date(SINCE_MS).toISOString()

type RecordedFilter = { op: 'eq' | 'gte' | 'lt'; column: string; value: string }

/** One atlas query: the chain calls recorded as they are built. */
type RecordedQuery = {
  schema: string
  table: string
  select: string
  countOptions: { count: string; head: boolean } | null
  filters: RecordedFilter[]
}

type FakeResult = { count: number | null; error: { message: string } | null }

/**
 * Hand-written fake atlas client: records the schema/table/select/filter
 * calls the source makes and resolves every chain with the same result. No
 * access beyond what the factory records exists, so "no query" is assertable
 * as an empty record list.
 */
function fakeAtlasClient(result: FakeResult): { client: SupabaseClient; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = []
  const client = {
    schema(schema: string) {
      return {
        from(table: string) {
          const record: RecordedQuery = { schema, table, select: '', countOptions: null, filters: [] }
          queries.push(record)
          const chain = {
            select(columns: string, options?: { count: string; head: boolean }) {
              record.select = columns
              record.countOptions = options ?? null
              return chain
            },
            eq(column: string, value: string) {
              record.filters.push({ op: 'eq', column, value })
              return chain
            },
            gte(column: string, value: string) {
              record.filters.push({ op: 'gte', column, value })
              return chain
            },
            lt(column: string, value: string) {
              record.filters.push({ op: 'lt', column, value })
              return chain
            },
            then<TResult1 = FakeResult, TResult2 = never>(
              onFulfilled?: ((value: FakeResult) => TResult1 | PromiseLike<TResult1>) | null | undefined,
              onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined,
            ): PromiseLike<TResult1 | TResult2> {
              return Promise.resolve(result).then(onFulfilled, onRejected)
            },
          }
          return chain
        },
      }
    },
  }
  return { client: client as unknown as SupabaseClient, queries }
}

function errorResult(message: string): FakeResult {
  return { count: null, error: { message } }
}

test('queueDepth counts ready signal_queue rows in the atlas schema', async () => {
  const { client, queries } = fakeAtlasClient({ count: 5, error: null })
  const source = createAtlasHealthSource(client)

  const depth = await source.queueDepth(SCOUT)

  assert.equal(depth, 5)
  assert.equal(queries.length, 1)
  assert.deepEqual(queries[0], {
    schema: 'atlas',
    table: 'signal_queue',
    select: '*',
    countOptions: { count: 'exact', head: true },
    filters: [{ op: 'eq', column: 'status', value: 'ready' }],
  })
})

test('signalsSince counts windowed atlas.signals rows selecting only the granted signal_id column', async () => {
  const { client, queries } = fakeAtlasClient({ count: 11, error: null })
  const source = createAtlasHealthSource(client)

  const count = await source.signalsSince(SCOUT, SINCE_MS)

  assert.equal(count, 11)
  assert.equal(queries.length, 1)
  assert.deepEqual(queries[0], {
    schema: 'atlas',
    table: 'signals',
    select: 'signal_id',
    countOptions: { count: 'exact', head: true },
    filters: [{ op: 'gte', column: 'created_at', value: EXPECTED_SINCE }],
  })
})

test('leaseExpiries counts leases expired between since and the read time', async () => {
  const startOfTest = Date.now()
  const { client, queries } = fakeAtlasClient({ count: 2, error: null })
  const source = createAtlasHealthSource(client)

  const expiries = await source.leaseExpiries(SCOUT, SINCE_MS)

  assert.equal(expiries, 2)
  assert.equal(queries.length, 1)
  assert.deepEqual(queries[0]?.schema, 'atlas')
  assert.deepEqual(queries[0]?.table, 'signal_queue')
  assert.deepEqual(queries[0]?.select, '*')
  assert.deepEqual(queries[0]?.countOptions, { count: 'exact', head: true })
  const filters = queries[0]?.filters ?? []
  assert.deepEqual(filters.slice(0, 2), [
    { op: 'eq', column: 'status', value: 'leased' },
    { op: 'gte', column: 'lease_expires_at', value: EXPECTED_SINCE },
  ])
  // The upper bound comes from the wall clock at read time; only its shape
  // and bounds are assertable.
  const upperBound = filters[2]
  assert.equal(upperBound?.op, 'lt')
  const upperMs = Date.parse(upperBound?.value ?? '')
  assert.ok(Number.isFinite(upperMs), 'the lease upper bound is a parseable timestamp')
  assert.ok(upperMs >= Date.parse(EXPECTED_SINCE), 'the window is not inverted')
  assert.ok(upperMs <= startOfTest + 60_000, 'the upper bound is the read time, not a wild future date')
})

test('deadLetterCount and advisoryLockHolder are null without querying the database', async () => {
  const { client, queries } = fakeAtlasClient({ count: 1, error: null })
  const source = createAtlasHealthSource(client)

  assert.equal(await source.deadLetterCount(SCOUT), null)
  assert.equal(await source.advisoryLockHolder(), null)
  // INSERT-only grant on dead_letter; no PostgREST view on advisory locks.
  assert.equal(queries.length, 0)
})

test('oldestClaimAgeMs is null for every stage: no claim-start column exists', async () => {
  const { client, queries } = fakeAtlasClient({ count: 1, error: null })
  const source = createAtlasHealthSource(client)

  assert.equal(await source.oldestClaimAgeMs(SCOUT), null)
  assert.equal(queries.length, 0)
})

test('a supabase error propagates as a thrown Error, not as a null value', async () => {
  const { client, queries } = fakeAtlasClient(errorResult('permission denied for table signal_queue'))
  const source = createAtlasHealthSource(client)

  await assert.rejects(source.queueDepth(SCOUT), { message: 'permission denied for table signal_queue' })
  await assert.rejects(source.signalsSince(SCOUT, SINCE_MS), { message: 'permission denied for table signal_queue' })
  // The null-bearing fields stay null even when the granted reads fail.
  assert.equal(await source.deadLetterCount(SCOUT), null)
  assert.equal(queries.length, 2)
})

test('a head count without a count number fails loudly instead of reporting zero', async () => {
  const { client } = fakeAtlasClient({ count: null, error: null })
  const source = createAtlasHealthSource(client)

  await assert.rejects(source.queueDepth(SCOUT), { message: 'signal_queue count was unavailable' })
})

test('every metric is null for a stage other than scout-news, without touching atlas', async () => {
  const { client, queries } = fakeAtlasClient({ count: 1, error: null })
  const source = createAtlasHealthSource(client)

  assert.equal(await source.queueDepth(OTHER_STAGE), null)
  assert.equal(await source.oldestClaimAgeMs(OTHER_STAGE), null)
  assert.equal(await source.leaseExpiries(OTHER_STAGE, SINCE_MS), null)
  assert.equal(await source.signalsSince(OTHER_STAGE, SINCE_MS), null)
  assert.equal(await source.deadLetterCount(OTHER_STAGE), null)
  assert.equal(await source.advisoryLockHolder(), null)
  assert.equal(queries.length, 0)
})