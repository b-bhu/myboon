import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RESEARCH_PACKET_SCHEMA_VERSION,
  RESEARCH_WORK_SCHEMA_VERSION,
  RETRIEVED_EVIDENCE_SCHEMA_VERSION,
  SIGNAL_SCHEMA_VERSION,
  type ResearchWorkItem,
  type RetrievedEvidence,
  type Signal,
} from './contracts'
import {
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
  type RetrievalManifestInput,
  type RetrievalPlanIdentityInput,
} from './retrieval-manifest'
import { ContractValidationError } from './validation'

const NOW = '2026-08-26T12:00:00.000Z'
const SOURCE_URL = 'https://news.example/ethena'
const COROBORATION_URL = 'https://reuters.example/ethena'
const EXTRA_URL = 'https://news.example/ethena-2'

function signal(): Signal {
  return {
    schemaVersion: SIGNAL_SCHEMA_VERSION, signalId: 'signal-1', sourceType: 'news',
    sourceId: 'news:source:1', contentKind: 'article',
    content: { schemaVersion: 'myboon.signal_content.article.v1' },
    observedAt: '2026-08-26T11:00:00.000Z', publishedAt: '2026-08-26T10:55:00.000Z',
    canonicalUrl: SOURCE_URL, title: 'Ethena article', visibleSummary: null,
    media: { imageUrl: null, attribution: null },
    sourceHints: { entities: [], assets: [], eventId: null, deadline: null },
    provenance: { provider: 'fixture', upstreamSource: null, rawPayloadRef: 'raw-1' },
    idempotencyKey: 'news:key:1',
  } as Signal
}

function work(overrides: Partial<ResearchWorkItem> = {}): ResearchWorkItem {
  return {
    schemaVersion: RESEARCH_WORK_SCHEMA_VERSION, workId: 'work-1', signalId: 'signal-1',
    sourceType: 'news', researchDepth: 'standard', deepReason: null,
    priorityClass: 'P1', priorityScore: 0.5, freshnessDeadline: '2026-08-26T18:00:00.000Z',
    policyVersion: 'policy.v1', researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION,
    retrievalPlan: { sourceUrl: SOURCE_URL, allowedDomains: ['news.example'], maxExternalSources: 2 },
    budget: { maxProviderCalls: 2, maxRepairCalls: 1, maxToolCalls: 0, maxWallTimeMs: 30_000 },
    status: 'retrieval_leased', attemptCount: 1, nextAttemptAt: null,
    leaseOwner: 'worker-1', leaseId: 'lease-1', leaseExpiresAt: '2026-08-26T12:05:00.000Z',
    failureCategory: null, failureDetail: null, traceId: 'trace-1',
    createdAt: '2026-08-26T11:30:00.000Z', updatedAt: '2026-08-26T11:59:00.000Z',
    ...overrides,
  }
}

function planIdentity(overrides: Partial<RetrievalPlanIdentityInput> = {}): RetrievalPlanIdentityInput {
  return {
    workId: 'work-1', researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION, policyVersion: 'policy.v1',
    sourceUrl: SOURCE_URL, allowedDomains: ['news.example'], maxExternalSources: 2,
    maxSources: 3, maxBytesPerSource: 1_000_000, maxTotalBytes: 3_000_000,
    maxTextCharsPerSource: 100_000, maxRedirects: 3, timeoutMs: 30_000,
    freshnessDeadline: '2026-08-26T18:00:00.000Z',
    ...overrides,
  }
}

const SOURCE = { url: SOURCE_URL, authority: 'source_url' as const, authorityId: 'signal-1' }
const COROBORATION = {
  url: COROBORATION_URL, authority: 'search_connector' as const, authorityId: 'connector:result-1',
}

function capture(url: string, evidenceId: string, truncated = false) {
  return {
    evidenceId, contentHash: `hash-${evidenceId}`, requestedUrl: url, finalUrl: url, truncated,
  }
}

function assess(overrides: Partial<RetrievalManifestInput> = {}) {
  const identity = planIdentity()
  return assessRetrievalManifest({
    work: work(),
    planId: retrievalPlanId(identity),
    planDigest: retrievalPlanDigest(identity),
    planPolicyVersion: 'policy.v1',
    attempt: 1,
    plannedSources: [SOURCE],
    skippedSources: [],
    captures: [capture(SOURCE_URL, 'evidence-1')],
    failures: [],
    recordedAt: NOW,
    ...overrides,
  })
}

