export { ResearchEngine, type ResearchEngineOptions } from './engine'
export {
  DeterministicRetriever,
  RetrievalPlanError,
  isEvidenceReusable,
} from './deterministic-retrieval'
export type {
  ApprovedRetrievalUrl,
  DeterministicRetrievalPlan,
  EvidenceFreshnessPolicy,
  EvidenceReuseContext,
  RetrievalBatch,
  RetrievalFailure,
  RetrievalFailureCategory,
  RetrievalMethod,
  RetrievalUrlAuthority,
  RetrievedEvidenceArtifact,
} from './deterministic-retrieval'
export type {
  ResearchAnswerSpec,
  ResearchConclusion,
  ResearchEvidence,
  ResearchOutcome,
  ResearchTask,
  ResearchVerifiedFact,
} from './types'
export {
  StructuredResearchSynthesizer,
  deterministicPacketId,
} from './structured-synthesizer'
export {
  ResearchDepthFilteredScheduler,
  SHARED_RESEARCH_ENV,
  createLiveSharedResearchRuntime,
  loadSharedResearchRunnerConfig,
  runSharedResearchLoop,
} from './run-shared-research'
export {
  AtomicResearchRuntimeStatusFile,
  RESEARCH_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
  ResearchRuntimeDrainTimeoutError,
  awaitDrainWithin,
  readResearchRuntimeStatusSnapshot,
} from './research-runtime-lifecycle'
export type {
  ResearchRuntimeLifecycleState,
  ResearchRuntimeRecoverySnapshot,
  ResearchRuntimeStatusRead,
  ResearchRuntimeStatusSnapshot,
  ResearchRuntimeStatusWriter,
} from './research-runtime-lifecycle'
export type {
  CreateLiveSharedResearchRuntimeOptions,
  RunSharedResearchOptions,
  SharedResearchRunnerConfig,
  SharedResearchRunnerCycleResult,
  SharedResearchRunnerRuntime,
  SharedResearchRuntimeStatus,
} from './run-shared-research'
export {
  ResearchShadowEvaluator,
  SHADOW_RESEARCH_EVALUATOR_VERSION,
  SHADOW_RESEARCH_RESULT_SCHEMA_VERSION,
  shadowResearchEvaluationId,
  validateShadowResearchResult,
} from './shadow-evaluator'
export type {
  ResearchShadowEvaluatorClock,
  ResearchShadowEvaluatorOptions,
  ShadowEvaluationOutcome,
  ShadowResearchResult,
  ShadowResearchResultStore,
  ShadowResearchSkipReason,
  ShadowResearchSourcePort,
} from './shadow-evaluator'
export { BoundedStandardSearch, SearchConnectorRegistry } from './search-connector'
export {
  EVIDENCE_REUSE_CONTEXT_SCHEMA_VERSION,
  WORK_CONTRACT_EVIDENCE_REUSE_POLICY_VERSION,
  WorkContractEvidenceReusePolicy,
  sourceMaterialHash,
  withEvidenceReuseContext,
} from './evidence-reuse-policy'
export type {
  CurrentEvidenceReuseState,
  EvidenceReuseDecision,
  EvidenceReusePolicyInput,
  EvidenceReusePolicyPort,
  PersistedEvidenceReuseContext,
  WorkContractEvidenceReusePolicyOptions,
} from './evidence-reuse-policy'
export type {
  RegisteredSearchConnector,
  SearchConnectorResult,
  StandardSearchPlan,
  StandardSearchPolicy,
} from './search-connector'
export {
  STANDARD_SEARCH_ENV,
  createConfiguredStandardSearch,
  loadStandardSearchConfiguration,
  standardSearchStatus,
} from './standard-search-configuration'
export type {
  RegisteredSearchConnectorFactories,
  RegisteredSearchConnectorFactory,
  StandardSearchConfiguration,
  StandardSearchStatusSnapshot,
} from './standard-search-configuration'
export {
  SharedResearchWorker,
  SharedResearchWorkerConfigurationError,
  buildRetrievalManifest,
  buildRetrievalPlan,
  buildStandardSearchQueries,
  retrievalPlanIdentity,
} from './shared-worker'
export {
  NO_RESEARCH_ENTITY_ACTION,
  RESEARCH_READINESS_ASSESSOR_ID,
  RESEARCH_READINESS_POLICY_VERSION,
  RESEARCH_READINESS_SCHEMA_VERSION,
  assessResearchReadiness,
  createBlockedReadiness,
  createReadinessUnknownReadiness,
  createResolvedWithoutNewItemReadiness,
  isNonClaimableReadiness,
  owesResearchEntityAction,
  researchEntityActionId,
  researchHandoffEntityClaim,
  researchHandoffTerminalStatus,
  researchHandoffWorkStatus,
  researchReadinessId,
  validateResearchReadiness,
  validateResearchReadinessLinkage,
} from '../signal-platform/research-readiness'
export type {
  ResearchAttributionCoverage,
  ResearchContributionCoverage,
  ResearchEntityAction,
  ResearchEntityActionKind,
  ResearchHandoffRetryPolicy,
  ResearchReadinessAssessmentInput,
  ResearchReadinessOutcome,
  ResearchReadinessV1,
} from '../signal-platform/research-readiness'
export {
  RETRIEVAL_MANIFEST_AUTHOR_ID,
  RETRIEVAL_MANIFEST_POLICY_VERSION,
  RETRIEVAL_MANIFEST_SCHEMA_VERSION,
  assessRetrievalManifest,
  retrievalManifestHoldFailure,
  retrievalManifestId,
  retrievalManifestMayProceed,
  retrievalPlanDigest,
  retrievalPlanId,
  validateRetrievalManifest,
  validateRetrievalManifestLinkage,
} from '../signal-platform/retrieval-manifest'
export type {
  RetrievalCapture,
  RetrievalManifestDecision,
  RetrievalManifestInput,
  RetrievalManifestSource,
  RetrievalManifestV1,
  RetrievalPlanIdentityInput,
  RetrievalPlannedSource,
  RetrievalSkipReason,
  RetrievalSourceFailure,
} from '../signal-platform/retrieval-manifest'
export type {
  DeepResearchPort,
  ResearchRetrievalLimits,
  ResearchExecutionLedgerPort,
  ResearchWorkerStage,
  SharedResearchRunOutcome,
  SharedResearchSchedulerPort,
  SharedResearchWorkerMode,
  SharedResearchWorkerOptions,
  SharedResearchWorkerOwnership,
  SharedResearchWorkPort,
  SharedWorkerClock,
  StageReadinessPort,
  StageReadinessDecision,
  StandardResearchSearchPort,
} from './shared-worker'
export type {
  StructuredResearchSynthesizerOptions,
  StructuredSynthesisBody,
  StructuredSynthesisClaim,
  StructuredSynthesisEntityHint,
  StructuredSynthesisGateway,
  StructuredSynthesisInput,
  StructuredSynthesisUnresolvedClaim,
  StructuredSynthesisVerifiedFact,
} from './structured-synthesizer'
