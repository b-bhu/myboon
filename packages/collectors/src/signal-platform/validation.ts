import {
  EXECUTION_EVENT_SCHEMA_VERSION,
  ARTICLE_RESEARCH_PACKET_SCHEMA_VERSION,
  RESEARCH_PACKET_SCHEMA_VERSION,
  RESEARCH_WORK_SCHEMA_VERSION,
  RETRIEVED_EVIDENCE_SCHEMA_VERSION,
  SIGNAL_SCHEMA_VERSION,
  type BudgetUsage,
  type ExecutionTraceEvent,
  type FailureCategory,
  type ResearchBudget,
  type ResearchPacketV1,
  type ArticleResearchPacketV1,
  type ResearchPacket,
  type ResearchWorkItem,
  type RetrievedEvidence,
  type Signal,
} from './contracts'

export class ContractValidationError extends Error {
  readonly code = 'CONTRACT_VALIDATION_ERROR'
  readonly path: string

  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'ContractValidationError'
    this.path = path
  }
}

const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3'])
const DEPTHS = new Set(['light', 'standard', 'deep'])
const DEEP_REASONS = new Set([
  'conflicting_primary_sources',
  'insufficient_primary_evidence',
  'rendering_required_for_material_fact',
  'entity_identity_ambiguous',
  'regulatory_interpretation_required',
  'manual_analyst_request',
])
const WORK_STATUSES = new Set([
  'signal_observed', 'triage_pending', 'archived', 'deferred', 'research_pending',
  'retrieval_leased', 'deep_pending', 'deep_leased', 'synthesis_pending', 'synthesis_leased', 'research_ready',
  'entity_pending', 'entity_leased', 'complete', 'retry_wait', 'expired', 'dead_letter',
])
const FAILURE_CATEGORIES = new Set<FailureCategory>([
  'provider_unavailable', 'provider_rate_limited', 'provider_timeout',
  'provider_authentication', 'circuit_open', 'retrieval_timeout',
  'retrieval_blocked', 'retrieval_unsafe_url', 'budget_exceeded',
  'invalid_structured_output', 'schema_version_mismatch', 'permanent_source_error',
  'entity_resolution_failed', 'storage_transient', 'storage_permanent',
])
const EXECUTION_STAGES = new Set([
  'collection', 'normalization', 'triage', 'queue', 'retrieval', 'synthesis',
  'deep_research', 'entity_manager', 'memory_write',
])
const EVENT_STATUSES = new Set([
  'started', 'succeeded', 'failed', 'retry_wait', 'skipped', 'expired', 'dead_letter',
])

export function validateSignal(value: unknown): Signal {
  const record = object(value, 'signal')
  literal(record.schemaVersion, SIGNAL_SCHEMA_VERSION, 'signal.schemaVersion')
  nonEmpty(record.signalId, 'signal.signalId')
  const sourceType = oneOf(record.sourceType, ['news', 'polymarket', 'market_calendar', 'x'], 'signal.sourceType')
  const kindBySource = {
    news: ['article'],
    polymarket: ['market_event'],
    market_calendar: ['calendar_event'],
    x: ['social_thread'],
  } as const
  const contentKind = oneOf(record.contentKind, [...kindBySource[sourceType]], 'signal.contentKind')
  const content = object(record.content, 'signal.content')
  literal(
    content.schemaVersion,
    `myboon.signal_content.${contentKind}.v1`,
    'signal.content.schemaVersion',
  )
  for (const key of ['sourceId', 'title', 'idempotencyKey'] as const) nonEmpty(record[key], `signal.${key}`)
  timestamp(record.observedAt, 'signal.observedAt')
  nullableTimestamp(record.publishedAt, 'signal.publishedAt')
  nullableHttpUrl(record.canonicalUrl, 'signal.canonicalUrl')

  const media = object(record.media, 'signal.media')
  nullableString(media.imageUrl, 'signal.media.imageUrl')
  nullableString(media.attribution, 'signal.media.attribution')
  const hints = object(record.sourceHints, 'signal.sourceHints')
  stringArray(hints.entities, 'signal.sourceHints.entities')
  stringArray(hints.assets, 'signal.sourceHints.assets')
  nullableString(hints.eventId, 'signal.sourceHints.eventId')
  nullableTimestamp(hints.deadline, 'signal.sourceHints.deadline')
  const provenance = object(record.provenance, 'signal.provenance')
  nonEmpty(provenance.provider, 'signal.provenance.provider')
  nullableString(provenance.upstreamSource, 'signal.provenance.upstreamSource')
  nonEmpty(provenance.rawPayloadRef, 'signal.provenance.rawPayloadRef')
  nullableString(record.visibleSummary, 'signal.visibleSummary')
  return value as Signal
}

