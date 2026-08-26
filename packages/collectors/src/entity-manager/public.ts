import { EntityService, ManualEntityConflictError } from './entity-service'
import { ManualEntityValidationError, normalizeManualEntityCommand } from './manual-adapter'
import {
  ENTITY_KNOWLEDGE_MAX_PAGE_SIZE,
  ENTITY_KNOWLEDGE_SCHEMA_VERSION,
  ENTITY_MEMORY_CHANGES_START_CURSOR,
  InvalidEntityKnowledgeCursorError,
} from './entity-knowledge-reader'
import { SupabaseEntityKnowledgeReader } from './supabase-entity-knowledge-reader'
import { SupabaseEntityMemoryStore } from './supabase-store'

export * from './types'
export * from './manual-adapter'
export * from './entity-service'
export * from './supabase-store'
export {
  ENTITY_KNOWLEDGE_MAX_PAGE_SIZE,
  ENTITY_KNOWLEDGE_SCHEMA_VERSION,
  ENTITY_MEMORY_CHANGES_START_CURSOR,
  InvalidEntityKnowledgeCursorError,
} from './entity-knowledge-reader'
export type {
  EntityKnowledgeMediaV1,
  EntityKnowledgeMemoryType,
  EntityKnowledgeMemoryV1,
  EntityKnowledgeProvenanceV1,
  EntityKnowledgeReader,
  EntityMemoryChangePage,
  EntityMemoryChangeV1,
  EntityMemoryEventPage,
  EntityMemoryPage,
  GetEntityMemoriesInput,
  GetEntityMemoriesByIdsInput,
  GetEntityMemoryEventsInput,
  GetEntityMemoryChangesInput,
  GetRecentEntityMemoriesInput,
  PriorityClass,
} from './entity-knowledge-reader'
export { SupabaseEntityKnowledgeReader } from './supabase-entity-knowledge-reader'
export {
  ENTITY_ADMISSION_MAX_SHORTLIST_SIZE,
  ENTITY_ADMISSION_SCHEMA_VERSION,
  EntityAdmissionValidationError,
  EntityCanonUnavailableError,
  buildEntityAdmissionInput,
  validateEntityAdmissionDecision,
} from './admission'
export type {
  BuildEntityAdmissionInput,
  CanonAvailability,
  CanonicalEntityRef,
  EntityAdmissionDecision,
  EntityAdmissionInput,
  EvidenceSpan,
  NewEntityProposal,
  ValidatedEntityAdmissionDecision,
} from './admission'
export {
  MEMORY_IDENTITY_VERSION,
  MemoryIdentityValidationError,
  deriveMemoryIdentityKey,
} from './memory-identity'
export type { MemoryIdentityInput, MemoryIdentityPacketRef } from './memory-identity'
export {
  CANONICAL_PACKET_ADAPTER_VERSION,
  CanonicalPacketAdapterError,
  CanonicalPacketSourcePolicyRegistry,
  adaptCanonicalResearchPacket,
  canonicalPacketSourcePolicies,
} from './canonical-packet-adapter'
export type { CanonicalPacketSourcePolicy } from './canonical-packet-adapter'
export {
  ENTITY_WORKER_SOURCE_TYPES,
  SharedEntityWorkerConfigError,
  sharedEntityWorkerConfig,
} from './shared-worker-config'
export type {
  EntitySourceOwner,
  EntitySourceRuntimeTopology,
  EntityWorkerSourceType,
  SharedEntityWorkerConfig,
  SharedEntityWorkerConfigInput,
} from './shared-worker-config'
export { SharedEntityWorker } from './shared-worker'
export type {
  ActiveCycleResult,
  CanonicalPacketProcessor,
  CanonicalPacketProcessorInput,
  EntityPacketWorkPort,
  HeartbeatScheduler,
  ShadowCycleResult,
  ShadowEntityObservation,
  ShadowEntityObservationPort,
  SharedEntityWorkerOptions,
} from './shared-worker'
export {
  CANONICAL_ENTITY_PLAN_SCHEMA_VERSION,
  CANONICAL_ENTITY_SHORTLIST_POLICY_VERSION,
  CanonicalEntityProcessorValidationError,
  EntityMemoryStoreCanonLookup,
  EntityServiceCanonicalPacketProcessor,
} from './canonical-processor'
export type {
  CanonicalEntityMemoryDraft,
  CanonicalEntityPlan,
  CanonicalEntityPlanningInput,
  CanonicalEntityPlanningPort,
  EntityCanonLookup,
  EntityCanonLookupQuery,
  EntityCanonLookupResult,
  EntityServiceCanonicalPacketProcessorOptions,
} from './canonical-processor'
export {
  CANONICAL_ENTITY_PROMPT_VERSION,
  CANONICAL_ENTITY_WORKLOAD,
  GatewayCanonicalEntityPlanner,
} from './canonical-planner'
export type { GatewayCanonicalEntityPlannerOptions } from './canonical-planner'
export { SqliteEntityPacketWorkPort } from './sqlite-entity-work-port'
export {
  ENTITY_SHADOW_OBSERVATION_SCHEMA_VERSION,
  ENTITY_SHADOW_OBSERVATION_TABLE,
  EntityShadowObservationConflictError,
  SqliteEntityShadowObservationStore,
} from './sqlite-shadow-observation-store'
export type { DurableEntityShadowObservation } from './sqlite-shadow-observation-store'
export {
  ENTITY_MEMORY_MIGRATION_VERIFICATION_SCHEMA_VERSION,
  EntityMemoryMigrationCapabilityError,
  assertEntityMemoryMigrationReady,
  verifyEntityMemoryMigration,
} from './entity-memory-migration-verifier'
export type { EntityMemoryMigrationVerificationReport } from './entity-memory-migration-verifier'
export { createSharedEntityRuntime, waitForSharedEntityShutdown } from './run-shared'
export type {
  CreateSharedEntityRuntimeOptions,
  SharedEntityCycleResult,
  SharedEntityRuntime,
  SharedEntityShutdownSignalPort,
} from './run-shared'
export {
  ENTITY_RUNTIME_HEALTH_SCHEMA_VERSION,
  AtomicEntityRuntimeHealthFile,
  EntityRuntimeHealthTracker,
  readEntityRuntimeHealthSnapshot,
  validateEntityRuntimeHealthSnapshot,
} from './entity-runtime-health'
export type {
  EntityRuntimeControlStatus,
  EntityRuntimeHealthRead,
  EntityRuntimeHealthSnapshot,
  EntityRuntimeHealthWriter,
  EntityRuntimeLifecycleState,
} from './entity-runtime-health'

export default {
  EntityService,
  ManualEntityConflictError,
  ManualEntityValidationError,
  normalizeManualEntityCommand,
  ENTITY_KNOWLEDGE_MAX_PAGE_SIZE,
  ENTITY_KNOWLEDGE_SCHEMA_VERSION,
  ENTITY_MEMORY_CHANGES_START_CURSOR,
  InvalidEntityKnowledgeCursorError,
  SupabaseEntityKnowledgeReader,
  SupabaseEntityMemoryStore,
}
