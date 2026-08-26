import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { EntityKnowledgeRow } from './entity-knowledge-query'
import {
  SupabaseEntityKnowledgeQueryPort,
  __supabaseEntityKnowledgeReaderTesting,
} from './supabase-entity-knowledge-reader'

class RecordingBuilder implements PromiseLike<{ data: EntityKnowledgeRow[], error: null }> {
  readonly calls: Array<[string, ...unknown[]]> = []

  constructor(private readonly rows: EntityKnowledgeRow[]) {}

  eq(column: string, value: string): this { this.calls.push(['eq', column, value]); return this }
  neq(column: string, value: string): this { this.calls.push(['neq', column, value]); return this }
  in(column: string, values: readonly string[]): this { this.calls.push(['in', column, values]); return this }
  gte(column: string, value: string): this { this.calls.push(['gte', column, value]); return this }
  or(filters: string): this { this.calls.push(['or', filters]); return this }
  order(column: string, options: { ascending: boolean }): this { this.calls.push(['order', column, options]); return this }
  limit(limit: number): this { this.calls.push(['limit', limit]); return this }
  not(column: string, operator: string, value: unknown): this { this.calls.push(['not', column, operator, value]); return this }
  then<TResult1 = { data: EntityKnowledgeRow[], error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: EntityKnowledgeRow[], error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    _onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({ data: this.rows, error: null }).then(onfulfilled ?? undefined)
  }
}

class CountBuilder implements PromiseLike<{ count: number, error: null }> {
  readonly calls: Array<[string, ...unknown[]]> = []
  constructor(private readonly count: number) {}
  eq(column: string, value: string): this { this.calls.push(['eq', column, value]); return this }
  neq(column: string, value: string): this { this.calls.push(['neq', column, value]); return this }
  not(column: string, operator: string, value: unknown): this { this.calls.push(['not', column, operator, value]); return this }
  then<TResult1 = { count: number, error: null }, TResult2 = never>(
    onfulfilled?: ((value: { count: number, error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    _onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({ count: this.count, error: null }).then(onfulfilled ?? undefined)
  }
}

test('Supabase query port uses only entity_memories with deterministic keyset ordering', async () => {
  const builder = new RecordingBuilder([])
  const db = {
    from(table: string) {
      assert.equal(table, 'entity_memories')
      return {
        select(columns: string) {
          assert.equal(columns, __supabaseEntityKnowledgeReaderTesting.ENTITY_KNOWLEDGE_SELECT)
          return builder
        },
      }
    },
  } as unknown as SupabaseClient

  const port = new SupabaseEntityKnowledgeQueryPort(db)
  await port.queryMemories({
    order: 'observed-desc',
    entityId: 'entity-1',
    since: '2026-08-26T10:00:00.000Z',
    memoryTypes: ['news_event'],
    priorityClasses: ['P0', 'P1'],
    after: { at: '2026-08-26T12:00:00.000Z', id: 'memory-z' },
    limit: 11,
  })

  assert.deepEqual(builder.calls, [
    ['eq', 'entity_id', 'entity-1'],
    ['gte', 'observed_at', '2026-08-26T10:00:00.000Z'],
    ['in', 'memory_type', ['news_event']],
    ['in', 'context->>priority_class', ['P0', 'P1']],
    ['or', 'observed_at.lt.2026-08-26T12:00:00.000Z,and(observed_at.eq.2026-08-26T12:00:00.000Z,id.lt.memory-z)'],
    ['order', 'observed_at', { ascending: false }],
    ['order', 'id', { ascending: false }],
    ['limit', 11],
  ])
})

test('Supabase change query orders updated_at and id ascending after its cursor', async () => {
  const builder = new RecordingBuilder([])
  const db = {
    from() {
      return { select: () => builder }
    },
  } as unknown as SupabaseClient

  await new SupabaseEntityKnowledgeQueryPort(db).queryMemories({
    order: 'updated-asc',
    after: { at: '2026-08-26T12:00:00.000Z', id: 'memory-a' },
    limit: 6,
  })

  assert.deepEqual(builder.calls, [
    ['or', 'updated_at.gt.2026-08-26T12:00:00.000Z,and(updated_at.eq.2026-08-26T12:00:00.000Z,id.gt.memory-a)'],
    ['order', 'updated_at', { ascending: true }],
    ['order', 'id', { ascending: true }],
    ['limit', 6],
  ])
})

test('Supabase exact hydration filters by bounded IDs and orders deterministically', async () => {
  const builder = new RecordingBuilder([])
  const db = {
    from() {
      return { select: () => builder }
    },
  } as unknown as SupabaseClient

  await new SupabaseEntityKnowledgeQueryPort(db).queryMemories({
    order: 'id-asc',
    memoryIds: ['memory-b', 'memory-a'],
    limit: 2,
  })

  assert.deepEqual(builder.calls, [
    ['in', 'id', ['memory-b', 'memory-a']],
    ['order', 'id', { ascending: true }],
    ['limit', 2],
  ])
})

test('Supabase event pages use event-time keysets and an exact unscoped count', async () => {
  const rows = new RecordingBuilder([])
  const count = new CountBuilder(7)
  const db = {
    from(table: string) {
      assert.equal(table, 'entity_memories')
      return {
        select(_columns: string, options?: { count: string, head: boolean }) {
          return options ? count : rows
        },
      }
    },
  } as unknown as SupabaseClient

  const result = await new SupabaseEntityKnowledgeQueryPort(db).queryMemoryEvents({
    entityId: 'entity-1',
    after: { at: '2026-08-26T12:00:00.000Z', id: 'memory-z' },
    limit: 11,
  })

  assert.equal(result.totalCount, 7)
  assert.deepEqual(rows.calls, [
    ['eq', 'entity_id', 'entity-1'],
    ['neq', 'memory_type', 'source_marker'],
    ['not', 'event_at', 'is', null],
    ['or', 'event_at.lt.2026-08-26T12:00:00.000Z,and(event_at.eq.2026-08-26T12:00:00.000Z,id.lt.memory-z)'],
    ['order', 'event_at', { ascending: false }],
    ['order', 'id', { ascending: false }],
    ['limit', 11],
  ])
  assert.deepEqual(count.calls, [
    ['eq', 'entity_id', 'entity-1'],
    ['neq', 'memory_type', 'source_marker'],
    ['not', 'event_at', 'is', null],
  ])
})