function evidence(id: string, overrides: Partial<RetrievedEvidence> = {}): RetrievedEvidence {
  return {
    schemaVersion: RETRIEVED_EVIDENCE_SCHEMA_VERSION, evidenceId: id, workId: 'work-1',
    requestedUrl: SOURCE_URL, finalUrl: SOURCE_URL, authority: 'source_url', authorityId: 'signal-1',
    contentHash: `hash-${id}`, contentType: 'text/html', httpStatus: 200, retrievalMethod: 'safe_http',
    retrievedAt: NOW, text: 'Body', truncated: false, byteLength: 100,
    ...overrides,
  }
}

test('a fully retrieved plan is recorded as complete with no limitations', () => {
  const manifest = assess()
  assert.equal(manifest.schemaVersion, RETRIEVAL_MANIFEST_SCHEMA_VERSION)
  assert.equal(manifest.decision, 'complete')
  assert.equal(manifest.failureCategory, null)
  assert.deepEqual(manifest.limitations, [])
  assert.deepEqual(manifest.evidenceIds, ['evidence-1'])
  assert.deepEqual(
    { planned: manifest.plannedSourceCount, discovered: manifest.discoveredSourceCount, unevaluated: manifest.unevaluatedSourceCount, truncated: manifest.truncatedSourceCount },
    { planned: 1, discovered: 0, unevaluated: 0, truncated: 0 },
  )
  assert.equal(retrievalManifestMayProceed(manifest), true)
  assert.equal(retrievalManifestHoldFailure(manifest), null)
  // Work/signal/source linkage and plan identity are all preserved.
  assert.deepEqual(
    { workId: manifest.workId, signalId: manifest.signalId, sourceType: manifest.sourceType, contract: manifest.researchContractVersion },
    { workId: 'work-1', signalId: 'signal-1', sourceType: 'news', contract: RESEARCH_PACKET_SCHEMA_VERSION },
  )
  assert.equal(manifest.retrievalPlanPolicyVersion, 'policy.v1')
})

test('a lost optional corroboration source proceeds with limitations that name it', () => {
  const manifest = assess({
    plannedSources: [SOURCE, COROBORATION],
    captures: [capture(SOURCE_URL, 'evidence-1')],
    failures: [{ requestedUrl: COROBORATION_URL, category: 'retrieval_blocked', retryable: true }],
  })
  assert.equal(manifest.decision, 'proceed_with_limitations')
  assert.equal(manifest.failureCategory, null)
  assert.equal(manifest.discoveredSourceCount, 1)
  assert.deepEqual(manifest.limitations, [
    `not retrieved: ${COROBORATION_URL} (retrieval_blocked)`,
  ])
  assert.equal(retrievalManifestHoldFailure(manifest), null)
  assert.ok(manifest.reason.includes('2 planned sources'))
})

test('a failed required source holds the checkpoint instead of proceeding', () => {
  const manifest = assess({
    plannedSources: [SOURCE, COROBORATION],
    captures: [capture(COROBORATION_URL, 'evidence-2')],
    failures: [{ requestedUrl: SOURCE_URL, category: 'retrieval_blocked', retryable: true }],
  })
  assert.equal(manifest.decision, 'hold_and_retry')
  assert.equal(manifest.failureCategory, 'retrieval_blocked')
  // The captured corroboration is retained, but it is not treated as a result.
  assert.deepEqual(manifest.evidenceIds, ['evidence-2'])
  assert.equal(retrievalManifestMayProceed(manifest), false)
  assert.deepEqual(retrievalManifestHoldFailure(manifest), {
    category: 'retrieval_blocked', retryable: true,
  })
  assert.equal(manifest.reason, `required source was not retrieved: ${SOURCE_URL}`)
})

test('a permanently failed required source is held without a retryable category', () => {
  const manifest = assess({
    failures: [{ requestedUrl: SOURCE_URL, category: 'permanent_source_error', retryable: false }],
    captures: [],
  })
  assert.equal(manifest.decision, 'hold_and_retry')
  assert.deepEqual(retrievalManifestHoldFailure(manifest), {
    category: 'permanent_source_error', retryable: false,
  })
})

