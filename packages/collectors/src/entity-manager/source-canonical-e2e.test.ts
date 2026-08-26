import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { GenerateStructuredRequest } from '../inference-gateway/types'
import {
  operatorPacket,
  operatorSignal,
  operatorWork,
} from '../signal-platform/operator-fixtures.test-support'
import { SqliteSignalPlatformStore } from '../signal-platform/sqlite-platform-store'
import { adaptCanonicalResearchPacket } from './canonical-packet-adapter'
import {
  CANONICAL_ENTITY_PLAN_SCHEMA_VERSION,
  EntityServiceCanonicalPacketProcessor,
  type CanonicalEntityPlan,
} from './canonical-processor'
import { GatewayCanonicalEntityPlanner } from './canonical-planner'
import { createSharedEntityRuntime } from './run-shared'
import { SupabaseEntityMemoryStore, __testing as storeTesting } from './supabase-store'
import type { EntityMemoryRecord, EntityRecord } from './types'

const NOW = '2026-08-26T12:00:00.000Z'

function entity(id: string, slug: string, name: string): EntityRecord {
  return {
    id, slug, name, type: 'organization', aliases: [name], summary: `${name} summary`,
    status: 'active', show_in_carousel: false, metadata: {}, created_at: NOW, updated_at: NOW,
  }
}

class FakeCanonicalSupabase {
  readonly entities = [
    entity('entity-news', 'news-entity', 'News Entity'),
    entity('entity-poly', 'polymarket-entity', 'Polymarket Entity'),
  ]
  readonly memories = new Map<string, EntityMemoryRecord>()
  createCalls = 0
  failNewsCanon = true
  private nextMemory = 1

  readonly client = {
    rpc: async (fn: string, args?: Record<string, unknown>) => this.rpc(fn, args ?? {}),
    from: (table: string) => this.from(table),
  } as unknown as SupabaseClient

  async rpc(fn: string, args: Record<string, unknown>) {
    if (fn === 'entity_manager_verify_migration_v1') {
      return { data: migrationReport(), error: null }
    }
    if (fn === 'entity_manager_lookup_entities_v1') {
      const names = [...((args.p_names as string[] | undefined) ?? []), ...((args.p_aliases as string[] | undefined) ?? [])]
      if (this.failNewsCanon && names.includes('News Entity')) {
        return { data: null, error: { message: 'temporary canonical lookup outage' } }
      }
      const slugs = new Set((args.p_slugs as string[] | undefined) ?? [])
      const labels = new Set(names.map((value) => value.toLowerCase()))
      const matches = this.entities.filter((candidate) => (
        slugs.has(candidate.slug)
        || labels.has(candidate.name.toLowerCase())
        || candidate.aliases.some((alias) => labels.has(alias.toLowerCase()))
      ))
      return { data: matches.map((candidate) => ({ ...candidate, total_count: matches.length })), error: null }
    }
    if (fn === 'entity_manager_create_entity_v1') {
      this.createCalls += 1
      return { data: null, error: { message: 'unexpected canonical creation' } }
    }
    return { data: null, error: { message: `unexpected RPC ${fn}` } }
  }

  from(table: string) {
    assert.equal(table, 'entity_memories')
    return {
      select: (_columns: string) => new MemoryQuery(this),
      upsert: (payload: Array<Record<string, unknown>>, options: Record<string, unknown>) => {
        assert.deepEqual(options, { onConflict: 'memory_identity_key' })
        const rows = payload.map((item) => this.upsertMemory(item))
        return { select: async (columns: string) => {
          assert.equal(columns, storeTesting.MEMORY_SELECT)
          return { data: rows, error: null }
        } }
      },
      update: (patch: Record<string, unknown>) => new MemoryUpdate(this, patch),
    }
  }

  private upsertMemory(item: Record<string, unknown>): EntityMemoryRecord {
    const identity = String(item.memory_identity_key)
    const previous = this.memories.get(identity)
    const row = {
      ...(previous ?? {}),
      ...item,
      id: previous?.id ?? `memory-${this.nextMemory++}`,
      created_at: previous?.created_at ?? NOW,
      updated_at: String(item.updated_at ?? NOW),
    } as EntityMemoryRecord
    this.memories.set(identity, row)
    return row
  }