export function validateResearchWorkItem(value: unknown): ResearchWorkItem {
  const record = object(value, 'work')
  literal(record.schemaVersion, RESEARCH_WORK_SCHEMA_VERSION, 'work.schemaVersion')
  for (const key of ['workId', 'signalId', 'policyVersion', 'traceId'] as const) {
    nonEmpty(record[key], `work.${key}`)
  }
  oneOf(record.sourceType, ['news', 'polymarket', 'market_calendar', 'x'], 'work.sourceType')
  const depth = oneOf(record.researchDepth, [...DEPTHS], 'work.researchDepth')
  if (record.deepReason !== null) oneOf(record.deepReason, [...DEEP_REASONS], 'work.deepReason')
  if (depth === 'deep' && record.deepReason === null) {
    throw new ContractValidationError('work.deepReason', 'is required for deep research')
  }
  if (record.deepEscalation !== undefined && record.deepEscalation !== null) {
    validateDeepEscalation(
      record.deepEscalation, 'work.deepEscalation', record.deepReason, record.policyVersion,
    )
  }
  // Legacy adapters may omit the additive field. New triage-backed admissions
  // are identifiable by their durable decision link and must never omit it.
  if (depth === 'deep' && record.triageDecisionId !== undefined && record.deepEscalation == null) {
    throw new ContractValidationError('work.deepEscalation', 'is required for triage-backed deep research')
  }
  if (depth !== 'deep' && record.deepEscalation != null) {
    throw new ContractValidationError('work.deepEscalation', 'must be null unless researchDepth is deep')
  }
  oneOf(record.priorityClass, [...PRIORITIES], 'work.priorityClass')
  boundedNumber(record.priorityScore, 'work.priorityScore', 0, 1)
  timestamp(record.freshnessDeadline, 'work.freshnessDeadline')
  literal(record.researchContractVersion, RESEARCH_PACKET_SCHEMA_VERSION, 'work.researchContractVersion')
  validateRetrievalPlan(record.retrievalPlan, 'work.retrievalPlan')
  validateResearchBudget(record.budget, 'work.budget')
  oneOf(record.status, [...WORK_STATUSES], 'work.status')
  integer(record.attemptCount, 'work.attemptCount', 0)
  nullableTimestamp(record.nextAttemptAt, 'work.nextAttemptAt')
  if (record.retryTargetStatus !== undefined && record.retryTargetStatus !== null) {
    oneOf(record.retryTargetStatus, ['research_pending', 'deep_pending', 'synthesis_pending', 'entity_pending'], 'work.retryTargetStatus')
  }
  if (record.status === 'retry_wait' && record.retryTargetStatus == null) {
    throw new ContractValidationError('work.retryTargetStatus', 'is required while work is in retry_wait')
  }
  if (record.status !== 'retry_wait' && record.retryTargetStatus != null) {
    throw new ContractValidationError('work.retryTargetStatus', 'must be null outside retry_wait')
  }
  nullableString(record.leaseOwner, 'work.leaseOwner')
  nullableString(record.leaseId, 'work.leaseId')
  nullableTimestamp(record.leaseExpiresAt, 'work.leaseExpiresAt')
  nullableFailure(record.failureCategory, 'work.failureCategory')
  nullableString(record.failureDetail, 'work.failureDetail')
  timestamp(record.createdAt, 'work.createdAt')
  timestamp(record.updatedAt, 'work.updatedAt')
  return value as ResearchWorkItem
}

function validateDeepEscalation(
  value: unknown,
  path: string,
  expectedReason: unknown,
  expectedPolicyVersion: unknown,
): void {
  const escalation = object(value, path)
  const reason = oneOf(escalation.reason, [...DEEP_REASONS], `${path}.reason`)
  if (reason !== expectedReason) {
    throw new ContractValidationError(`${path}.reason`, 'must match work.deepReason')
  }
  stringArray(escalation.supportingEvidenceRefs, `${path}.supportingEvidenceRefs`)
  if ((escalation.supportingEvidenceRefs as string[]).length === 0) {
    throw new ContractValidationError(`${path}.supportingEvidenceRefs`, 'must contain supporting evidence')
  }
  if (new Set(escalation.supportingEvidenceRefs as string[]).size
    !== (escalation.supportingEvidenceRefs as string[]).length) {
    throw new ContractValidationError(`${path}.supportingEvidenceRefs`, 'must not contain duplicates')
  }
  for (const [index, ref] of (escalation.supportingEvidenceRefs as string[]).entries()) {
    nonEmpty(ref, `${path}.supportingEvidenceRefs[${index}]`)
  }
  nonEmpty(escalation.unresolvedQuestion, `${path}.unresolvedQuestion`)
  nonEmpty(escalation.policyVersion, `${path}.policyVersion`)
  if (escalation.policyVersion !== expectedPolicyVersion) {
    throw new ContractValidationError(`${path}.policyVersion`, 'must match work.policyVersion')
  }
  nonEmpty(escalation.policyRule, `${path}.policyRule`)
}