test('a source dropped by the plan source cap is recorded as never evaluated', () => {
  const manifest = assess({
    plannedSources: [SOURCE, { ...COROBORATION, url: EXTRA_URL }],
    skippedSources: [{ ...COROBORATION, url: EXTRA_URL, skipReason: 'source_limit' }],
    captures: [capture(SOURCE_URL, 'evidence-1')],
    failures: [],
  })
  assert.equal(manifest.decision, 'proceed_with_limitations')
  assert.equal(manifest.unevaluatedSourceCount, 1)
  assert.deepEqual(manifest.sources.map((source) => source.outcome), ['succeeded', 'skipped'])
  assert.deepEqual(manifest.limitations, [`not evaluated: ${EXTRA_URL} (source_limit)`])
})

test('a source the executor never reached is recorded as unevaluated, not as checked', () => {
  const manifest = assess({
    plannedSources: [SOURCE, COROBORATION],
    skippedSources: [{ ...COROBORATION, skipReason: 'execution_stopped' }],
    captures: [capture(SOURCE_URL, 'evidence-1')],
    failures: [],
  })
  assert.equal(manifest.decision, 'proceed_with_limitations')
  assert.equal(manifest.unevaluatedSourceCount, 1)
  assert.deepEqual(manifest.limitations, [`not evaluated: ${COROBORATION_URL} (execution_stopped)`])
})

test('a truncated capture proceeds with an explicit truncation limitation', () => {
  const manifest = assess({ captures: [capture(SOURCE_URL, 'evidence-1', true)] })
  assert.equal(manifest.decision, 'proceed_with_limitations')
  assert.equal(manifest.truncatedSourceCount, 1)
  assert.deepEqual(manifest.limitations, [
    `retrieved content truncated at the configured limit: ${SOURCE_URL}`,
  ])
})

test('a required source never evaluated at all holds the checkpoint', () => {
  const manifest = assess({
    skippedSources: [{ ...SOURCE, skipReason: 'source_limit' }],
    captures: [],
    failures: [],
  })
  assert.equal(manifest.decision, 'hold_and_retry')
  assert.equal(manifest.failureCategory, 'budget_exceeded')
  assert.deepEqual(retrievalManifestHoldFailure(manifest), {
    category: 'budget_exceeded', retryable: false,
  })
})

test('a capture or failure for an unplanned URL is refused rather than invented', () => {
  assert.throws(
    () => assess({ captures: [capture(COROBORATION_URL, 'evidence-9')], plannedSources: [SOURCE] }),
    /does not correspond to a planned source/,
  )
  assert.throws(
    () => assess({
      plannedSources: [SOURCE],
      failures: [{ requestedUrl: COROBORATION_URL, category: 'retrieval_blocked', retryable: true }],
    }),
    /does not correspond to a planned source/,
  )
})

test('manifest identity is stable per work, plan, attempt, and policy version', () => {
  const manifest = assess()
  assert.equal(manifest.manifestId, retrievalManifestId(
    manifest.workId, manifest.retrievalPlanId, manifest.attempt, RETRIEVAL_MANIFEST_POLICY_VERSION,
  ))
  assert.deepEqual(assess(), manifest)
  assert.notEqual(assess({ attempt: 2 }).manifestId, manifest.manifestId)
})

test('plan identity changes with the plan and not with search discovery results', () => {
  const base = planIdentity()
  assert.equal(retrievalPlanId(base), retrievalPlanId({ ...base, allowedDomains: ['news.example'] }))
  assert.notEqual(retrievalPlanId(base), retrievalPlanId({ ...base, maxSources: 4 }))
  assert.notEqual(retrievalPlanId(base), retrievalPlanId({ ...base, timeoutMs: 15_000 }))
  assert.notEqual(retrievalPlanId(base), retrievalPlanId({ ...base, policyVersion: 'policy.v2' }))
  assert.notEqual(retrievalPlanDigest(base), retrievalPlanDigest({ ...base, maxTotalBytes: 4_000_000 }))
})

test('validation refuses a manifest that claims evidence it did not capture', () => {
  const manifest = assess()
  assert.throws(
    () => validateRetrievalManifest({ ...manifest, evidenceIds: ['evidence-1', 'evidence-ghost'] }),
    (error: unknown) => error instanceof ContractValidationError
      && error.path === 'retrievalManifest.evidenceIds',
  )
})

