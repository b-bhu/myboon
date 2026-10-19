import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { writeExtraction } from './resolver'
import { SupabaseEntityMemoryStore, __testing } from './supabase-store'
import type {
  EntityInput,
  EntityMemoryExtraction,
  EntityMemoryType,
  EntityRecord,
  ExtractionProvider,
  ResearchPacket,
} from './types'

// A minimal stand-in for the Supabase wire: two tables, the two RPCs the
// entity manager uses, and a counter for entities-table catalog reads. Only
// the query shapes production code actually issues are supported; anything
// else throws so a silently unsupported call cannot fake a pass.
interface FakeRow { [column: string]: unknown }

type QueryResult = { data: FakeRow[] | FakeRow | null; error: { message: string } | null }

class FakeTableQuery implements PromiseLike<QueryResult> {
  private filters: Array<(row: FakeRow) => boolean> = []
  private orderColumn: string | null = null
  private orderAscending = true
  private limitValue: number | null = null
  private upsertAffected: FakeRow[] | null = null
  private updatePayload: Record<string, unknown> | null = null

  constructor(
    private readonly db: FakeSupabase,
    private readonly table: 'entities' | 'entity_memories',
  ) {}

  get rows(): FakeRow[] {
    return this.table === 'entities' ? this.db.entities : this.db.entity_memories
  }

  select(_columns: string): this {
    return this
  }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value)
    return this
  }

  in(column: string, values: readonly unknown[]): this {
    const wanted = new Set(values.map((value) => String(value)))
    this.filters.push((row) => wanted.has(String(row[column])))
    return this
  }

  gte(column: string, value: string): this {
    this.filters.push((row) => String(row[column]) >= value)
    return this
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.orderColumn = column
    this.orderAscending = options?.ascending ?? true
    return this
  }

  limit(value: number): this {
    this.limitValue = value
    return this
  }

  upsert(payload: FakeRow[]): this {
    const rows = this.rows
    this.upsertAffected = payload.map((row) => {
      if (this.table === 'entities') {
        const existing = rows.find((candidate) => candidate.slug === row.slug)
        if (existing) {
          Object.assign(existing, row)
          return existing
        }
        const created: FakeRow = {
          id: `entity-fake-${this.db.nextEntityId++}`,
          created_at: FakeSupabase.NOW,
          updated_at: FakeSupabase.NOW,
          show_in_carousel: false,
          ...row,
        }
        rows.push(created)
        return created
      }
      const created: FakeRow = {
        id: `memory-${this.db.nextMemoryId++}`,
        created_at: FakeSupabase.NOW,
        updated_at: FakeSupabase.NOW,
        ...row,
      }
      rows.push(created)
      return created
    })
    return this
  }

  update(payload: Record<string, unknown>): this {
    this.updatePayload = payload
    return this
  }

  async single(): Promise<QueryResult> {
    if (this.updatePayload) {
      const rows = this.rows.filter((row) => this.filters.every((filter) => filter(row)))
      if (rows.length === 0) return { data: null, error: { message: 'update matched no rows' } }
      for (const row of rows) Object.assign(row, this.updatePayload)
      return { data: { ...rows[0] }, error: null }
    }
    const rows = this.matching()
    if (rows.length === 0) return { data: null, error: { message: 'query matched no rows' } }
    return { data: { ...rows[0] }, error: null }
  }

  async maybeSingle(): Promise<QueryResult> {
    const rows = this.matching()
    return { data: rows.length > 0 ? { ...rows[0] } : null, error: null }
  }

  private matching(): FakeRow[] {
    let rows = this.rows.filter((row) => this.filters.every((filter) => filter(row)))
    if (this.orderColumn) {
      const column = this.orderColumn
      const direction = this.orderAscending ? 1 : -1
      rows = [...rows].sort((left, right) => (
        String(left[column]) < String(right[column]) ? -direction : String(left[column]) > String(right[column]) ? direction : 0
      ))
    }
    if (this.limitValue !== null) rows = rows.slice(0, this.limitValue)
    return rows
  }

  private result(): QueryResult {
    if (this.upsertAffected) return { data: this.upsertAffected.map((row) => ({ ...row })), error: null }
    if (this.table === 'entities' && !this.updatePayload) this.db.catalogReads += 1
    if (this.db.catalogError) return { data: [], error: this.db.catalogError }
    return { data: this.matching().map((row) => ({ ...row })), error: null }
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.result()).then(onfulfilled ?? undefined) as PromiseLike<TResult1 | TResult2>
  }
}

