import type { SupabaseClient } from '@supabase/supabase-js'

export const ENTITY_MEMORY_MIGRATION_VERIFICATION_SCHEMA_VERSION =
  'myboon.entity_memory_migration_verification.v1' as const

const REQUIRED_INDEXES = [
  'entity_memories_identity_key_unique_idx',
  'entity_memories_observed_cursor_idx',
  'entity_memories_updated_cursor_idx',
  'entity_memories_priority_observed_cursor_idx',
] as const
const REQUIRED_FUNCTIONS = [
  'entity_manager_lookup_entities_v1',
  'entity_manager_create_entity_v1',
] as const

export interface EntityMemoryMigrationVerificationReport {
  schemaVersion: typeof ENTITY_MEMORY_MIGRATION_VERIFICATION_SCHEMA_VERSION
  ok: boolean
  totalRows: number
  nullIdentityKeys: number
  duplicateIdentityKeyGroups: number
  identityColumnExists: boolean
  identityNotNull: boolean
  requiredIndexes: Record<(typeof REQUIRED_INDEXES)[number], boolean>
  requiredFunctions: Record<(typeof REQUIRED_FUNCTIONS)[number], boolean>
  serviceRoleGrants: Record<(typeof REQUIRED_FUNCTIONS)[number], boolean>
  rollingTriggerPresent: boolean
}

export class EntityMemoryMigrationCapabilityError extends Error {
  constructor(message: string, readonly report: EntityMemoryMigrationVerificationReport | null = null) {
    super(message)
    this.name = 'EntityMemoryMigrationCapabilityError'
  }
}

/** Performs one read-only RPC. It never applies, links, repairs, or writes. */
export async function verifyEntityMemoryMigration(
  db: Pick<SupabaseClient, 'rpc'>,
): Promise<EntityMemoryMigrationVerificationReport> {
  const { data, error } = await db.rpc('entity_manager_verify_migration_v1')
  if (error) {
    throw new EntityMemoryMigrationCapabilityError(
      `Entity memory migration verification RPC failed: ${error.message}`,
    )
  }
  return normalizeReport(data)
}

export async function assertEntityMemoryMigrationReady(
  db: Pick<SupabaseClient, 'rpc'>,
): Promise<EntityMemoryMigrationVerificationReport> {
  const report = await verifyEntityMemoryMigration(db)
  if (!report.ok) {
    throw new EntityMemoryMigrationCapabilityError(
      'Entity memory identity migration is incomplete; active claims are disabled.',
      report,
    )
  }
  return report
}

function normalizeReport(value: unknown): EntityMemoryMigrationVerificationReport {
  if (!isRecord(value) || value.schema_version !== ENTITY_MEMORY_MIGRATION_VERIFICATION_SCHEMA_VERSION) {
    throw new EntityMemoryMigrationCapabilityError('Entity memory migration verification returned an invalid schema.')
  }
  const requiredIndexes = booleanMap(value.required_indexes, REQUIRED_INDEXES, 'required_indexes')
  const requiredFunctions = booleanMap(value.required_functions, REQUIRED_FUNCTIONS, 'required_functions')
  const serviceRoleGrants = booleanMap(value.service_role_grants, REQUIRED_FUNCTIONS, 'service_role_grants')
  const report = {
    schemaVersion: ENTITY_MEMORY_MIGRATION_VERIFICATION_SCHEMA_VERSION,
    totalRows: count(value.total_rows, 'total_rows'),
    nullIdentityKeys: count(value.null_identity_keys, 'null_identity_keys'),
    duplicateIdentityKeyGroups: count(value.duplicate_identity_key_groups, 'duplicate_identity_key_groups'),
    identityColumnExists: bool(value.identity_column_exists, 'identity_column_exists'),
    identityNotNull: bool(value.identity_not_null, 'identity_not_null'),
    requiredIndexes,
    requiredFunctions,
    serviceRoleGrants,
    rollingTriggerPresent: bool(value.rolling_trigger_present, 'rolling_trigger_present'),
  }
  return {
    ...report,
    ok: report.nullIdentityKeys === 0
      && report.duplicateIdentityKeyGroups === 0
      && report.identityColumnExists
      && report.identityNotNull
      && Object.values(report.requiredIndexes).every(Boolean)
      && Object.values(report.requiredFunctions).every(Boolean)
      && Object.values(report.serviceRoleGrants).every(Boolean)
      && report.rollingTriggerPresent,
  }
}

function booleanMap<K extends string>(value: unknown, keys: readonly K[], field: string): Record<K, boolean> {
  if (!isRecord(value)) throw new EntityMemoryMigrationCapabilityError(`${field} must be an object.`)
  return Object.fromEntries(keys.map((key) => [key, bool(value[key], `${field}.${key}`)])) as Record<K, boolean>
}

function count(value: unknown, field: string): number {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new EntityMemoryMigrationCapabilityError(`${field} must be a non-negative safe integer.`)
  }
  return numeric
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new EntityMemoryMigrationCapabilityError(`${field} must be boolean.`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
