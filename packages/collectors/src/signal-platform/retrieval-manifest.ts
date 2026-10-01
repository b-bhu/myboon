import { createHash } from 'node:crypto'
import { stableContractId } from './adapters/identity'
import { canonicalJson } from './canonical-json'
import type {
  FailureCategory,
  ResearchWorkItem,
  RetrievedEvidence,
  RetrievalUrlAuthority,
  Signal,
} from './contracts'
import { ContractValidationError, validateResearchWorkItem } from './validation'

export const RETRIEVAL_MANIFEST_SCHEMA_VERSION = 'myboon.retrieval_manifest.v1' as const
export const RETRIEVAL_MANIFEST_POLICY_VERSION = 'myboon.retrieval_manifest_policy.v1' as const
export const RETRIEVAL_MANIFEST_AUTHOR_ID = 'myboon.retrieval_manifest.author.v1' as const

/**
 * Retrieval checkpoint: the durable record of what one retrieval execution
 * actually did, and of what it did not do.
 *
 * A non-empty evidence cache is **not** a completion marker. Evidence can be
 * persisted for sources that were never checked, for a plan that was cut short,
 * or for content that came back truncated. Only this manifest states which
 * planned sources were evaluated, which succeeded, which failed, which were
 * never evaluated at all, and whether Research may proceed on what is saved or
 * must hold and retry.
 *
 * It is immutable. A later attempt under a changed plan identity, or under a
 * new attempt number, is a new manifest; the saved one is never rewritten.
 */

/** Whether Research may build on this retrieval or must hold. */
export type RetrievalManifestDecision =
  /** Every planned source was retrieved, nothing skipped, nothing truncated. */
  | 'complete'
  /** Something usable was retrieved and the gaps are recorded explicitly. */
  | 'proceed_with_limitations'
  /** A required source is missing or unusable; no further stage may proceed. */
  | 'hold_and_retry'

/**
 * Why a planned source was never evaluated.
 *
 * `source_limit` means the plan's own source cap dropped it before execution.
 * `execution_stopped` means the executor stopped (budget, deadline, or an
 * earlier failure) before reaching it. Neither means "checked".
 */
export type RetrievalSkipReason = 'source_limit' | 'execution_stopped'

export interface RetrievalPlannedSource extends Record<string, unknown> {
  url: string
  authority: RetrievalUrlAuthority
  authorityId: string
}

/** One planned source and what actually happened to it. */
export interface RetrievalManifestSource extends Record<string, unknown> {
  url: string
  authority: RetrievalUrlAuthority
  authorityId: string
  /**
   * The work item's own canonical source URL is the only required source.
   * Search-discovered corroboration is optional by construction: losing it
   * limits the result but never invalidates it.
   */
  required: boolean
  outcome: 'succeeded' | 'failed' | 'skipped'
  evidenceId: string | null
  contentHash: string | null
  finalUrl: string | null
  /** True when this execution reused a still-eligible capture from an earlier checkpoint. */
  reused: boolean
  /** True when the captured text was cut short by the plan's text limit. */
  truncated: boolean
  /** Typed category only; provider and database text is never retained. */
  failureCategory: FailureCategory | null
  retryable: boolean
  skipReason: RetrievalSkipReason | null
}

export interface RetrievalManifestV1 extends Record<string, unknown> {
  schemaVersion: typeof RETRIEVAL_MANIFEST_SCHEMA_VERSION
  manifestId: string
  workId: string
  signalId: string
  sourceType: Signal['sourceType']
  researchContractVersion: ResearchWorkItem['researchContractVersion']
  /** Stable identity of the code-owned plan this execution ran under. */
  retrievalPlanId: string
  /** Digest of the exact plan and limits, so a changed plan is a new checkpoint. */
  retrievalPlanDigest: string
  /** Version of the work policy the plan identity was derived from. */
  retrievalPlanPolicyVersion: string
  manifestPolicyVersion: string
  /** The bounded attempt this manifest records. */
  attempt: number
  sources: RetrievalManifestSource[]
  plannedSourceCount: number
  discoveredSourceCount: number
  unevaluatedSourceCount: number
  truncatedSourceCount: number
  /** Exact persisted evidence identities backing the successful captures. */
  evidenceIds: string[]
  /** Explicit, measured statements of what was not checked or was cut short. */
  limitations: string[]
  decision: RetrievalManifestDecision
  /** Required for `hold_and_retry`; null when Research may proceed. */
  failureCategory: FailureCategory | null
  reason: string
  recordedBy: string
  recordedAt: string
  createdAt: string
}