class FakeSupabase {
  static NOW = '2026-10-20T10:00:00.000Z'

  readonly entities: FakeRow[] = []
  readonly entity_memories: FakeRow[] = []
  catalogReads = 0
  catalogError: { message: string } | null = null
  nextEntityId = 1
  nextMemoryId = 1

  from(table: string): FakeTableQuery {
    if (table !== 'entities' && table !== 'entity_memories') {
      throw new Error(`unexpected table: ${table}`)
    }
    return new FakeTableQuery(this, table)
  }

  async rpc(method: string, params: Record<string, unknown>): Promise<{ data: unknown; error: null }> {
    if (method === 'entity_manager_lookup_entities_v1') {
      const slugs = (params.p_slugs ?? []) as string[]
      const names = ((params.p_names ?? []) as string[]).map((name) => name.toLowerCase())
      const labels = new Set([
        ...names,
        ...((params.p_aliases ?? []) as string[]).map((alias) => alias.toLowerCase()),
      ])
      const matched = this.entities.filter((row) => {
        if (slugs.includes(String(row.slug))) return true
        if (names.includes(String(row.name).toLowerCase())) return true
        const rowAliases = Array.isArray(row.aliases) ? row.aliases.map(String) : []
        return rowAliases.some((alias) => labels.has(alias.toLowerCase()))
      })
      return { data: matched.map((row) => ({ ...row, total_count: matched.length })), error: null }
    }
    if (method === 'resolve_entity_redirect_v1') {
      return { data: String(params.p_entity_id), error: null }
    }
    throw new Error(`unexpected rpc: ${method}`)
  }

  asClient(): SupabaseClient {
    return this as unknown as SupabaseClient
  }
}