export function validateRetrievedEvidence(value: unknown): RetrievedEvidence {
  const record = object(value, 'evidence')
  literal(record.schemaVersion, RETRIEVED_EVIDENCE_SCHEMA_VERSION, 'evidence.schemaVersion')
  for (const key of ['evidenceId', 'workId', 'requestedUrl'] as const) nonEmpty(record[key], `evidence.${key}`)
  httpUrl(record.requestedUrl, 'evidence.requestedUrl')
  httpUrl(record.finalUrl, 'evidence.finalUrl')
  oneOf(record.authority, ['source_url', 'source_hint', 'search_connector'], 'evidence.authority')
  nonEmpty(record.authorityId, 'evidence.authorityId')
  nonEmpty(record.contentHash, 'evidence.contentHash')
  nullableString(record.contentType, 'evidence.contentType')
  integer(record.httpStatus, 'evidence.httpStatus', 100)
  oneOf(record.retrievalMethod, ['safe_http', 'browser'], 'evidence.retrievalMethod')
  timestamp(record.retrievedAt, 'evidence.retrievedAt')
  string(record.text, 'evidence.text')
  boolean(record.truncated, 'evidence.truncated')
  integer(record.byteLength, 'evidence.byteLength', 0)
  return value as RetrievedEvidence
}

/** Runtime packet kind is explicit; legacy consumers narrow through `validateLegacyResearchPacket`. */
export function validateResearchPacket(value: ResearchPacketV1): ResearchPacketV1
export function validateResearchPacket(value: ArticleResearchPacketV1): ArticleResearchPacketV1
export function validateResearchPacket(value: unknown): ResearchPacket
export function validateResearchPacket(value: unknown): ResearchPacket {
  const record = object(value, 'packet')
  if (record.schemaVersion === ARTICLE_RESEARCH_PACKET_SCHEMA_VERSION) return validateArticleResearchPacket(record)
  literal(record.schemaVersion, RESEARCH_PACKET_SCHEMA_VERSION, 'packet.schemaVersion')
  literal(record.researchContractVersion, RESEARCH_PACKET_SCHEMA_VERSION, 'packet.researchContractVersion')
  for (const key of ['packetId', 'workId', 'signalId'] as const) nonEmpty(record[key], `packet.${key}`)
  oneOf(record.sourceType, ['news', 'polymarket', 'market_calendar', 'x'], 'packet.sourceType')
  timestamp(record.observedAt, 'packet.observedAt')
  timestamp(record.createdAt, 'packet.createdAt')
  const sourceSignal = object(record.sourceSignal, 'packet.sourceSignal')
  nonEmpty(sourceSignal.title, 'packet.sourceSignal.title')
  nullableHttpUrl(sourceSignal.canonicalUrl, 'packet.sourceSignal.canonicalUrl')
  nullableTimestamp(sourceSignal.publishedAt, 'packet.sourceSignal.publishedAt')
  const provenance = object(sourceSignal.provenance, 'packet.sourceSignal.provenance')
  nonEmpty(provenance.provider, 'packet.sourceSignal.provenance.provider')
  nullableString(provenance.upstreamSource, 'packet.sourceSignal.provenance.upstreamSource')
  nonEmpty(provenance.rawPayloadRef, 'packet.sourceSignal.provenance.rawPayloadRef')

  objectArray(record.claims, 'packet.claims', (item, path) => {
    nonEmpty(item.claimId, `${path}.claimId`)
    nonEmpty(item.claim, `${path}.claim`)
    nullableString(item.attributedTo, `${path}.attributedTo`)
    stringArray(item.evidenceRefs, `${path}.evidenceRefs`)
  })
  objectArray(record.verifiedFacts, 'packet.verifiedFacts', (item, path) => {
    nonEmpty(item.fact, `${path}.fact`)
    stringArray(item.evidenceRefs, `${path}.evidenceRefs`)
  })
  objectArray(record.unresolvedClaims, 'packet.unresolvedClaims', (item, path) => {
    nonEmpty(item.claim, `${path}.claim`)
    nonEmpty(item.reason, `${path}.reason`)
    stringArray(item.evidenceRefs, `${path}.evidenceRefs`)
  })
  objectArray(record.evidence, 'packet.evidence', (item, path) => {
    nonEmpty(item.evidenceId, `${path}.evidenceId`)
    nonEmpty(item.title, `${path}.title`)
    httpUrl(item.url, `${path}.url`)
    nullableString(item.sourceType, `${path}.sourceType`)
    nullableTimestamp(item.observedAt, `${path}.observedAt`)
    nullableString(item.note, `${path}.note`)
  })
  objectArray(record.entityHints, 'packet.entityHints', (item, path) => {
    nonEmpty(item.name, `${path}.name`)
    nullableString(item.type, `${path}.type`)
    nullableString(item.role, `${path}.role`)
    stringArray(item.aliases, `${path}.aliases`)
    nullableString(item.source, `${path}.source`)
    stringArray(item.claimRefs, `${path}.claimRefs`)
    stringArray(item.evidenceRefs, `${path}.evidenceRefs`)
  })
  stringArray(record.limitations, 'packet.limitations')
  stringArray(record.openQuestions, 'packet.openQuestions')
  oneOf(record.completion, ['complete', 'partial', 'failed'], 'packet.completion')
  validateBudgetUsage(record.budgetUsed, 'packet.budgetUsed')
  const execution = object(record.execution, 'packet.execution')
  for (const key of ['provider', 'model', 'promptVersion', 'policyVersion', 'traceId'] as const) {
    nonEmpty(execution[key], `packet.execution.${key}`)
  }
  nullableString(execution.fallbackProvider, 'packet.execution.fallbackProvider')
  nullableString(execution.fallbackModel, 'packet.execution.fallbackModel')
  boolean(execution.fallbackUsed, 'packet.execution.fallbackUsed')
  integer(execution.attempt, 'packet.execution.attempt', 0)
  const packetHasConfiguredProvider = execution.configuredPrimaryProvider !== undefined
  const packetHasConfiguredModel = execution.configuredPrimaryModel !== undefined
  if (packetHasConfiguredProvider !== packetHasConfiguredModel) {
    throw new ContractValidationError('packet.execution.configuredPrimaryProvider', 'provider and model must be present together')
  }
  if (packetHasConfiguredProvider) {
    nonEmpty(execution.configuredPrimaryProvider, 'packet.execution.configuredPrimaryProvider')
    nonEmpty(execution.configuredPrimaryModel, 'packet.execution.configuredPrimaryModel')
  }
  if (execution.fallbackReason !== undefined) {
    nullableFailure(execution.fallbackReason, 'packet.execution.fallbackReason')
  }
  if (execution.outputSchemaValid !== undefined && execution.outputSchemaValid !== null) {
    boolean(execution.outputSchemaValid, 'packet.execution.outputSchemaValid')
  }
  return value as ResearchPacketV1
}