/** The code-owned plan facts a plan identity is derived from. */
export interface RetrievalPlanIdentityInput {
  workId: string
  researchContractVersion: string
  policyVersion: string
  sourceUrl: string | null
  allowedDomains: readonly string[]
  maxExternalSources: number
  maxSources: number
  maxBytesPerSource: number
  maxTotalBytes: number
  maxTextCharsPerSource: number
  maxRedirects: number
  timeoutMs: number
  freshnessDeadline: string
}

export interface RetrievalCapture {
  evidenceId: string
  contentHash: string
  requestedUrl: string
  finalUrl: string
  truncated: boolean
  reused?: boolean
}

export interface RetrievalSourceFailure {
  requestedUrl: string
  category: FailureCategory
  retryable: boolean
}

export interface RetrievalManifestInput {
  work: ResearchWorkItem
  planId: string
  planDigest: string
  planPolicyVersion: string
  attempt: number
  plannedSources: readonly RetrievalPlannedSource[]
  skippedSources: readonly (RetrievalPlannedSource & { skipReason: RetrievalSkipReason })[]
  captures: readonly RetrievalCapture[]
  failures: readonly RetrievalSourceFailure[]
  recordedAt: string
  manifestPolicyVersion?: string
  recordedBy?: string
}

export function retrievalManifestId(
  workId: string,
  planId: string,
  attempt: number,
  manifestPolicyVersion: string = RETRIEVAL_MANIFEST_POLICY_VERSION,
): string {
  return stableContractId('retrieval_manifest', workId, planId, String(attempt), manifestPolicyVersion)
}

export function retrievalPlanDigest(input: RetrievalPlanIdentityInput): string {
  return createHash('sha256').update(canonicalJson({
    workId: input.workId,
    researchContractVersion: input.researchContractVersion,
    policyVersion: input.policyVersion,
    sourceUrl: input.sourceUrl === null ? null : normalizeUrl(input.sourceUrl),
    allowedDomains: [...input.allowedDomains].map((domain) => domain.trim().toLowerCase()).sort(),
    maxExternalSources: input.maxExternalSources,
    maxSources: input.maxSources,
    maxBytesPerSource: input.maxBytesPerSource,
    maxTotalBytes: input.maxTotalBytes,
    maxTextCharsPerSource: input.maxTextCharsPerSource,
    maxRedirects: input.maxRedirects,
    timeoutMs: input.timeoutMs,
    freshnessDeadline: input.freshnessDeadline,
  }), 'utf8').digest('hex')
}

export function retrievalPlanId(input: RetrievalPlanIdentityInput): string {
  return stableContractId(
    'retrieval_plan',
    input.workId,
    input.researchContractVersion,
    input.policyVersion,
    retrievalPlanDigest(input),
  )
}

/**
 * Deterministic, code-owned assessment of one retrieval execution.
 *
 * Everything recorded here is measured from the plan that ran and the batch it
 * produced. A source that was skipped, or whose text was truncated, is recorded
 * as such; it is never folded into a success.
 */
