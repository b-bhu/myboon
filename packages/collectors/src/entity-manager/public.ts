import { EntityService, ManualEntityConflictError } from './entity-service'
import { ManualEntityValidationError, normalizeManualEntityCommand } from './manual-adapter'
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
  EntityMemoryPage,
  GetEntityMemoriesInput,
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

export default {
  EntityService,
  ManualEntityConflictError,
  ManualEntityValidationError,
  normalizeManualEntityCommand,
  SupabaseEntityKnowledgeReader,
  SupabaseEntityMemoryStore,
}
