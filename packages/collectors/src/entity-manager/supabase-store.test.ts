import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SupabaseEntityMemoryStore, __testing } from './supabase-store'
import type { EntityInput, EntityMemoryRecord, EntityRecord } from './types'

const baseEntity: EntityRecord = {
  id: 'entity-1',
  slug: 'bitcoin',
  name: 'Bitcoin',
  type: 'asset',
  aliases: ['BTC'],
  summary: 'A decentralized cryptocurrency.',
  status: 'active',
  show_in_carousel: false,
  metadata: { symbol: 'BTC' },
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
}

test('entity row normalization defaults the carousel flag to false and preserves true', () => {
  const { show_in_carousel: _flag, ...legacyRow } = baseEntity

  assert.equal(__testing.normalizeEntity(legacyRow).show_in_carousel, false)
  assert.equal(__testing.normalizeEntity({ ...legacyRow, show_in_carousel: true }).show_in_carousel, true)
  assert.match(__testing.ENTITY_SELECT, /show_in_carousel/)
})

test('createEntities uses database defaults without sending or nulling carousel selection', async () => {
  const input: EntityInput = {
    slug: 'bitcoin',
    name: 'Bitcoin',
    type: 'asset',
    aliases: ['BTC'],
    summary: 'A decentralized cryptocurrency.',
    status: 'active',
    metadata: { symbol: 'BTC' },
  }
  const db = {
    from(table: string) {
      assert.equal(table, 'entities')
      return {
        upsert(payload: EntityInput[], options: Record<string, unknown>) {
          assert.deepEqual(payload, [input])
          assert.equal(Object.hasOwn(payload[0], 'show_in_carousel'), false)
          assert.deepEqual(options, { onConflict: 'slug', defaultToNull: false })
          return {
            async select(columns: string) {
              assert.equal(columns, __testing.ENTITY_SELECT)
              return {
                data: [{ ...baseEntity, show_in_carousel: false }],
                error: null,
              }
            },
          }
        },
      }
    },
  } as unknown as SupabaseClient

  const store = new SupabaseEntityMemoryStore(db)
  const created = await store.createEntities([input])

  assert.equal(created[0].show_in_carousel, false)
})

test('updateEntity persists carousel selection changes', async () => {
  const updatePayloads: Array<Record<string, unknown>> = []
  const db = {
    from(table: string) {
      assert.equal(table, 'entities')
      return {
        update(payload: Record<string, unknown>) {
          updatePayloads.push(payload)
          return {
            eq(column: string, value: string) {
              assert.equal(column, 'id')
              assert.equal(value, baseEntity.id)
              return {
                select(columns: string) {
                  assert.equal(columns, __testing.ENTITY_SELECT)
                  return {
                    async single() {
                      return {
                        data: { ...baseEntity, ...payload },
                        error: null,
                      }
                    },
                  }
                },
              }
            },
          }
        },
      }
    },
  } as unknown as SupabaseClient

  const store = new SupabaseEntityMemoryStore(db)
  const updated = await store.updateEntity({ ...baseEntity, show_in_carousel: true })
  const removed = await store.updateEntity({ ...updated, show_in_carousel: false })

  assert.equal(updatePayloads[0]?.show_in_carousel, true)
  assert.equal(updatePayloads[1]?.show_in_carousel, false)
  assert.equal(updated.show_in_carousel, true)
  assert.equal(removed.show_in_carousel, false)
})

const baseMemory: EntityMemoryRecord = {
  id: 'memory-1',
  entity_id: 'entity-1',
  source: 'polymarket',
  source_area: 'markets',
  source_type: 'market_signal',
  source_ref_id: 'wti-60-low',
  source_research_id: 'research-1',
  memory_type: 'market_signal',
  title: 'WTI hit $60 low',
  summary: 'First observation.',
  body: null,
  event_at: '2026-07-01T00:00:00.000Z',
  observed_at: '2026-07-01T00:00:00.000Z',
  confidence: 0.7,
  evidence: [],
  mentions: [],
  metrics: {},
  context: {},
}

test('findLatestMemorySince filters by entity, memory type, and recency, ordered newest first', async () => {
  const db = {
    from(table: string) {
      assert.equal(table, 'entity_memories')
      return {
        select(columns: string) {
          assert.equal(columns, __testing.MEMORY_SELECT)
          return {
            eq(column: string, value: string) {
              if (column === 'entity_id') assert.equal(value, 'entity-1')
              if (column === 'memory_type') assert.equal(value, 'market_signal')
              return this
            },
            gte(column: string, value: string) {
              assert.equal(column, 'observed_at')
              assert.equal(value, '2026-06-30T12:00:00.000Z')
              return this
            },
            order(column: string, options: Record<string, unknown>) {
              assert.equal(column, 'observed_at')
              assert.deepEqual(options, { ascending: false })
              return this
            },
            limit(count: number) {
              assert.equal(count, 1)
              return this
            },
            async maybeSingle() {
              return { data: baseMemory, error: null }
            },
          }
        },
      }
    },
  } as unknown as SupabaseClient

  const store = new SupabaseEntityMemoryStore(db)
  const found = await store.findLatestMemorySince('entity-1', 'market_signal', '2026-06-30T12:00:00.000Z')

  assert.ok(found)
  assert.equal(found?.id, 'memory-1')
})

test('findLatestMemorySince returns null when no recent memory exists', async () => {
  const db = {
    from() {
      return {
        select() {
          return {
            eq() { return this },
            gte() { return this },
            order() { return this },
            limit() { return this },
            async maybeSingle() {
              return { data: null, error: null }
            },
          }
        },
      }
    },
  } as unknown as SupabaseClient

  const store = new SupabaseEntityMemoryStore(db)
  const found = await store.findLatestMemorySince('entity-1', 'market_signal', '2026-06-30T12:00:00.000Z')

  assert.equal(found, null)
})

test('updateMemory patches the row by id and stamps updated_at', async () => {
  const db = {
    from(table: string) {
      assert.equal(table, 'entity_memories')
      return {
        update(payload: Record<string, unknown>) {
          assert.equal(payload.summary, 'Second, later observation.')
          assert.ok(typeof payload.updated_at === 'string')
          return {
            eq(column: string, value: string) {
              assert.equal(column, 'id')
              assert.equal(value, 'memory-1')
              return {
                select(columns: string) {
                  assert.equal(columns, __testing.MEMORY_SELECT)
                  return {
                    async single() {
                      return { data: { ...baseMemory, summary: payload.summary }, error: null }
                    },
                  }
                },
              }
            },
          }
        },
      }
    },
  } as unknown as SupabaseClient

  const store = new SupabaseEntityMemoryStore(db)
  const updated = await store.updateMemory('memory-1', {
    observed_at: baseMemory.observed_at,
    event_at: baseMemory.event_at,
    summary: 'Second, later observation.',
    body: null,
    confidence: 0.7,
    evidence: [],
    mentions: [],
    metrics: {},
    context: {},
  })

  assert.equal(updated.summary, 'Second, later observation.')
})