function entityRow(overrides: Partial<EntityRecord>): EntityRecord {
  return {
    id: 'entity-1',
    slug: 'bitcoin',
    name: 'Bitcoin',
    type: 'asset',
    aliases: ['BTC'],
    summary: null,
    status: 'active',
    show_in_carousel: false,
    metadata: {},
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const entityInput = (overrides: Partial<EntityInput> = {}): EntityInput => ({
  slug: 'ethereum',
  name: 'Ethereum',
  type: 'asset',
  aliases: ['ETH'],
  summary: null,
  status: 'active',
  metadata: {},
  ...overrides,
})

test('listEntities serves repeated calls within the TTL from a single catalog read', async () => {
  const db = new FakeSupabase()
  db.entities.push(
    { ...entityRow({ id: 'entity-1', slug: 'bitcoin', created_at: '2026-01-01T00:00:00.000Z' }) },
    { ...entityRow({ id: 'entity-2', slug: 'ethereum', created_at: '2026-01-02T00:00:00.000Z' }) },
  )
  const store = new SupabaseEntityMemoryStore(db.asClient())

  const first = await store.listEntities()
  const second = await store.listEntities()
  const narrow = await store.listEntities(1)

  assert.equal(db.catalogReads, 1)
  assert.deepEqual(second, first)
  assert.deepEqual(narrow, first.slice(0, 1))

  // A larger limit than the cached page cannot be served from it.
  const wider = await store.listEntities(2_000)
  assert.equal(db.catalogReads, 2)
  assert.equal(wider.length, 2)
  await store.listEntities(2_000)
  assert.equal(db.catalogReads, 2)
})

test('listEntities reloads the catalog once the cache TTL has elapsed', async () => {
  const db = new FakeSupabase()
  db.entities.push({ ...entityRow({}) })
  let clock = Date.parse('2026-10-20T10:00:00.000Z')
  const store = new SupabaseEntityMemoryStore(db.asClient(), () => new Date(clock))

  await store.listEntities()
  assert.equal(db.catalogReads, 1)

  clock += __testing.DEFAULT_CATALOG_CACHE_TTL_MS
  await store.listEntities()
  assert.equal(db.catalogReads, 1, 'a cache exactly at the TTL boundary is still fresh')

  clock += 1
  await store.listEntities()
  assert.equal(db.catalogReads, 2, 'one millisecond past the TTL must reload')
})

test('entity writes fold their authoritative rows into the cached catalog without a reload', async () => {
  const db = new FakeSupabase()
  db.entities.push({ ...entityRow({ id: 'entity-1', slug: 'bitcoin' }) })
  const store = new SupabaseEntityMemoryStore(db.asClient())

  const initial = await store.listEntities()
  assert.deepEqual(initial.map((entity) => entity.slug), ['bitcoin'])

  // This process creates an entity: visible to the next packet's guardrail
  // immediately, with no reload. A fresh read would include it because the
  // table is smaller than the loaded limit.
  const [created] = await store.createEntities([entityInput()])
  assert.deepEqual((await store.listEntities()).map((entity) => entity.slug), ['bitcoin', 'ethereum'])
  assert.equal(db.catalogReads, 1)

  // Alias merges replace the row in place, preserving freshness of content.
  const updated = await store.updateEntity({
    ...created,
    aliases: ['ETH', 'Ether'],
  })
  const cached = await store.listEntities()
  assert.deepEqual(cached.find((entity) => entity.id === created.id)?.aliases, ['ETH', 'Ether'])
  assert.equal(db.catalogReads, 1)
  assert.equal(updated.status, 'active')

  // Retiring an entity drops it from the cache, mirroring the read's
  // status='active' filter, so the guardrail stops snapping onto it.
  await store.updateEntity({ ...updated, status: 'archived' })
  assert.deepEqual((await store.listEntities()).map((entity) => entity.slug), ['bitcoin'])
  assert.equal(db.catalogReads, 1)
  assert.equal(db.entities.length, 2, 'the underlying row is still stored, like today')
})

test('a failed catalog load throws exactly as before and leaves the old cache intact', async () => {
  const db = new FakeSupabase()
  db.entities.push({ ...entityRow({}) })
  let clock = Date.parse('2026-10-20T10:00:00.000Z')
  const store = new SupabaseEntityMemoryStore(db.asClient(), () => new Date(clock))

  await store.listEntities()
  assert.equal(db.catalogReads, 1)

  clock += __testing.DEFAULT_CATALOG_CACHE_TTL_MS + 1
  db.catalogError = { message: 'connection refused' }
  await assert.rejects(store.listEntities(), /entity catalog list failed: connection refused/)
  await assert.rejects(store.listEntities(), /entity catalog list failed: connection refused/)
  assert.equal(db.catalogReads, 3, 'a failure is never cached; every call retries the load')

  db.catalogError = null
  assert.deepEqual(await store.listEntities(), [{ ...entityRow({}) }])
  assert.equal(db.catalogReads, 4)
  assert.deepEqual(await store.listEntities(), [{ ...entityRow({}) }])
  assert.equal(db.catalogReads, 4)
})

test('a fresh cache shields callers from a failing catalog wire without hiding healthy reads', async () => {
  const db = new FakeSupabase()
  db.entities.push({ ...entityRow({}) })
  const store = new SupabaseEntityMemoryStore(db.asClient())

  assert.deepEqual(await store.listEntities(), [{ ...entityRow({}) }])
  assert.equal(db.catalogReads, 1)

  db.catalogError = { message: 'connection refused' }
  assert.deepEqual(await store.listEntities(), [{ ...entityRow({}) }])
  assert.equal(db.catalogReads, 1, 'a fresh cache serves without touching the broken wire')

  db.catalogError = null
  assert.deepEqual(await store.listEntities(), [{ ...entityRow({}) }])
  assert.equal(db.catalogReads, 1)
})

test('writeExtraction performs one catalog read for a whole cycle of packets, including after a create', async () => {
  const db = new FakeSupabase()
  const store = new SupabaseEntityMemoryStore(db.asClient(), () => new Date(Date.parse(FakeSupabase.NOW)))

  const capturedCatalogs: string[][] = []
  const provider = (extraction: EntityMemoryExtraction): ExtractionProvider => ({
    async extract(_packet, canon) {
      capturedCatalogs.push((canon?.catalog ?? []).map((entity) => entity.slug))
      return extraction
    },
  })

  // Packet 1 proposes a brand-new entity; the resolver creates it.
  const first = await writeExtraction(
    store,
    polymarketPacket('research-1', '2026-06-22T00:00:00.000Z'),
    provider({
      primaryEntities: [{
        name: 'China-Taiwan tensions',
        slug: 'china-taiwan',
        type: 'topic',
      }],
      memories: [{
        entitySlug: 'china-taiwan',
        memoryType: 'market_signal' as EntityMemoryType,
        title: 'Taiwan tension odds moved',
        summary: 'Odds moved after a speech.',
      }],
    }),
  )

  assert.equal(db.catalogReads, 1)
  assert.deepEqual(capturedCatalogs[0], [], 'packet 1 runs against a then-empty catalog')
  assert.equal(first.entitiesCreated, 1)
  assert.equal(first.entitiesReused, 0)
  assert.equal(first.memoriesWritten, 1)

  // Packet 2 in the same cycle proposes a granular variant of the entity
  // packet 1 just created. The catalog cache must show it (no reload) so the
  // near-duplicate guardrail snaps the variant instead of creating a sibling
  // row.
  const second = await writeExtraction(
    store,
    polymarketPacket('research-2', '2026-06-25T00:00:00.000Z'),
    provider({
      primaryEntities: [{
        name: 'China-Taiwan military clash 2027',
        slug: 'china-taiwan-military-clash-2027',
        type: 'topic',
      }],
      memories: [{
        entitySlug: 'china-taiwan-military-clash-2027',
        memoryType: 'market_signal' as EntityMemoryType,
        title: 'Clash market odds moved',
        summary: 'Odds moved after exercises.',
      }],
    }),
  )

  assert.equal(db.catalogReads, 1, 'the create must not force a catalog reload for packet 2')
  assert.deepEqual(capturedCatalogs[1], ['china-taiwan'], 'the freshly created entity is visible to packet 2')
  assert.equal(second.entitiesCreated, 0, 'the guardrail snapped the variant onto the created entity')
  assert.equal(second.entitiesReused, 1)
  assert.equal(second.memoriesWritten, 1)
  assert.equal(db.entities.length, 1, 'no sibling near-duplicate row was written')
  assert.deepEqual(
    db.entity_memories.map((memory) => memory.entity_id),
    [db.entities[0].id, db.entities[0].id],
    'both packets filed under the one entity',
  )
})

function polymarketPacket(sourceResearchId: string, observedAt: string): ResearchPacket {
  return {
    id: `polymarket:markets:${sourceResearchId}`,
    source: 'polymarket',
    sourceArea: 'markets',
    sourceResearchId,
    sourceType: 'market_signal',
    sourceRefId: sourceResearchId,
    title: 'China-Taiwan market',
    summary: 'Market odds moved.',
    body: 'Market odds moved.',
    observedAt,
    eventAt: observedAt,
    evidence: [],
    metrics: {},
    context: {},
  }
}