test('validation refuses to call a gapped retrieval complete', () => {
  const manifest = assess()
  const gaps = manifest.sources.map((source) => ({
    ...source, outcome: 'failed' as const, failureCategory: 'retrieval_blocked' as const,
    evidenceId: null, contentHash: null, finalUrl: null, reused: false, truncated: false,
  }))
  assert.throws(
    () => validateRetrievalManifest({
      ...manifest,
      sources: gaps,
      evidenceIds: [],
      limitations: [`not retrieved: ${SOURCE_URL} (retrieval_blocked)`],
    }),
    (error: unknown) => error instanceof ContractValidationError && error.path === 'retrievalManifest.decision',
  )
})

test('validation refuses gaps that the limitations do not state', () => {
  const manifest = assess({
    plannedSources: [SOURCE, COROBORATION],
    failures: [{ requestedUrl: COROBORATION_URL, category: 'retrieval_blocked', retryable: true }],
  })
  assert.throws(
    () => validateRetrievalManifest({ ...manifest, limitations: [] }),
    (error: unknown) => error instanceof ContractValidationError
      && error.path === 'retrievalManifest.limitations',
  )
})

test('validation refuses to proceed while a required source is missing', () => {
  const manifest = assess({
    plannedSources: [SOURCE, COROBORATION],
    captures: [capture(COROBORATION_URL, 'evidence-2')],
    failures: [{ requestedUrl: SOURCE_URL, category: 'retrieval_blocked', retryable: true }],
  })
  const asProceed = { ...manifest, decision: 'proceed_with_limitations', failureCategory: null }
  assert.throws(
    () => validateRetrievalManifest(asProceed),
    (error: unknown) => error instanceof ContractValidationError && error.path === 'retrievalManifest.decision',
  )
})

test('validation refuses a hold without a typed failure category', () => {
  const manifest = assess({
    failures: [{ requestedUrl: SOURCE_URL, category: 'retrieval_blocked', retryable: true }],
    captures: [],
  })
  assert.throws(
    () => validateRetrievalManifest({ ...manifest, failureCategory: null }),
    (error: unknown) => error instanceof ContractValidationError
      && error.path === 'retrievalManifest.failureCategory',
  )
})

test('validation refuses gaps that the limitations do not state', () => {
  const manifest = assess({
    plannedSources: [SOURCE, COROBORATION],
    failures: [{ requestedUrl: COROBORATION_URL, category: 'retrieval_blocked', retryable: true }],
  })
  assert.throws(
    () => validateRetrievalManifest({ ...manifest, limitations: [] }),
    (error: unknown) => error instanceof ContractValidationError
      && error.path === 'retrievalManifest.limitations',
  )
})

test('validation refuses a source marked required that is not the work source URL', () => {
  const manifest = assess()
  const sources = manifest.sources.map((source) => ({ ...source, required: false }))
  assert.throws(
    () => validateRetrievalManifest({ ...manifest, sources }),
    (error: unknown) => error instanceof ContractValidationError
      && error.path === 'retrievalManifest.sources[].required',
  )
})

test('linkage is only satisfied by the stored evidence the manifest describes', () => {
  const manifest = assess()
  assert.equal(validateRetrievalManifestLinkage({
    manifest, work: work(), persistedEvidence: [evidence('evidence-1')],
  }), null)

  assert.match(
    validateRetrievalManifestLinkage({ manifest, work: work(), persistedEvidence: [] }) ?? '',
    /evidence that is not persisted/,
  )
  assert.match(
    validateRetrievalManifestLinkage({
      manifest,
      work: work(),
      persistedEvidence: [evidence('evidence-1', { contentHash: 'different-hash' })],
    }) ?? '',
    /does not match its recorded content hash/,
  )
  assert.match(
    validateRetrievalManifestLinkage({
      manifest,
      work: work(),
      persistedEvidence: [evidence('evidence-1', { authorityId: 'different-source' })],
    }) ?? '',
    /does not match its recorded source metadata/,
  )
  assert.match(
    validateRetrievalManifestLinkage({
      manifest,
      work: work(),
      persistedEvidence: [evidence('evidence-1', { workId: 'consumer-work' })],
    }) ?? '',
    /does not originate from this work item/,
  )
  assert.match(
    validateRetrievalManifestLinkage({
      manifest,
      work: work({ policyVersion: 'policy.v2' }),
      persistedEvidence: [evidence('evidence-1')],
    }) ?? '',
    /plan policy version does not match/,
  )
  assert.match(
    validateRetrievalManifestLinkage({
      manifest,
      work: work({ signalId: 'signal-other' }),
      persistedEvidence: [evidence('evidence-1')],
    }) ?? '',
    /does not match its work item/,
  )
})