/** Legacy claim/evidence consumers must opt in explicitly. */
export function validateLegacyResearchPacket(value: unknown): ResearchPacketV1 {
  const packet = validateResearchPacket(value)
  if (packet.schemaVersion === ARTICLE_RESEARCH_PACKET_SCHEMA_VERSION) {
    throw new ContractValidationError('packet.schemaVersion', 'article packet is not valid for a legacy claim/evidence consumer')
  }
  return packet
}

/**
 * The article handoff is intentionally not normalized through the older
 * claim/evidence schema.  Legacy packets still take the branch above.
 */
function validateArticleResearchPacket(record: Record<string, unknown>): ArticleResearchPacketV1 {
  literal(record.schemaVersion, ARTICLE_RESEARCH_PACKET_SCHEMA_VERSION, 'packet.schemaVersion')
  literal(record.packetKind, 'article', 'packet.packetKind')
  for (const key of ['packetId', 'workId', 'signalId'] as const) nonEmpty(record[key], `packet.${key}`)
  oneOf(record.sourceType, ['news', 'polymarket', 'market_calendar', 'x'], 'packet.sourceType')
  timestamp(record.observedAt, 'packet.observedAt')
  timestamp(record.createdAt, 'packet.createdAt')
  literal(record.researchContractVersion, RESEARCH_PACKET_SCHEMA_VERSION, 'packet.researchContractVersion')
  const sourceSignal = object(record.sourceSignal, 'packet.sourceSignal')
  for (const key of ['sourceId', 'title', 'canonicalUrl'] as const) nonEmpty(sourceSignal[key], `packet.sourceSignal.${key}`)
  httpUrl(sourceSignal.canonicalUrl, 'packet.sourceSignal.canonicalUrl')
  if (sourceSignal.originalCanonicalUrl !== undefined) nullableHttpUrl(sourceSignal.originalCanonicalUrl, 'packet.sourceSignal.originalCanonicalUrl')
  if (sourceSignal.capturedUrl !== undefined) httpUrl(sourceSignal.capturedUrl, 'packet.sourceSignal.capturedUrl')
  nullableTimestamp(sourceSignal.publishedAt, 'packet.sourceSignal.publishedAt')
  const provenance = object(sourceSignal.provenance, 'packet.sourceSignal.provenance')
  nonEmpty(provenance.provider, 'packet.sourceSignal.provenance.provider')
  nullableString(provenance.upstreamSource, 'packet.sourceSignal.provenance.upstreamSource')
  nonEmpty(provenance.rawPayloadRef, 'packet.sourceSignal.provenance.rawPayloadRef')
  const article = object(record.article, 'packet.article')
  for (const key of ['title', 'timelineSummary', 'sourceUrl', 'capturedText', 'capturedAt', 'contentHash'] as const) {
    nonEmpty(article[key], `packet.article.${key}`)
  }
  nullableString(article.body, 'packet.article.body')
  nullableTimestamp(article.eventAt, 'packet.article.eventAt')
  httpUrl(article.sourceUrl, 'packet.article.sourceUrl')
  timestamp(article.capturedAt, 'packet.article.capturedAt')
  boolean(article.truncated, 'packet.article.truncated')
  let duplicateTargetCount = 0
  let primaryDuplicateTargetCount = 0
  objectArray(record.memberships, 'packet.memberships', (item, path) => {
    nullableString(item.entityId, `${path}.entityId`)
    oneOf(item.placementDisposition, ['selected', 'no_match', 'uncertain'], `${path}.placementDisposition`)
    nonEmpty(item.name, `${path}.name`)
    nullableString(item.type, `${path}.type`)
    stringArray(item.aliases, `${path}.aliases`)
    nullableString(item.summary, `${path}.summary`)
    object(item.scope, `${path}.scope`)
    if (item.creationProposal !== null) {
      const proposal = object(item.creationProposal, `${path}.creationProposal`)
      nonEmpty(proposal.name, `${path}.creationProposal.name`)
      nonEmpty(proposal.type, `${path}.creationProposal.type`)
      stringArray(proposal.aliases, `${path}.creationProposal.aliases`)
      nonEmpty(proposal.summary, `${path}.creationProposal.summary`)
      object(proposal.scope, `${path}.creationProposal.scope`)
    }
    if (item.creationDecision !== null) validateArticleChoice(item.creationDecision, `${path}.creationDecision`)
    oneOf(item.role, ['primary', 'related'], `${path}.role`)
    validateArticleChoice(item.placement, `${path}.placement`)
    const placement = object(item.placement, `${path}.placement`)
    if (item.relationship !== null) oneOf(item.relationship, ['duplicate', 'direct_continuation', 'related_story_branch', 'same_topic_only', 'unrelated', 'uncertain'], `${path}.relationship`)
    if (item.relationshipDecision !== null) validateArticleChoice(item.relationshipDecision, `${path}.relationshipDecision`)
    if (item.priorItemDecision !== null) validateArticleChoice(item.priorItemDecision, `${path}.priorItemDecision`)
    nullableString(item.priorItemId, `${path}.priorItemId`)
    if (item.priorItemSource !== null) oneOf(item.priorItemSource, ['legacy', 'managed'], `${path}.priorItemSource`)
    if ((item.priorItemId === null) !== (item.priorItemSource === null)) {
      throw new ContractValidationError(path, 'prior item identity and source must be present together')
    }
    if (item.duplicateTarget !== null) {
      const target = object(item.duplicateTarget, `${path}.duplicateTarget`)
      nonEmpty(target.itemId, `${path}.duplicateTarget.itemId`)
      oneOf(target.source, ['legacy', 'managed'], `${path}.duplicateTarget.source`)
      nonEmpty(target.entityId, `${path}.duplicateTarget.entityId`)
      if (item.relationship !== 'duplicate') throw new ContractValidationError(path, 'duplicateTarget requires Jev duplicate relationship')
      duplicateTargetCount += 1
      if (item.role === 'primary') primaryDuplicateTargetCount += 1
    }
    if (item.entityId === null && item.placementDisposition === 'selected') {
      throw new ContractValidationError(path, 'selected placement requires an existing entity ID')
    }
    if (item.entityId === null && item.placementDisposition === 'no_match' && item.creationProposal === null) {
      throw new ContractValidationError(path, 'no_match placement requires a bounded creation proposal')
    }
    if (item.entityId === null && item.placementDisposition === 'no_match' && placement.choice !== 'no_match') {
      throw new ContractValidationError(path, 'no_match membership must retain Jev no_match placement')
    }
    if (item.entityId !== null && item.role === 'primary' && placement.choice !== item.entityId) {
      throw new ContractValidationError(path, 'primary membership must retain the selected entity placement choice')
    }
    if (item.entityId !== null && item.role === 'related' && placement.choice !== 'related') {
      throw new ContractValidationError(path, 'related membership must retain its independent related Choice')
    }
    if (item.entityId !== null && item.creationProposal !== null) {
      throw new ContractValidationError(path, 'existing entity membership must not request creation')
    }
    if ((item.creationProposal === null) !== (item.creationDecision === null)) {
      throw new ContractValidationError(path, 'creation proposal and its Jev validation decision must be present together')
    }
    if (item.creationDecision !== null && object(item.creationDecision, `${path}.creationDecision`).choice !== 'accept') {
      throw new ContractValidationError(path, 'saved creation proposal requires Jev acceptance')
    }
    if ((item.relationship === null) !== (item.relationshipDecision === null)) {
      throw new ContractValidationError(path, 'relationship and its Jev decision must be present together')
    }
    if ((item.relationship === null) !== (item.priorItemDecision === null)) {
      throw new ContractValidationError(path, 'relationship and its prior-item Jev decision must be present together')
    }
    if (item.relationship === 'duplicate' && item.duplicateTarget === null) {
      throw new ContractValidationError(path, 'duplicate relationship requires a durable duplicate target')
    }
    if ((item.relationship === 'direct_continuation' || item.relationship === 'related_story_branch')
      && item.priorItemId === null) {
      throw new ContractValidationError(path, 'continuation and related branch relationships require a durable prior item')
    }
  })
  if (!Array.isArray(record.memberships) || record.memberships.length === 0) {
    throw new ContractValidationError('packet.memberships', 'article packet requires at least one prepared membership')
  }
  validateArticleChoice(record.novelty, 'packet.novelty')
  const novelty = object(record.novelty, 'packet.novelty')
  // Reuse is only safe when Jev's separately retained novelty judgment agrees
  // with an exact durable duplicate target. A related-only duplicate may still
  // accompany a new primary development and must not suppress it.
  if (duplicateTargetCount === 0 && novelty.choice === 'already_known') {
    throw new ContractValidationError('packet.novelty', 'already_known requires an exact durable duplicate target')
  }
  if (duplicateTargetCount > 0 && novelty.choice === 'uncertain') {
    throw new ContractValidationError('packet.novelty', 'an exact duplicate target with uncertain novelty must be held, not persisted')
  }
  if (primaryDuplicateTargetCount > 0 && (novelty.choice === 'new_information' || novelty.choice === 'contradicts_prior')) {
    throw new ContractValidationError('packet.novelty', 'primary exact duplicate conflicts with new or contradictory novelty')
  }
  stringArray(record.limitations, 'packet.limitations')
  stringArray(record.openQuestions, 'packet.openQuestions')
  oneOf(record.completion, ['complete', 'partial', 'failed'], 'packet.completion')
  validateBudgetUsage(record.budgetUsed, 'packet.budgetUsed')
  validateExecution(record.execution, 'packet.execution')
  return record as ArticleResearchPacketV1
}

