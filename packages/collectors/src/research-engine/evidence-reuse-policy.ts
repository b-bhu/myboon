import { createHash } from 'node:crypto'
import type { ResearchWorkItem, RetrievedEvidence, Signal } from '../signal-platform/contracts'
import {
  isEvidenceReusable,
  type EvidenceFreshnessPolicy,
  type EvidenceReuseContext,
  type RetrievedEvidenceArtifact,
} from './deterministic-retrieval'

export const WORK_CONTRACT_EVIDENCE_REUSE_POLICY_VERSION = 'myboon.evidence_reuse.work_contract.v1' as const
export const EVIDENCE_REUSE_CONTEXT_SCHEMA_VERSION = 'myboon.evidence_reuse_context.v1' as const

export interface PersistedEvidenceReuseContext {
  schemaVersion: typeof EVIDENCE_REUSE_CONTEXT_SCHEMA_VERSION
  sourceMaterialHash: string
  requestedUrl: string
  finalUrl: string
  contentHash: string
  retrievalState: 'succeeded'
}

export interface CurrentEvidenceReuseState {
  schemaVersion: typeof EVIDENCE_REUSE_CONTEXT_SCHEMA_VERSION
  contentHashByRequestedUrl?: Readonly<Record<string, string>>
  finalUrlByRequestedUrl?: Readonly<Record<string, string>>
  blockedRequestedUrls?: readonly string[]
  manuallyInvalidatedEvidenceIds?: readonly string[]
}

export interface EvidenceReusePolicyInput {
  artifact: RetrievedEvidence
  workItem: ResearchWorkItem
  signal: Signal
  now: string
}

export interface EvidenceReuseDecision {
  reusable: boolean
  policyVersion: string
  reason: 'reusable' | 'outside_work_window' | 'freshness_policy_rejected'
}

export interface EvidenceReusePolicyPort {
  evaluate(input: EvidenceReusePolicyInput): EvidenceReuseDecision
}

export interface WorkContractEvidenceReusePolicyOptions {
  maxArtifactBytes: number
  context?: (input: EvidenceReusePolicyInput) => Omit<EvidenceReuseContext, 'now'>
}

/**
 * Conservative default selected from the durable work contract rather than an
 * embedded source TTL. Source-specific policies can inject a richer context,
 * while every replay still crosses the same versioned validation boundary.
 */
export class WorkContractEvidenceReusePolicy implements EvidenceReusePolicyPort {
  private readonly maxArtifactBytes: number
  private readonly context: (input: EvidenceReusePolicyInput) => Omit<EvidenceReuseContext, 'now'>

  constructor(options: WorkContractEvidenceReusePolicyOptions) {
    if (!Number.isInteger(options.maxArtifactBytes) || options.maxArtifactBytes <= 0) {
      throw new Error('maxArtifactBytes must be a positive integer')
    }
    this.maxArtifactBytes = options.maxArtifactBytes
    this.context = options.context ?? defaultContext
  }

  evaluate(input: EvidenceReusePolicyInput): EvidenceReuseDecision {
    const createdAt = Date.parse(input.workItem.createdAt)
    const deadline = Date.parse(input.workItem.freshnessDeadline)
    const retrievedAt = Date.parse(input.artifact.retrievedAt)
    const now = Date.parse(input.now)
    if (![createdAt, deadline, retrievedAt, now].every(Number.isFinite)
      || retrievedAt < createdAt || now > deadline) {
      return {
        reusable: false,
        policyVersion: WORK_CONTRACT_EVIDENCE_REUSE_POLICY_VERSION,
        reason: 'outside_work_window',
      }
    }
    const policy: EvidenceFreshnessPolicy = {
      policyVersion: WORK_CONTRACT_EVIDENCE_REUSE_POLICY_VERSION,
      maxAgeMs: Math.max(0, deadline - createdAt),
      maxArtifactBytes: this.maxArtifactBytes,
      invalidateOn: [
        'content_hash_changed',
        'final_url_changed',
        'source_material_change',
        'retrieval_became_blocked',
        'manual_invalidation',
      ],
    }
    const reusable = isEvidenceReusable(
      input.artifact as RetrievedEvidenceArtifact,
      policy,
      { now: input.now, ...this.context(input) },
    )
    return {
      reusable,
      policyVersion: WORK_CONTRACT_EVIDENCE_REUSE_POLICY_VERSION,
      reason: reusable ? 'reusable' : 'freshness_policy_rejected',
    }
  }
}