export function assessRetrievalManifest(input: RetrievalManifestInput): RetrievalManifestV1 {
  const work = validateResearchWorkItem(input.work)
  if (!input.planId.trim() || !input.planDigest.trim() || !input.planPolicyVersion.trim()) {
    throw new ContractValidationError('retrievalManifest.plan', 'requires a plan identity, digest, and version')
  }
  if (!Number.isInteger(input.attempt) || input.attempt < 1) {
    throw new ContractValidationError('retrievalManifest.attempt', 'must be a positive integer')
  }
  if (!Number.isFinite(Date.parse(input.recordedAt))) {
    throw new ContractValidationError('retrievalManifest.recordedAt', 'must be a timestamp')
  }
  const manifestPolicyVersion = input.manifestPolicyVersion ?? RETRIEVAL_MANIFEST_POLICY_VERSION
  const recordedAt = input.recordedAt

  const ordered: RetrievalPlannedSource[] = []
  const seen = new Set<string>()
  const planUrls = new Set<string>()
  const skipReasons = new Map<string, RetrievalSkipReason>()
  const add = (source: RetrievalPlannedSource, planned: boolean): void => {
    const url = normalizeUrl(source.url)
    if (seen.has(url)) return
    seen.add(url)
    if (planned) planUrls.add(url)
    ordered.push({ ...source, url })
  }
  for (const source of input.plannedSources) add(source, true)
  for (const source of input.skippedSources) {
    add(source, true)
    skipReasons.set(normalizeUrl(source.url), source.skipReason)
  }

  const captures = new Map<string, RetrievalCapture>()
  for (const capture of input.captures) {
    const url = normalizeUrl(capture.requestedUrl)
    if (!planUrls.has(url)) {
      throw new ContractValidationError(
        'retrievalManifest.captures',
        `capture ${capture.evidenceId} does not correspond to a planned source: ${url}`,
      )
    }
    captures.set(url, capture)
  }
  const failures = new Map<string, RetrievalSourceFailure>()
  for (const failure of input.failures) {
    const url = normalizeUrl(failure.requestedUrl)
    if (!planUrls.has(url)) {
      throw new ContractValidationError(
        'retrievalManifest.failures',
        `failure for ${url} does not correspond to a planned source`,
      )
    }
    failures.set(url, failure)
  }

  const sources: RetrievalManifestSource[] = ordered.map((source) => {
    const capture = captures.get(source.url) ?? null
    const failure = failures.get(source.url) ?? null
    if (capture && failure) {
      throw new ContractValidationError(
        'retrievalManifest.sources',
        `${source.url} recorded both a capture and a failure`,
      )
    }
    const skipped = !capture && !failure
    return {
      url: source.url,
      authority: source.authority,
      authorityId: source.authorityId,
      required: source.authority === 'source_url',
      outcome: capture ? 'succeeded' : failure ? 'failed' : 'skipped',
      evidenceId: capture?.evidenceId ?? null,
      contentHash: capture?.contentHash ?? null,
      finalUrl: capture ? normalizeUrl(capture.finalUrl) : null,
      reused: capture?.reused ?? false,
      truncated: capture?.truncated ?? false,
      failureCategory: failure?.category ?? null,
      retryable: failure?.retryable ?? false,
      skipReason: skipped ? (skipReasons.get(source.url) ?? 'execution_stopped') : null,
    }
  })
  if (sources.length === 0) {
    throw new ContractValidationError('retrievalManifest.sources', 'must record at least one planned source')
  }

  // Every gap is stated explicitly. A source that was never evaluated, or whose
  // text was cut short, is named as such and never reported as checked.
  const limitations: string[] = []
  for (const source of sources) {
    if (source.outcome === 'failed') {
      limitations.push(`not retrieved: ${source.url} (${source.failureCategory})`)
    } else if (source.outcome === 'skipped') {
      limitations.push(`not evaluated: ${source.url} (${source.skipReason})`)
    } else if (source.truncated) {
      limitations.push(`retrieved content truncated at the configured limit: ${source.url}`)
    }
  }

  const succeeded = sources.filter((source) => source.outcome === 'succeeded')
  const unsatisfied = sources.filter((source) => source.required && source.outcome !== 'succeeded')
  const hold = succeeded.length === 0 || unsatisfied.length > 0

  let decision: RetrievalManifestDecision
  let failureCategory: FailureCategory | null = null
  let reason: string
  if (hold) {
    decision = 'hold_and_retry'
    failureCategory = holdFailureCategory(sources, unsatisfied)
    reason = unsatisfied.length > 0
      ? `required source was not retrieved: ${unsatisfied.map((source) => source.url).join(', ')}`
      : 'no source was retrieved for this work item'
  } else if (limitations.length > 0) {
    decision = 'proceed_with_limitations'
    reason = `${succeeded.length} of ${sources.length} planned sources were retrieved; `
      + `${limitations.length} limitation(s) recorded`
  } else {
    decision = 'complete'
    reason = `all ${sources.length} planned sources were retrieved without truncation`
  }

  return validateRetrievalManifest({
    schemaVersion: RETRIEVAL_MANIFEST_SCHEMA_VERSION,
    manifestId: retrievalManifestId(work.workId, input.planId, input.attempt, manifestPolicyVersion),
    workId: work.workId,
    signalId: work.signalId,
    sourceType: work.sourceType,
    researchContractVersion: work.researchContractVersion,
    retrievalPlanId: input.planId,
    retrievalPlanDigest: input.planDigest,
    retrievalPlanPolicyVersion: input.planPolicyVersion,
    manifestPolicyVersion,
    attempt: input.attempt,
    sources,
    plannedSourceCount: sources.filter((source) => source.authority !== 'search_connector').length,
    discoveredSourceCount: sources.filter((source) => source.authority === 'search_connector').length,
    unevaluatedSourceCount: sources.filter((source) => source.outcome === 'skipped').length,
    truncatedSourceCount: sources.filter((source) => source.truncated).length,
    evidenceIds: succeeded.map((source) => source.evidenceId!).sort(),
    limitations,
    decision,
    failureCategory,
    reason,
    recordedBy: input.recordedBy ?? RETRIEVAL_MANIFEST_AUTHOR_ID,
    recordedAt,
    createdAt: recordedAt,
  })
}