function validateArticleChoice(value: unknown, path: string): void {
  const decision = object(value, path)
  nonEmpty(decision.choice, `${path}.choice`)
  const probabilities = object(decision.probabilities, `${path}.probabilities`)
  const keys = Object.keys(probabilities)
  if (keys.length === 0) throw new ContractValidationError(`${path}.probabilities`, 'must contain declared Choice keys')
  if (!Object.prototype.hasOwnProperty.call(probabilities, decision.choice)) {
    throw new ContractValidationError(`${path}.choice`, 'must be a declared probabilities key')
  }
  let total = 0
  for (const [key, probability] of Object.entries(probabilities)) {
    nonEmpty(key, `${path}.probabilities key`)
    boundedNumber(probability, `${path}.probabilities.${key}`, 0, 1)
    total += Number(probability)
  }
  if (Math.abs(total - 1) > 0.02) throw new ContractValidationError(`${path}.probabilities`, 'must sum to one')
  boundedNumber(decision.confidence, `${path}.confidence`, 0, 1)
  nonEmpty(decision.decisionId, `${path}.decisionId`)
  nonEmpty(decision.decisionVersion, `${path}.decisionVersion`)
}

function validateExecution(value: unknown, path: string): void {
  const execution = object(value, path)
  for (const key of ['provider', 'model', 'promptVersion', 'policyVersion', 'traceId'] as const) {
    nonEmpty(execution[key], `${path}.${key}`)
  }
  nullableString(execution.fallbackProvider, `${path}.fallbackProvider`)
  nullableString(execution.fallbackModel, `${path}.fallbackModel`)
  boolean(execution.fallbackUsed, `${path}.fallbackUsed`)
  integer(execution.attempt, `${path}.attempt`, 0)
  const hasConfiguredProvider = execution.configuredPrimaryProvider !== undefined
  const hasConfiguredModel = execution.configuredPrimaryModel !== undefined
  if (hasConfiguredProvider !== hasConfiguredModel) {
    throw new ContractValidationError(`${path}.configuredPrimaryProvider`, 'provider and model must be present together')
  }
  if (hasConfiguredProvider) {
    nonEmpty(execution.configuredPrimaryProvider, `${path}.configuredPrimaryProvider`)
    nonEmpty(execution.configuredPrimaryModel, `${path}.configuredPrimaryModel`)
  }
  if (execution.fallbackReason !== undefined) nullableFailure(execution.fallbackReason, `${path}.fallbackReason`)
  if (execution.outputSchemaValid !== undefined && execution.outputSchemaValid !== null) {
    boolean(execution.outputSchemaValid, `${path}.outputSchemaValid`)
  }
}

