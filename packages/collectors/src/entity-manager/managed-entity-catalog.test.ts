import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  MANAGED_ENTITY_LOOKUP_MAX,
  fetchActiveManagedEntities,
  fetchManagedEntities,
} from './managed-entity-catalog'
import type { ManagedEntityRow } from './managed-entity-catalog'

const NOW = '2026-10-18T09:00:00.000Z'

function uids(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`)
}

function managedRow(index: number, overrides: Partial<ManagedEntityRow> = {}): ManagedEntityRow {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    slug: `slug-${index}`,
    name: `Name ${index}`,
    type: 'asset',
    aliases: [`alias-${index}`],
    summary: `Summary ${index}`,
    status: 'active',
    show_in_carousel: false,
    metadata: { region: 'us' },
    created_at: NOW,
    updated_at: NOW,
    catalog_entity_id: null,
    ...overrides,
  }
}

function database(
  rows: ManagedEntityRow[],
  overrides: { data?: unknown, error?: { message: string } } = {},
): { db: SupabaseClient, calls: string[][] } {
  const calls: string[][] = []
  const db = {
    async rpc(name: string, args: Record<string, unknown>) {
      assert.equal(name, 'read_managed_entities_v1')
      const chunk = args.p_entity_ids as string[]
      calls.push(chunk)
      if (overrides.error) return { data: null, error: overrides.error }
      if (overrides.data !== undefined) return { data: overrides.data, error: null }
      return {
        data: rows.filter((row) => chunk.includes(row.id)),
        error: null,
      }
    },
  } as unknown as SupabaseClient
  return { db, calls }
}

test('managed entity lookups chunk ids at the rpc bound and dedupe', async () => {
  const ids = uids(250)
  const rows = ids.map((_, index) => managedRow(index + 1))
  const { db, calls } = database(rows)

  const fetched = await fetchManagedEntities(db, ids)

  assert.deepEqual(calls, [ids.slice(0, 100), ids.slice(100, 200), ids.slice(200)])
  assert.deepEqual(fetched.map((row) => row.id), ids)
  assert.equal(calls.every((chunk) => chunk.length <= MANAGED_ENTITY_LOOKUP_MAX), true)

  const duplicated = await fetchManagedEntities(db, [...ids.slice(0, 100), ...ids.slice(0, 100)])

  assert.deepEqual(duplicated.map((row) => row.id), ids.slice(0, 100))
  assert.equal(calls[3]?.length, 100)
})

test('managed entity lookups skip the rpc for an empty id list', async () => {
  const { db, calls } = database([])

  assert.deepEqual(await fetchManagedEntities(db, []), [])
  assert.deepEqual(calls, [])
})

test('managed entity lookups fail closed on an rpc error', async () => {
  const { db } = database([], { error: { message: 'temporary outage' } })

  await assert.rejects(
    fetchManagedEntities(db, [uids(1)[0]!]),
    (error: unknown) => error instanceof Error && error.message === 'managed entity lookup failed: temporary outage',
  )
})

test('managed entity lookups reject results missing required string fields', async () => {
  const cases: unknown[] = [
    null,
    ['not-an-object'],
    [{ id: 'id-1', slug: 's', name: 'n', type: 't' }],
    [{ id: 'id-1', slug: 7, name: 'n', type: 't', status: 'active' }],
  ]

  for (const data of cases) {
    const { db } = database([], { data })
    await assert.rejects(
      fetchManagedEntities(db, [uids(1)[0]!]),
      (error: unknown) => error instanceof Error && error.message === 'managed entity lookup returned an invalid result',
    )
  }
})

test('active managed entity lookups keep only active rows', async () => {
  const active = managedRow(1)
  const review = managedRow(2, { status: 'review' })
  const { db, calls } = database([active, review])

  const rows = await fetchActiveManagedEntities(db, [active.id, review.id])

  assert.deepEqual(calls, [[active.id, review.id]])
  assert.deepEqual(rows.map((row) => row.id), [active.id])
})