export function validateRetrievalManifest(value: unknown): RetrievalManifestV1 {
  const record = object(value, 'retrievalManifest')
  literal(record.schemaVersion, RETRIEVAL_MANIFEST_SCHEMA_VERSION, 'retrievalManifest.schemaVersion')
  for (const key of [
    'manifestId', 'workId', 'signalId', 'researchContractVersion', 'retrievalPlanId',
    'retrievalPlanDigest', 'retrievalPlanPolicyVersion', 'manifestPolicyVersion', 'reason', 'recordedBy',
  ] as const) {
    nonEmpty(record[key], `retrievalManifest.${key}`)
  }
  oneOf(record.sourceType, ['news', 'polymarket', 'market_calendar', 'x'], 'retrievalManifest.sourceType')
  positiveInteger(record.attempt, 'retrievalManifest.attempt')
  timestamp(record.recordedAt, 'retrievalManifest.recordedAt')
  timestamp(record.createdAt, 'retrievalManifest.createdAt')
  if (record.manifestId !== retrievalManifestId(
    record.workId as string, record.retrievalPlanId as string,
    record.attempt as number, record.manifestPolicyVersion as string,
  )) {
    throw new ContractValidationError(
      'retrievalManifest.manifestId',
      'must be stable for its work, plan, attempt, and manifest policy version',
    )
  }
  if (record.failureCategory !== null && !isFailureCategory(record.failureCategory)) {
    throw new ContractValidationError(
      'retrievalManifest.failureCategory',
      'must be a known failure category or null',
    )
  }
  const sources = validateSources(record.sources)
  assertedStringArray(record.evidenceIds, 'retrievalManifest.evidenceIds')
  const evidenceIds = record.evidenceIds as string[]
  stringArray(record.limitations, 'retrievalManifest.limitations')
  const limitations = record.limitations as string[]
  const decision = oneOf(
    record.decision, ['complete', 'proceed_with_limitations', 'hold_and_retry'], 'retrievalManifest.decision',
  )

  const succeeded = sources.filter((source) => source.outcome === 'succeeded')
  const unsatisfied = sources.filter((source) => source.required && source.outcome !== 'succeeded')
  const skipped = sources.filter((source) => source.outcome === 'skipped')
  const truncated = sources.filter((source) => source.truncated)
  const failed = sources.filter((source) => source.outcome === 'failed')

  assertCount(record.plannedSourceCount, sources.length - countDiscovered(sources), 'retrievalManifest.plannedSourceCount')
  assertCount(record.discoveredSourceCount, countDiscovered(sources), 'retrievalManifest.discoveredSourceCount')
  assertCount(record.unevaluatedSourceCount, skipped.length, 'retrievalManifest.unevaluatedSourceCount')
  assertCount(record.truncatedSourceCount, truncated.length, 'retrievalManifest.truncatedSourceCount')

  // The evidence identities must be exactly the successful captures. A manifest
  // can never claim an artifact it did not capture, or omit one it did.
  const captured = succeeded.map((source) => source.evidenceId!).sort()
  if (canonicalJson(evidenceIds) !== canonicalJson(captured)) {
    throw new ContractValidationError(
      'retrievalManifest.evidenceIds',
      'must be exactly the evidence identities of the successful sources',
    )
  }
  // Every gap must be stated in words as well as in the structured fields, so a
  // reader cannot mistake an unevaluated or truncated source for a checked one.
  if (limitations.length < failed.length + skipped.length + truncated.length) {
    throw new ContractValidationError(
      'retrievalManifest.limitations',
      'must state every failed, unevaluated, and truncated source',
    )
  }

  if (decision === 'complete') {
    if (failed.length > 0 || skipped.length > 0 || truncated.length > 0 || limitations.length > 0) {
      throw new ContractValidationError(
        'retrievalManifest.decision',
        'a complete retrieval must have no failed, unevaluated, or truncated source',
      )
    }
    if (record.failureCategory !== null) {
      throw new ContractValidationError('retrievalManifest.failureCategory', 'must be null for a complete retrieval')
    }
  }
  if (decision !== 'hold_and_retry') {
    if (record.failureCategory !== null) {
      throw new ContractValidationError(
        'retrievalManifest.failureCategory', `must be null for a ${decision} retrieval`,
      )
    }
    // Proceeding requires the required source and at least one capture. A
    // retrieval that never got the work item's own source is never a result.
    if (unsatisfied.length > 0) {
      throw new ContractValidationError(
        'retrievalManifest.decision',
        `cannot report ${decision} while a required source is not retrieved: ${unsatisfied.map((s) => s.url).join(', ')}`,
      )
    }
    if (succeeded.length === 0) {
      throw new ContractValidationError(
        'retrievalManifest.evidenceIds', `must not be empty for a ${decision} retrieval`,
      )
    }
    if (decision === 'proceed_with_limitations' && limitations.length === 0) {
      throw new ContractValidationError(
        'retrievalManifest.limitations', 'must not be empty when proceeding with limitations',
      )
    }
  }
  if (decision === 'hold_and_retry') {
    if (record.failureCategory === null) {
      throw new ContractValidationError(
        'retrievalManifest.failureCategory', 'is required for a hold_and_retry retrieval',
      )
    }
    if (succeeded.length > 0 && unsatisfied.length === 0) {
      throw new ContractValidationError(
        'retrievalManifest.decision',
        'must not hold when every required source was retrieved and something succeeded',
      )
    }
  }
  return value as RetrievalManifestV1
}