export function validateExecutionTraceEvent(value: unknown): ExecutionTraceEvent {
  const record = object(value, 'event')
  literal(record.schemaVersion, EXECUTION_EVENT_SCHEMA_VERSION, 'event.schemaVersion')
  for (const key of ['eventId', 'traceId'] as const) nonEmpty(record[key], `event.${key}`)
  for (const key of ['signalId', 'workId', 'packetId'] as const) nullableString(record[key], `event.${key}`)
  oneOf(record.sourceType, ['news', 'polymarket', 'market_calendar', 'x'], 'event.sourceType')
  oneOf(record.stage, [...EXECUTION_STAGES], 'event.stage')
  integer(record.attempt, 'event.attempt', 0)
  timestamp(record.startedAt, 'event.startedAt')
  nullableTimestamp(record.finishedAt, 'event.finishedAt')
  oneOf(record.status, [...EVENT_STATUSES], 'event.status')
  nullableFailure(record.failureCategory, 'event.failureCategory')
  nullableString(record.failureDetail, 'event.failureDetail')
  for (const key of ['queueWaitMs', 'wallTimeMs', 'providerCalls', 'repairCalls', 'inputTokens', 'outputTokens', 'toolCalls'] as const) {
    integer(record[key], `event.${key}`, 0)
  }
  for (const key of ['provider', 'model', 'fallbackProvider', 'fallbackModel', 'promptVersion', 'policyVersion', 'researchContractVersion'] as const) {
    nullableString(record[key], `event.${key}`)
  }
  boolean(record.fallbackUsed, 'event.fallbackUsed')
  const eventHasConfiguredProvider = record.configuredPrimaryProvider !== undefined
  const eventHasConfiguredModel = record.configuredPrimaryModel !== undefined
  if (eventHasConfiguredProvider !== eventHasConfiguredModel) {
    throw new ContractValidationError('event.configuredPrimaryProvider', 'provider and model must be present together')
  }
  if (eventHasConfiguredProvider) {
    nullableString(record.configuredPrimaryProvider, 'event.configuredPrimaryProvider')
    nullableString(record.configuredPrimaryModel, 'event.configuredPrimaryModel')
    if ((record.configuredPrimaryProvider === null) !== (record.configuredPrimaryModel === null)) {
      throw new ContractValidationError('event.configuredPrimaryProvider', 'provider and model must both be null or both be strings')
    }
  }
  if (record.fallbackReason !== undefined) nullableFailure(record.fallbackReason, 'event.fallbackReason')
  if (record.outputSchemaValid !== undefined && record.outputSchemaValid !== null) {
    boolean(record.outputSchemaValid, 'event.outputSchemaValid')
  }
  if (record.researchReadinessOutcome !== undefined && record.researchReadinessOutcome !== null) {
    oneOf(record.researchReadinessOutcome, [
      'ready_for_entity', 'resolved_without_new_item', 'blocked', 'failed', 'readiness_unknown',
    ], 'event.researchReadinessOutcome')
  }
  for (const key of ['researchReadinessId', 'researchReadinessPolicyVersion'] as const) {
    if (record[key] !== undefined) nullableString(record[key], `event.${key}`)
  }
  boolean(record.budgetExceeded, 'event.budgetExceeded')
  if (record.costUsdMicros !== undefined && record.costUsdMicros !== null) {
    if (typeof record.costUsdMicros !== 'number'
      || !Number.isSafeInteger(record.costUsdMicros) || record.costUsdMicros < 0) {
      throw new ContractValidationError('event.costUsdMicros', 'must be a non-negative safe integer or null')
    }
  }
  timestamp(record.createdAt, 'event.createdAt')
  if (record.status !== 'started' && record.finishedAt === null) {
    throw new ContractValidationError('event.finishedAt', 'is required for a finished event')
  }
  // v1 is explicitly extensible. Normalize events written by pre-AC20
  // producers/read from existing ledgers so downstream Entity and operator
  // consumers observe explicit unknowns rather than guessed provenance.
  if (record.configuredPrimaryProvider === undefined
    || record.configuredPrimaryModel === undefined
    || record.fallbackReason === undefined
    || record.outputSchemaValid === undefined || record.costUsdMicros === undefined
    || record.researchReadinessId === undefined
    || record.researchReadinessOutcome === undefined
    || record.researchReadinessPolicyVersion === undefined) {
    return {
      ...record,
      configuredPrimaryProvider: record.configuredPrimaryProvider ?? null,
      configuredPrimaryModel: record.configuredPrimaryModel ?? null,
      fallbackReason: record.fallbackReason ?? null,
      outputSchemaValid: record.outputSchemaValid ?? null,
      costUsdMicros: record.costUsdMicros ?? null,
      researchReadinessId: record.researchReadinessId ?? null,
      researchReadinessOutcome: record.researchReadinessOutcome ?? null,
      researchReadinessPolicyVersion: record.researchReadinessPolicyVersion ?? null,
    } as unknown as ExecutionTraceEvent
  }
  return value as ExecutionTraceEvent
}