  updateById(id: string, patch: Record<string, unknown>): EntityMemoryRecord | null {
    for (const [identity, row] of this.memories) {
      if (row.id !== id) continue
      const updated = { ...row, ...patch } as EntityMemoryRecord
      this.memories.set(identity, updated)
      return updated
    }
    return null
  }
}

class MemoryQuery implements PromiseLike<{ data: EntityMemoryRecord[]; error: null }> {
  private rows: EntityMemoryRecord[]
  private maximum = Number.POSITIVE_INFINITY

  constructor(database: FakeCanonicalSupabase) { this.rows = [...database.memories.values()] }
  eq(column: string, value: string) {
    this.rows = this.rows.filter((row) => String((row as unknown as Record<string, unknown>)[column]) === value)
    return this
  }
  in(column: string, values: readonly string[]) {
    const wanted = new Set(values)
    this.rows = this.rows.filter((row) => wanted.has(String((row as unknown as Record<string, unknown>)[column])))
    return this
  }
  gte(column: string, value: string) {
    this.rows = this.rows.filter((row) => String((row as unknown as Record<string, unknown>)[column]) >= value)
    return this
  }
  lte(column: string, value: string) {
    this.rows = this.rows.filter((row) => String((row as unknown as Record<string, unknown>)[column]) <= value)
    return this
  }
  order(column: string, options: { ascending: boolean }) {
    const direction = options.ascending ? 1 : -1
    this.rows.sort((left, right) => {
      const a = String((left as unknown as Record<string, unknown>)[column])
      const b = String((right as unknown as Record<string, unknown>)[column])
      return (a < b ? -1 : a > b ? 1 : 0) * direction
    })
    return this
  }
  limit(limit: number) { this.maximum = limit; return this }
  async maybeSingle() { return { data: this.result()[0] ?? null, error: null } }
  then<TResult1 = { data: EntityMemoryRecord[]; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: EntityMemoryRecord[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({ data: this.result(), error: null }).then(onfulfilled, onrejected)
  }
  private result() { return this.rows.slice(0, this.maximum) }
}

class MemoryUpdate {
  private id: string | null = null
  constructor(private readonly database: FakeCanonicalSupabase, private readonly patch: Record<string, unknown>) {}
  eq(column: string, value: string) { assert.equal(column, 'id'); this.id = value; return this }
  select(columns: string) { assert.equal(columns, storeTesting.MEMORY_SELECT); return this }
  async single() {
    const data = this.id ? this.database.updateById(this.id, this.patch) : null
    return data ? { data, error: null } : { data: null, error: { message: 'memory not found' } }
  }
}

function migrationReport() {
  return {
    schema_version: 'myboon.entity_memory_migration_verification.v1',
    total_rows: 0, null_identity_keys: 0, duplicate_identity_key_groups: 0,
    identity_column_exists: true, identity_not_null: true,
    required_indexes: {
      entity_memories_identity_key_unique_idx: true,
      entity_memories_observed_cursor_idx: true,
      entity_memories_updated_cursor_idx: true,
      entity_memories_priority_observed_cursor_idx: true,
    },
    required_functions: {
      entity_manager_lookup_entities_v1: true, entity_manager_create_entity_v1: true,
    },
    service_role_grants: {
      entity_manager_lookup_entities_v1: true, entity_manager_create_entity_v1: true,
    },
    rolling_trigger_present: true,
  }
}

function packet(source: 'news' | 'polymarket', id: string, observedAt = '2026-08-26T10:00:00.000Z') {
  const label = source === 'news' ? 'News Entity' : 'Polymarket Entity'
  return operatorPacket(source, id, {
    observedAt,
    entityHints: [{
      name: label, type: 'organization', role: 'subject', aliases: [], source: 'canonical',
      claimRefs: [`claim-${id}`], evidenceRefs: [`evidence-${id}`],
    }],
  })
}

function plannerGateway(titles: Record<'news' | 'polymarket', string>) {
  return {
    resolveRoute() {},
    async generateStructured<T>(request: GenerateStructuredRequest<T>) {
      const source = request.prompt.includes('"sourceType":"news"') ? 'news' : 'polymarket'
      const id = request.prompt.match(/"packetId":"packet-([^"]+)"/)?.[1]
      assert.ok(id)
      const value: CanonicalEntityPlan = {
        schemaVersion: CANONICAL_ENTITY_PLAN_SCHEMA_VERSION,
        decision: {
          action: 'select_existing',
          entityId: source === 'news' ? 'entity-news' : 'entity-poly',
          supportingClaimIds: [`claim-${id}`],
          supportingEvidenceIds: [`evidence-${id}`],
        },
        memories: [{
          memoryType: source === 'news' ? 'news_event' : 'market_signal',
          memoryRole: 'primary_event',
          title: titles[source],
          summary: `${source} canonical summary for ${id}`,
          representedClaimIds: [`claim-${id}`],
          representedEvidenceIds: [`evidence-${id}`],
        }],
      }
      const validated = request.validate(value)
      assert.equal(validated.valid, true)
      return { value: value as T, telemetry: {} } as never
    },
  }
}

