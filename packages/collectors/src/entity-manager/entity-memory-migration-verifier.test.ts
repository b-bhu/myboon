import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  EntityMemoryMigrationCapabilityError,
  assertEntityMemoryMigrationReady,
  verifyEntityMemoryMigration,
} from './entity-memory-migration-verifier'

function raw(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'myboon.entity_memory_migration_verification.v1',
    total_rows: 42,
    null_identity_keys: 0,
    duplicate_identity_key_groups: 0,
    identity_column_exists: true,
    identity_not_null: true,
    required_indexes: {
      entity_memories_identity_key_unique_idx: true,
      entity_memories_observed_cursor_idx: true,
      entity_memories_updated_cursor_idx: true,
      entity_memories_priority_observed_cursor_idx: true,
    },
    required_functions: {
      entity_manager_lookup_entities_v1: true,
      entity_manager_create_entity_v1: true,
    },
    service_role_grants: {
      entity_manager_lookup_entities_v1: true,
      entity_manager_create_entity_v1: true,
    },
    rolling_trigger_present: true,
    ...overrides,
  }
}

function client(data: unknown, error: { message: string } | null = null): Pick<SupabaseClient, 'rpc'> {
  return {
    rpc: (async (fn: string) => {
      assert.equal(fn, 'entity_manager_verify_migration_v1')
      return { data, error }
    }) as unknown as SupabaseClient['rpc'],
  }
}

test('migration verifier reports complete read-only capability state', async () => {
  const report = await verifyEntityMemoryMigration(client(raw()))
  assert.equal(report.ok, true)
  assert.equal(report.totalRows, 42)
  assert.equal(report.requiredFunctions.entity_manager_create_entity_v1, true)
})

test('active readiness fails closed for missing capabilities, dirty identities, and RPC errors', async () => {
  for (const incomplete of [
    raw({ null_identity_keys: 1 }),
    raw({ duplicate_identity_key_groups: 1 }),
    raw({ rolling_trigger_present: false }),
    raw({ required_functions: {
      entity_manager_lookup_entities_v1: true,
      entity_manager_create_entity_v1: false,
    } }),
  ]) {
    await assert.rejects(assertEntityMemoryMigrationReady(client(incomplete)), (error: unknown) => (
      error instanceof EntityMemoryMigrationCapabilityError && error.report?.ok === false
    ))
  }
  await assert.rejects(
    verifyEntityMemoryMigration(client(null, { message: 'function is absent' })),
    /verification RPC failed: function is absent/,
  )
})