function validateRetrievalPlan(value: unknown, path: string): void {
  const record = object(value, path)
  nullableHttpUrl(record.sourceUrl, `${path}.sourceUrl`)
  stringArray(record.allowedDomains, `${path}.allowedDomains`)
  integer(record.maxExternalSources, `${path}.maxExternalSources`, 0)
}

function validateResearchBudget(value: unknown, path: string): asserts value is ResearchBudget {
  const record = object(value, path)
  for (const key of ['maxProviderCalls', 'maxRepairCalls', 'maxToolCalls', 'maxWallTimeMs'] as const) {
    integer(record[key], `${path}.${key}`, 0)
  }
}

function validateBudgetUsage(value: unknown, path: string): asserts value is BudgetUsage {
  const record = object(value, path)
  for (const key of ['providerCalls', 'repairCalls', 'inputTokens', 'outputTokens', 'toolCalls', 'wallTimeMs'] as const) {
    integer(record[key], `${path}.${key}`, 0)
  }
  boolean(record.budgetExceeded, `${path}.budgetExceeded`)
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractValidationError(path, 'must be an object')
  }
  return value as Record<string, unknown>
}

function objectArray(
  value: unknown,
  path: string,
  validate: (record: Record<string, unknown>, path: string) => void,
): void {
  if (!Array.isArray(value)) throw new ContractValidationError(path, 'must be an array')
  value.forEach((item, index) => validate(object(item, `${path}[${index}]`), `${path}[${index}]`))
}

