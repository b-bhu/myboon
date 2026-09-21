import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SupabaseEntityCatalogCleanupExecutor } from './cleanup-executor'
import type { EntityMaintenanceFindingInput } from './contracts'
import { maintenanceProfile } from './test-helpers'

function finding(partial: Partial<EntityMaintenanceFindingInput> = {}): EntityMaintenanceFindingInput {
  const left = maintenanceProfile({ id: 'left', name: 'Duplicate' })
  const right = maintenanceProfile({ id: 'right', name: 'Duplicate' })
  return {
    runId: 'run-1',
    pairKey: 'left:right',
    leftEntityId: left.id,
    rightEntityId: right.id,
    decision: 'same_entity',
    recommendedAction: 'merge',
    confidence: 0.999,
    canonicalEntityId: left.id,
    pollutedEntityId: null,
    pollutedAlias: null,
    reason: 'Exact canonical identity.',
    candidateSignals: [{ kind: 'exact_name', label: 'duplicate' }],
    profileSnapshot: { left, right },
    autoApplyEligible: true,
    ...partial,
  }
}

function fakeDb(rpcCalls: Array<{ name: string, args: Record<string, unknown> }>): SupabaseClient {
  const builder: Record<string, unknown> = {}
  Object.assign(builder, {
    select() { return builder },
    eq() { return builder },
    async in(_field: string, pairKeys: string[]) {
      return {
        data: pairKeys.map((pairKey, index) => ({ id: `finding-${index + 1}`, pair_key: pairKey })),
        error: null,
      }
    },
  })
  return {
    from() { return builder },
    async rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args })
      return { data: 'operation-1', error: null }
    },
  } as unknown as SupabaseClient
}

test('automatic cleanup refuses to mutate aliases even if an input is incorrectly marked eligible', async () => {
  const rpcCalls: Array<{ name: string, args: Record<string, unknown> }> = []
  const executor = new SupabaseEntityCatalogCleanupExecutor(
    fakeDb(rpcCalls),
    { async count() { return 0 } },
  )
  const alias = finding({
    decision: 'polluted_alias',
    recommendedAction: 'quarantine_alias',
    canonicalEntityId: null,
    pollutedEntityId: 'left',
    pollutedAlias: 'Duplicate',
  })

  const result = await executor.applyEligible('run-1', [alias])

  assert.equal(result.mutationCount, 0)
  assert.equal(result.aliasQuarantineCount, 0)
  assert.equal(result.errors.length, 0)
  assert.deepEqual(result.skipped, [{
    findingId: 'finding-1',
    reason: 'alias_requires_explicit_review',
  }])
  assert.deepEqual(rpcCalls, [])
})

test('automatic merge fails closed while any local draft references the source Entity', async () => {
  const rpcCalls: Array<{ name: string, args: Record<string, unknown> }> = []
  const executor = new SupabaseEntityCatalogCleanupExecutor(
    fakeDb(rpcCalls),
    { async count(entityId) { assert.equal(entityId, 'right'); return 2 } },
  )

  const result = await executor.applyEligible('run-1', [finding()])

  assert.equal(result.mutationCount, 0)
  assert.deepEqual(result.skipped, [{
    findingId: 'finding-1',
    reason: 'local_draft_inventory_not_empty:2',
  }])
  assert.deepEqual(rpcCalls, [])
})

test('automatic merge calls the guarded atomic RPC when local inventory is empty', async () => {
  const rpcCalls: Array<{ name: string, args: Record<string, unknown> }> = []
  const executor = new SupabaseEntityCatalogCleanupExecutor(
    fakeDb(rpcCalls),
    { async count() { return 0 } },
  )

  const result = await executor.applyEligible('run-1', [finding()])

  assert.equal(result.mergeCount, 1)
  assert.equal(result.mutationCount, 1)
  assert.equal(rpcCalls[0]?.name, 'entity_catalog_apply_merge_v1')
  assert.deepEqual(rpcCalls[0]?.args, {
    p_finding_id: 'finding-1',
    p_actor: 'entity-catalog-maintenance',
    p_aliases_to_add: [],
  })
})