function seed(
  path: string,
  source: 'news' | 'polymarket',
  id: string,
  observedAt = '2026-08-26T10:00:00.000Z',
) {
  const store = new SqliteSignalPlatformStore(path, source)
  const work = operatorWork(source, id, { status: 'entity_pending' })
  const canonicalPacket = packet(source, id, observedAt)
  store.appendSignal(operatorSignal(source, id))
  store.admitResearchWork(work)
  store.appendResearchPacket(canonicalPacket)
  store.close()
  return { work, packet: canonicalPacket }
}

test('source-local News/Polymarket flow isolates canon outages, replays stably, and consolidates market stories', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'myboon-entity-source-e2e-'))
  const newsPath = join(directory, 'news.sqlite')
  const pipelinePath = join(directory, 'pipeline.sqlite')
  const news = seed(newsPath, 'news', 'news-source')
  seed(pipelinePath, 'polymarket', 'poly-source')
  const database = new FakeCanonicalSupabase()
  const titles = { news: 'First generated News title', polymarket: 'Market odds moved' }

  try {
    const runtime = createSharedEntityRuntime({
      env: {
        FEED_V3_ENTITY_MODE: 'active',
        FEED_V3_ENTITY_ACTIVE_SOURCES: 'news,polymarket',
        FEED_V3_LEGACY_ENTITY_DISABLED_SOURCES: 'news,polymarket',
        NEWS_SQLITE_PATH: newsPath,
        PIPELINE_SQLITE_PATH: pipelinePath,
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'test-only',
      },
      supabaseFactory: () => database.client,
      gatewayFactory: () => plannerGateway(titles) as never,
    })
    const cycle = await runtime.runCycle()
    assert.equal(cycle.mode, 'active')
    if (cycle.mode !== 'active') assert.fail('active cycle expected')
    assert.equal(cycle.result.retryWait, 1)
    assert.equal(cycle.result.completed, 1)
    assert.equal(database.createCalls, 0)
    assert.equal([...database.memories.values()].filter((memory) => memory.source === 'news').length, 0)
    assert.equal([...database.memories.values()].filter((memory) => memory.source === 'polymarket').length, 1)
    await runtime.close()

    database.failNewsCanon = false
    const processor = new EntityServiceCanonicalPacketProcessor({
      store: new SupabaseEntityMemoryStore(database.client, () => new Date(NOW)),
      planner: new GatewayCanonicalEntityPlanner({ gateway: plannerGateway(titles) }),
    })
    const newsInput = {
      work: { ...news.work, status: 'entity_leased' as const },
      canonicalPacket: news.packet,
      packet: adaptCanonicalResearchPacket(news.packet),
      signal: new AbortController().signal,
    }
    await processor.process(newsInput)
    const firstNews = [...database.memories.values()].find((memory) => memory.source === 'news')
    assert.ok(firstNews)
    titles.news = 'Completely changed News wording'
    await processor.process(newsInput)
    const newsRows = [...database.memories.values()].filter((memory) => memory.source === 'news')
    assert.equal(newsRows.length, 1)
    assert.equal(newsRows[0].id, firstNews.id)
    assert.equal(newsRows[0].title, titles.news)

    const second = seed(pipelinePath, 'polymarket', 'poly-second', '2026-08-26T10:30:00.000Z')
    await processor.process({
      work: { ...second.work, status: 'entity_leased' },
      canonicalPacket: second.packet,
      packet: adaptCanonicalResearchPacket(second.packet),
      signal: new AbortController().signal,
    })
    const marketRows = [...database.memories.values()].filter((memory) => memory.source === 'polymarket')
    assert.equal(marketRows.length, 1)
    assert.equal(marketRows[0].summary, 'polymarket canonical summary for poly-second')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