function nonEmpty(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new ContractValidationError(path, 'must be a non-empty string')
}

function nullableString(value: unknown, path: string): void {
  if (value !== null && typeof value !== 'string') throw new ContractValidationError(path, 'must be a string or null')
}

function string(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string') throw new ContractValidationError(path, 'must be a string')
}

function stringArray(value: unknown, path: string): void {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new ContractValidationError(path, 'must be a string array')
  }
}

function timestamp(value: unknown, path: string): asserts value is string {
  nonEmpty(value, path)
  if (!Number.isFinite(Date.parse(value))) throw new ContractValidationError(path, 'must be a valid timestamp')
}

function nullableTimestamp(value: unknown, path: string): void {
  if (value !== null) timestamp(value, path)
}

function httpUrl(value: unknown, path: string): void {
  nonEmpty(value, path)
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new ContractValidationError(path, 'must be a valid URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ContractValidationError(path, 'must use http or https')
  }
}

function nullableHttpUrl(value: unknown, path: string): void {
  if (value !== null) httpUrl(value, path)
}

function integer(value: unknown, path: string, minimum: number): void {
  if (!Number.isInteger(value) || Number(value) < minimum) {
    throw new ContractValidationError(path, `must be an integer >= ${minimum}`)
  }
}

function boundedNumber(value: unknown, path: string, minimum: number, maximum: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ContractValidationError(path, `must be between ${minimum} and ${maximum}`)
  }
}

function boolean(value: unknown, path: string): void {
  if (typeof value !== 'boolean') throw new ContractValidationError(path, 'must be boolean')
}

function literal(value: unknown, expected: string, path: string): void {
  if (value !== expected) {
    throw new ContractValidationError(path, `unsupported version; expected ${expected}`)
  }
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ContractValidationError(path, `must be one of ${allowed.join(', ')}`)
  }
  return value as T
}

function nullableFailure(value: unknown, path: string): void {
  if (value !== null && (typeof value !== 'string' || !FAILURE_CATEGORIES.has(value as FailureCategory))) {
    throw new ContractValidationError(path, 'must be a known failure category or null')
  }
}

export const __validationTesting = {
  FAILURE_CATEGORIES,
  WORK_STATUSES,
}