/**
 * Validates a saved manifest against the stored work and evidence it claims to
 * describe. The producer store calls this before it writes anything, and the
 * worker calls it on re-entry, so a checkpoint is never trusted because it is
 * merely present.
 */
export function validateRetrievalManifestLinkage(input: {
  manifest: RetrievalManifestV1
  work: ResearchWorkItem
  persistedEvidence: readonly RetrievedEvidence[]
}): string | null {
  const manifest = validateRetrievalManifest(input.manifest)
  const work = validateResearchWorkItem(input.work)
  if (manifest.workId !== work.workId || manifest.signalId !== work.signalId
    || manifest.sourceType !== work.sourceType) {
    return 'manifest linkage does not match its work item'
  }
  if (manifest.researchContractVersion !== work.researchContractVersion) {
    return 'manifest research contract version does not match its work item'
  }
  if (manifest.retrievalPlanPolicyVersion !== work.policyVersion) {
    return 'manifest plan policy version does not match its work item'
  }
  const stored = new Map(input.persistedEvidence.map((artifact) => [artifact.evidenceId, artifact]))
  for (const source of manifest.sources) {
    if (source.outcome !== 'succeeded') continue
    const artifact = stored.get(source.evidenceId!)
    if (!artifact) {
      return `manifest references evidence that is not persisted for this work item: ${source.evidenceId}`
    }
    // The evidence `workId` keeps identifying its originating work; a manifest
    // can never re-home an artifact onto a consumer.
    if (artifact.workId !== manifest.workId) {
      return `manifest evidence ${source.evidenceId} does not originate from this work item`
    }
    if (artifact.contentHash !== source.contentHash) {
      return `manifest evidence ${source.evidenceId} does not match its recorded content hash`
    }
    if (normalizeUrl(artifact.requestedUrl) !== source.url
      || normalizeUrl(artifact.finalUrl) !== source.finalUrl
      || artifact.authority !== source.authority
      || artifact.authorityId !== source.authorityId
      || artifact.truncated !== source.truncated) {
      return `manifest evidence ${source.evidenceId} does not match its recorded source metadata`
    }
  }
  return null
}

