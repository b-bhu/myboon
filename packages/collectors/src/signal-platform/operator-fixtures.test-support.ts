import {
  EXECUTION_EVENT_SCHEMA_VERSION,
  RESEARCH_PACKET_SCHEMA_VERSION,
  RESEARCH_WORK_SCHEMA_VERSION,
  RETRIEVED_EVIDENCE_SCHEMA_VERSION,
  SIGNAL_SCHEMA_VERSION,
  type ExecutionTraceEvent,
  type ResearchPacketV1,
  type ResearchWorkItem,
  type RetrievedEvidence,
  type Signal,
} from './contracts'

export function operatorSignal(
  sourceType: Signal['sourceType'],
  id: string,
  extras: Record<string, unknown> = {},
): Signal {
  const base = {
    schemaVersion: SIGNAL_SCHEMA_VERSION,
    signalId: `signal-${id}`,
    sourceId: `${sourceType}-source-${id}`,
    observedAt: '2026-08-26T10:00:00.000Z',
    publishedAt: null,
    canonicalUrl: `https://example.com/${id}`,
    title: `Signal ${id}`,
    visibleSummary: 'Summary',
    media: { imageUrl: null, attribution: null },
    sourceHints: { entities: [], assets: [], eventId: null, deadline: null },
    provenance: { provider: 'fixture', upstreamSource: null, rawPayloadRef: `row-${id}` },
    idempotencyKey: `key-${id}`,
    ...extras,
  }
  if (sourceType === 'news') return {
    ...base, sourceType: 'news', contentKind: 'article',
    content: { schemaVersion: 'myboon.signal_content.article.v1' },
  }
  if (sourceType === 'polymarket') return {
    ...base, sourceType: 'polymarket', contentKind: 'market_event',
    content: { schemaVersion: 'myboon.signal_content.market_event.v1' },
  }
  if (sourceType === 'market_calendar') return {
    ...base, sourceType: 'market_calendar', contentKind: 'calendar_event',
    content: { schemaVersion: 'myboon.signal_content.calendar_event.v1' },
  }
  return {
    ...base, sourceType: 'x', contentKind: 'social_thread',
    content: { schemaVersion: 'myboon.signal_content.social_thread.v1' },
  }
}

export function operatorWork(
  sourceType: Signal['sourceType'],
  id: string,
  overrides: Partial<ResearchWorkItem> = {},
): ResearchWorkItem {
  const depth = overrides.researchDepth ?? 'standard'
  return {
    schemaVersion: RESEARCH_WORK_SCHEMA_VERSION,
    workId: `work-${id}`,
    signalId: `signal-${id}`,
    sourceType,
    researchDepth: depth,
    deepReason: depth === 'deep' ? 'insufficient_primary_evidence' : null,
    priorityClass: 'P2',
    priorityScore: 0.5,
    freshnessDeadline: '2026-08-27T10:00:00.000Z',
    policyVersion: 'policy-v1',
    researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION,
    retrievalPlan: { sourceUrl: `https://example.com/${id}`, allowedDomains: ['example.com'], maxExternalSources: 2 },
    budget: {
      maxProviderCalls: 1, maxRepairCalls: 1, maxInputTokens: 1000,
      maxOutputTokens: 500, maxToolCalls: 0, maxWallTimeMs: 60_000,
    },
    status: 'research_pending',
    attemptCount: 0,
    nextAttemptAt: null,
    retryTargetStatus: null,
    leaseOwner: null,
    leaseId: null,
    leaseExpiresAt: null,
    failureCategory: null,
    failureDetail: null,
    traceId: `trace-${id}`,
    createdAt: '2026-08-26T10:00:00.000Z',
    updatedAt: '2026-08-26T11:00:00.000Z',
    ...overrides,
  }
}

export function operatorEvidence(id: string, overrides: Partial<RetrievedEvidence> = {}): RetrievedEvidence {
  return {
    schemaVersion: RETRIEVED_EVIDENCE_SCHEMA_VERSION,
    evidenceId: `evidence-${id}`,
    workId: `work-${id}`,
    requestedUrl: `https://example.com/${id}`,
    finalUrl: `https://example.com/${id}`,
    authority: 'source_url',
    authorityId: `source-${id}`,
    contentHash: `hash-${id}`,
    contentType: 'text/html',
    httpStatus: 200,
    retrievalMethod: 'safe_http',
    retrievedAt: '2026-08-26T10:30:00.000Z',
    text: 'Evidence text',
    truncated: false,
    byteLength: 13,
    ...overrides,
  }
}

export function operatorPacket(
  sourceType: Signal['sourceType'],
  id: string,
  overrides: Partial<ResearchPacketV1> = {},
): ResearchPacketV1 {
  return {
    schemaVersion: RESEARCH_PACKET_SCHEMA_VERSION,
    packetId: `packet-${id}`,
    workId: `work-${id}`,
    signalId: `signal-${id}`,
    sourceType,
    observedAt: '2026-08-26T10:00:00.000Z',
    sourceSignal: {
      title: `Signal ${id}`, canonicalUrl: `https://example.com/${id}`, publishedAt: null,
      provenance: { provider: 'fixture', upstreamSource: null, rawPayloadRef: `row-${id}` },
    },
    claims: [{ claimId: `claim-${id}`, claim: 'Claim', attributedTo: null, evidenceRefs: [`evidence-${id}`] }],
    verifiedFacts: [],
    unresolvedClaims: [],
    evidence: [{
      evidenceId: `evidence-${id}`, title: 'Evidence', url: `https://example.com/${id}`,
      sourceType: 'primary', observedAt: '2026-08-26T10:30:00.000Z', note: null,
    }],
    entityHints: [],
    limitations: [],
    openQuestions: [],
    completion: 'complete',
    budgetUsed: {
      providerCalls: 1, repairCalls: 0, inputTokens: 100, outputTokens: 40,
      toolCalls: 0, wallTimeMs: 1000, budgetExceeded: false,
    },
    execution: {
      provider: 'fixture', model: 'model', fallbackProvider: null, fallbackModel: null,
      fallbackUsed: false, promptVersion: 'prompt-v1', policyVersion: 'policy-v1',
      traceId: `trace-${id}`, attempt: 1,
    },
    researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION,
    createdAt: '2026-08-26T10:45:00.000Z',
    ...overrides,
  }
}

export function operatorExecutionEvent(
  sourceType: Signal['sourceType'],
  id: string,
  overrides: Partial<ExecutionTraceEvent> = {},
): ExecutionTraceEvent {
  return {
    schemaVersion: EXECUTION_EVENT_SCHEMA_VERSION,
    eventId: `event-${id}`,
    traceId: `trace-${id}`,
    signalId: `signal-${id}`,
    workId: `work-${id}`,
    packetId: `packet-${id}`,
    sourceType,
    stage: 'synthesis',
    attempt: 1,
    startedAt: '2026-08-26T10:40:00.000Z',
    finishedAt: '2026-08-26T10:41:00.000Z',
    status: 'succeeded',
    failureCategory: null,
    failureDetail: null,
    queueWaitMs: 100,
    wallTimeMs: 60_000,
    provider: 'fixture',
    model: 'model',
    fallbackProvider: null,
    fallbackModel: null,
    fallbackUsed: false,
    promptVersion: 'prompt-v1',
    policyVersion: 'policy-v1',
    researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION,
    providerCalls: 1,
    repairCalls: 0,
    inputTokens: 100,
    outputTokens: 40,
    toolCalls: 0,
    budgetExceeded: false,
    createdAt: '2026-08-26T10:41:00.000Z',
    ...overrides,
  }
}
