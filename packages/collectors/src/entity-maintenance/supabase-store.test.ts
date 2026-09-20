import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SupabaseEntityCatalogMaintenanceStore } from './supabase-store'

test('run claim expires stale leases globally rather than within one scope', async () => {
  const equalityFilters: Array<[string, unknown]> = []
  const builder: Record<string, unknown> & { error: null } = { error: null }
  Object.assign(builder, {
    update() { return builder },
    insert() { return builder },
    select() { return builder },
    eq(field: string, value: unknown) {
      equalityFilters.push([field, value])
      return builder
    },
    lt() { return builder },
    async single() {
      return { data: { id: 'run-1', status: 'running' }, error: null }
    },
  })
  const db = { from() { return builder } } as unknown as SupabaseClient
  const store = new SupabaseEntityCatalogMaintenanceStore(db, () => new Date('2026-09-20T00:00:00.000Z'))

  await store.beginRun({
    trigger: 'scheduled',
    mode: 'dry_run',
    scope: 'incremental',
    provider: 'ollama-cloud',
    model: 'glm-5.3-flash',
    promptVersion: 'entity.catalog.maintenance.v1',
    leaseMs: 60_000,
  })

  assert.ok(equalityFilters.some(([field, value]) => field === 'status' && value === 'running'))
  assert.equal(equalityFilters.some(([field]) => field === 'scope'), false)
})

test('full-catalog baseline lookup cannot be satisfied by an incremental run', async () => {
  const equalityFilters: Array<[string, unknown]> = []
  const builder: Record<string, unknown> = {}
  Object.assign(builder, {
    select() { return builder },
    eq(field: string, value: unknown) {
      equalityFilters.push([field, value])
      return builder
    },
    limit() { return builder },
    async maybeSingle() { return { data: { id: 'full-run' }, error: null } },
  })
  const db = { from() { return builder } } as unknown as SupabaseClient
  const store = new SupabaseEntityCatalogMaintenanceStore(db)

  assert.equal(await store.hasCompletedFullCatalogRun(), true)
  assert.deepEqual(equalityFilters, [
    ['scope', 'full_catalog'],
    ['status', 'completed'],
  ])
})

test('profile hydration keyset-paginates beyond the Supabase Data API row ceiling', async () => {
  const calls: Array<Record<string, unknown>> = []
  const firstPage = Array.from({ length: 500 }, (_, index) => profileRow(`entity-${String(index).padStart(4, '0')}`))
  const secondPage = [profileRow('entity-0500')]
  const db = {
    async rpc(name: string, args: Record<string, unknown>) {
      assert.equal(name, 'internal_entity_catalog_profiles_v1')
      calls.push(args)
      return { data: args.p_after_id === null ? firstPage : secondPage, error: null }
    },
  } as unknown as SupabaseClient
  const store = new SupabaseEntityCatalogMaintenanceStore(db)

  const profiles = await store.listProfiles('full_catalog')

  assert.equal(profiles.length, 501)
  assert.deepEqual(calls, [
    { p_after_id: null, p_limit: 500 },
    { p_after_id: 'entity-0499', p_limit: 500 },
  ])
})

function profileRow(id: string): Record<string, unknown> {
  return {
    id,
    slug: id,
    name: id,
    type: 'organization',
    aliases: [],
    summary: null,
    status: 'active',
    show_in_carousel: false,
    tags: [],
    created_at: '2026-09-20T00:00:00.000Z',
    updated_at: '2026-09-20T00:00:00.000Z',
    changed_at: '2026-09-20T00:00:00.000Z',
    memory_count: 0,
    source_count: 0,
    first_memory_at: null,
    last_memory_at: null,
    recent_memories: [],
  }
}