/** Whether this checkpoint says Research may build on the retrieval. */
export function retrievalManifestMayProceed(manifest: RetrievalManifestV1): boolean {
  return validateRetrievalManifest(manifest).decision !== 'hold_and_retry'
}

/**
 * The bounded-retry inputs a held checkpoint owes the existing retry policy,
 * or null when the checkpoint may proceed. Only a required source can hold.
 */
export function retrievalManifestHoldFailure(
  manifest: RetrievalManifestV1,
): { category: FailureCategory, retryable: boolean } | null {
  const record = validateRetrievalManifest(manifest)
  if (record.decision !== 'hold_and_retry') return null
  const required = record.sources.filter((source) => source.required && source.outcome !== 'succeeded')
  return {
    category: record.failureCategory!,
    retryable: required.some((source) => source.retryable),
  }
}

function holdFailureCategory(
  sources: readonly RetrievalManifestSource[],
  unsatisfied: readonly RetrievalManifestSource[],
): FailureCategory {
  const requiredFailure = unsatisfied.find((source) => source.outcome === 'failed')
  if (requiredFailure?.failureCategory) return requiredFailure.failureCategory
  const requiredSkip = unsatisfied.find((source) => source.outcome === 'skipped')
  if (requiredSkip) {
    return requiredSkip.skipReason === 'source_limit' ? 'budget_exceeded' : 'permanent_source_error'
  }
  return sources.find((source) => source.outcome === 'failed')?.failureCategory ?? 'permanent_source_error'
}

function validateSources(value: unknown): RetrievalManifestSource[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ContractValidationError('retrievalManifest.sources', 'must be a non-empty array')
  }
  const urls = new Set<string>()
  return value.map((entry) => {
    const record = object(entry, 'retrievalManifest.sources[]')
    nonEmpty(record.url, 'retrievalManifest.sources[].url')
    nonEmpty(record.authorityId, 'retrievalManifest.sources[].authorityId')
    const url = normalizeUrl(record.url as string)
    if (urls.has(url)) {
      throw new ContractValidationError('retrievalManifest.sources', `must not repeat a source: ${url}`)
    }
    urls.add(url)
    if (record.url !== url) {
      throw new ContractValidationError(
        'retrievalManifest.sources[].url', `must be a normalized URL: ${url}`,
      )
    }
    const authority = oneOf(
      record.authority, ['source_url', 'source_hint', 'search_connector'], 'retrievalManifest.sources[].authority',
    )
    if (typeof record.required !== 'boolean') {
      throw new ContractValidationError('retrievalManifest.sources[].required', 'must be boolean')
    }
    if (record.required !== (authority === 'source_url')) {
      throw new ContractValidationError(
        'retrievalManifest.sources[].required',
        'must be true only for the work item source URL',
      )
    }
    if (typeof record.truncated !== 'boolean') {
      throw new ContractValidationError('retrievalManifest.sources[].truncated', 'must be boolean')
    }
    if (typeof record.retryable !== 'boolean') {
      throw new ContractValidationError('retrievalManifest.sources[].retryable', 'must be boolean')
    }
    const outcome = oneOf(
      record.outcome, ['succeeded', 'failed', 'skipped'], 'retrievalManifest.sources[].outcome',
    )
    if (outcome === 'succeeded') {
      nonEmpty(record.evidenceId, 'retrievalManifest.sources[].evidenceId')
      nonEmpty(record.contentHash, 'retrievalManifest.sources[].contentHash')
      nonEmpty(record.finalUrl, 'retrievalManifest.sources[].finalUrl')
      if (typeof record.reused !== 'boolean') {
        throw new ContractValidationError('retrievalManifest.sources[].reused', 'must be boolean')
      }
      if (record.failureCategory !== null || record.skipReason !== null || record.retryable) {
        throw new ContractValidationError(
          'retrievalManifest.sources[]', 'a succeeded source must not carry a failure or skip marker',
        )
      }
    } else {
      if (record.evidenceId !== null || record.contentHash !== null || record.finalUrl !== null
        || record.reused !== false || record.truncated !== false) {
        throw new ContractValidationError(
          'retrievalManifest.sources[]', 'an unsuccessful source must not carry capture data',
        )
      }
      if (outcome === 'failed') {
        if (!isFailureCategory(record.failureCategory)) {
          throw new ContractValidationError(
            'retrievalManifest.sources[].failureCategory', 'a failed source requires a known category',
          )
        }
        if (record.skipReason !== null) {
          throw new ContractValidationError('retrievalManifest.sources[].skipReason', 'must be null for a failed source')
        }
      } else {
        if (record.failureCategory !== null || record.retryable) {
          throw new ContractValidationError(
            'retrievalManifest.sources[]', 'an unevaluated source must not carry a failure marker',
          )
        }
        oneOf(record.skipReason, ['source_limit', 'execution_stopped'], 'retrievalManifest.sources[].skipReason')
      }
    }
    return entry as RetrievalManifestSource
  })
}