function defaultContext(input: EvidenceReusePolicyInput): Omit<EvidenceReuseContext, 'now'> {
  const persisted = persistedContext(input.artifact)
  const current = currentReuseState(input)
  const requestedUrl = normalizeUrl(input.artifact.requestedUrl)
  const sourceContent = record(input.signal.content)
  // A Signal content hash identifies the upstream signal payload/headline; it
  // is not the hash of bytes retrieved from requestedUrl. Only an explicit
  // URL-keyed revalidation observation can be compared with artifact bytes.
  const contentHash = current?.contentHashByRequestedUrl?.[requestedUrl]
  const finalUrl = current?.finalUrlByRequestedUrl?.[requestedUrl]
  const plannedSourceUrl = input.artifact.authority === 'source_url'
    ? input.workItem.retrievalPlan.sourceUrl : input.artifact.requestedUrl
  return {
    ...(contentHash ? { contentHash } : {}),
    ...(finalUrl ? { finalUrl } : {}),
    sourceMaterialChanged: (persisted !== null && (
      persisted.sourceMaterialHash !== sourceMaterialHash(input.signal)
      || normalizeUrl(persisted.requestedUrl) !== requestedUrl
      || normalizeUrl(persisted.finalUrl) !== normalizeUrl(input.artifact.finalUrl)
      || persisted.contentHash !== input.artifact.contentHash
    ))
      || (plannedSourceUrl !== null && normalizeUrl(plannedSourceUrl) !== requestedUrl),
    retrievalBecameBlocked: stringValue(sourceContent?.retrievalState) === 'blocked'
      || current?.blockedRequestedUrls?.map(normalizeUrl).includes(requestedUrl) === true
      || !retrievalPlanAllows(input.workItem, requestedUrl),
    manuallyInvalidated: current?.manuallyInvalidatedEvidenceIds?.includes(input.artifact.evidenceId) === true,
  }
}

/** Adds code-owned comparison metadata before the immutable artifact is persisted. */
export function withEvidenceReuseContext(
  artifact: RetrievedEvidence,
  input: { signal: Signal, workItem: ResearchWorkItem },
): RetrievedEvidence {
  const context: PersistedEvidenceReuseContext = Object.freeze({
    schemaVersion: EVIDENCE_REUSE_CONTEXT_SCHEMA_VERSION,
    sourceMaterialHash: sourceMaterialHash(input.signal),
    requestedUrl: normalizeUrl(artifact.requestedUrl),
    finalUrl: normalizeUrl(artifact.finalUrl),
    contentHash: artifact.contentHash,
    retrievalState: 'succeeded',
  })
  return Object.freeze({ ...artifact, evidenceReuseContext: context })
}

export function sourceMaterialHash(signal: Signal): string {
  return createHash('sha256').update(stableJson({
    schemaVersion: signal.schemaVersion,
    signalId: signal.signalId,
    sourceId: signal.sourceId,
    sourceType: signal.sourceType,
    contentKind: signal.contentKind,
    content: signal.content,
    observedAt: signal.observedAt,
    publishedAt: signal.publishedAt,
    canonicalUrl: signal.canonicalUrl,
    title: signal.title,
    visibleSummary: signal.visibleSummary,
    media: signal.media,
    sourceHints: signal.sourceHints,
    provenance: signal.provenance,
    idempotencyKey: signal.idempotencyKey,
  })).digest('hex')
}

function persistedContext(artifact: RetrievedEvidence): PersistedEvidenceReuseContext | null {
  const value = record(artifact.evidenceReuseContext)
  if (value?.schemaVersion !== EVIDENCE_REUSE_CONTEXT_SCHEMA_VERSION
    || stringValue(value.sourceMaterialHash) === null
    || stringValue(value.requestedUrl) === null
    || stringValue(value.finalUrl) === null
    || stringValue(value.contentHash) === null
    || value.retrievalState !== 'succeeded') return null
  return value as unknown as PersistedEvidenceReuseContext
}

function currentReuseState(input: EvidenceReusePolicyInput): CurrentEvidenceReuseState | null {
  const value = record(input.workItem.retrievalPlan.evidenceReuseState)
  if (value?.schemaVersion !== EVIDENCE_REUSE_CONTEXT_SCHEMA_VERSION) return null
  return {
    schemaVersion: EVIDENCE_REUSE_CONTEXT_SCHEMA_VERSION,
    ...optionalStringMap(value.contentHashByRequestedUrl, 'contentHashByRequestedUrl'),
    ...optionalStringMap(value.finalUrlByRequestedUrl, 'finalUrlByRequestedUrl'),
    ...optionalStringList(value.blockedRequestedUrls, 'blockedRequestedUrls'),
    ...optionalStringList(value.manuallyInvalidatedEvidenceIds, 'manuallyInvalidatedEvidenceIds'),
  }
}

function optionalStringMap(value: unknown, key: 'contentHashByRequestedUrl' | 'finalUrlByRequestedUrl') {
  const input = record(value)
  if (input === null) return {}
  const output: Record<string, string> = {}
  for (const [entryKey, entryValue] of Object.entries(input)) {
    const text = stringValue(entryValue)
    if (text !== null) output[normalizeUrl(entryKey)] = text
  }
  return { [key]: output }
}

function optionalStringList(value: unknown, key: 'blockedRequestedUrls' | 'manuallyInvalidatedEvidenceIds') {
  if (!Array.isArray(value)) return {}
  return { [key]: value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) }
}

function retrievalPlanAllows(work: ResearchWorkItem, requestedUrl: string): boolean {
  try {
    const url = new URL(requestedUrl)
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    return (url.protocol === 'http:' || url.protocol === 'https:') && work.retrievalPlan.allowedDomains.some((domain) => {
      const allowed = domain.toLowerCase().replace(/^\*\./, '').replace(/\.$/, '')
      return host === allowed || host.endsWith(`.${allowed}`)
    })
  } catch {
    return false
  }
}

function normalizeUrl(value: string): string {
  try { return new URL(value).toString() } catch { return value }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}