function countDiscovered(sources: readonly RetrievalManifestSource[]): number {
  return sources.filter((source) => source.authority === 'search_connector').length
}

function assertCount(value: unknown, expected: number, path: string): void {
  nonNegativeInteger(value, path)
  if (value !== expected) throw new ContractValidationError(path, `must equal ${expected}`)
}

const FAILURE_CATEGORIES = new Set([
  'provider_unavailable', 'provider_rate_limited', 'provider_timeout', 'provider_authentication',
  'circuit_open', 'retrieval_timeout', 'retrieval_blocked', 'retrieval_unsafe_url',
  'budget_exceeded', 'invalid_structured_output', 'schema_version_mismatch',
  'permanent_source_error', 'entity_resolution_failed', 'storage_transient', 'storage_permanent',
])

function isFailureCategory(value: unknown): value is FailureCategory {
  return typeof value === 'string' && FAILURE_CATEGORIES.has(value)
}

function normalizeUrl(value: string): string {
  try { return new URL(value).toString() } catch { return value }
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractValidationError(path, 'must be an object')
  }
  return value as Record<string, unknown>
}

function literal(value: unknown, expected: string, path: string): void {
  if (value !== expected) throw new ContractValidationError(path, `must equal ${expected}`)
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ContractValidationError(path, `must be one of ${allowed.join(', ')}`)
  }
  return value as T
}

function nonEmpty(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ContractValidationError(path, 'must be a non-empty string')
  }
}

function stringArray(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ContractValidationError(path, 'must be a string array')
  }
}

function assertedStringArray(value: unknown, path: string): asserts value is string[] {
  uniqueStringArray(value, path)
}

function uniqueStringArray(value: unknown, path: string): void {
  stringArray(value, path)
  const items = value as string[]
  if (new Set(items).size !== items.length) {
    throw new ContractValidationError(path, 'must not contain duplicates')
  }
  if (items.some((item) => item.trim() === '')) {
    throw new ContractValidationError(path, 'must not contain empty entries')
  }
}

function nonNegativeInteger(value: unknown, path: string): void {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new ContractValidationError(path, 'must be a non-negative integer')
  }
}

function positiveInteger(value: unknown, path: string): void {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new ContractValidationError(path, 'must be a positive integer')
  }
}

function timestamp(value: unknown, path: string): void {
  nonEmpty(value, path)
  if (!Number.isFinite(Date.parse(value))) throw new ContractValidationError(path, 'must be a timestamp')
}
