import { createHash } from 'node:crypto'
import {
  fetchPublicDocument,
  parseHttpUrl,
  type SafePublicDocument,
  type SafePublicFetchOptions,
} from '../news/safe-public-http'

export type RetrievalUrlAuthority = 'source_url' | 'source_hint' | 'search_connector'
export type RetrievalMethod = 'safe_http'
export type RetrievalFailureCategory =
  | 'retrieval_timeout'
  | 'retrieval_blocked'
  | 'retrieval_unsafe_url'
  | 'budget_exceeded'
  | 'permanent_source_error'

export interface ApprovedRetrievalUrl {
  url: string
  authority: RetrievalUrlAuthority
  authorityId: string
}

export interface DeterministicRetrievalPlan {
  workId: string
  urls: ApprovedRetrievalUrl[]
  allowedDomains: string[]
  maxSources: number
  maxBytesPerSource: number
  maxTotalBytes: number
  maxTextCharsPerSource: number
  maxRedirects: number
  timeoutMs: number
  freshnessDeadline?: string
}

export interface RetrievedEvidenceArtifact {
  schemaVersion: 'myboon.evidence.v1'
  evidenceId: string
  workId: string
  requestedUrl: string
  finalUrl: string
  authority: RetrievalUrlAuthority
  authorityId: string
  contentHash: string
  contentType: string | null
  httpStatus: number
  retrievalMethod: RetrievalMethod
  retrievedAt: string
  text: string
  byteLength: number
  truncated: boolean
}

export interface RetrievalFailure {
  requestedUrl: string
  category: RetrievalFailureCategory
  retryable: boolean
  message: string
}

export interface RetrievalBatch {
  workId: string
  artifacts: RetrievedEvidenceArtifact[]
  failures: RetrievalFailure[]
  skippedUrlCount: number
  totalBytes: number
}

export interface EvidenceFreshnessPolicy {
  policyVersion: string
  maxAgeMs: number
  maxArtifactBytes: number
  invalidateOn: Array<
    | 'content_hash_changed'
    | 'final_url_changed'
    | 'source_material_change'
    | 'retrieval_became_blocked'
    | 'manual_invalidation'
  >
}

export interface EvidenceReuseContext {
  now: string
  contentHash?: string
  finalUrl?: string
  sourceMaterialChanged?: boolean
  retrievalBecameBlocked?: boolean
  manuallyInvalidated?: boolean
}

export class RetrievalPlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RetrievalPlanError'
  }
}

type FetchDocument = (
  url: string,
  options: SafePublicFetchOptions,
) => Promise<SafePublicDocument>

export interface DeterministicRetrieverOptions {
  fetchDocument?: FetchDocument
  now?: () => Date
}

/**
 * Executes a code-owned retrieval plan. It does not discover URLs, invoke an
 * LLM, launch an interactive browser, or mutate queue state.
 */
export class DeterministicRetriever {
  private readonly fetchDocument: FetchDocument
  private readonly now: () => Date

  constructor(options: DeterministicRetrieverOptions = {}) {
    this.fetchDocument = options.fetchDocument ?? fetchPublicDocument
    this.now = options.now ?? (() => new Date())
  }

  async retrieve(plan: DeterministicRetrievalPlan): Promise<RetrievalBatch> {
    validatePlan(plan)
    const startedAt = this.now().getTime()
    const deadlineAt = startedAt + plan.timeoutMs
    const selected = plan.urls.slice(0, plan.maxSources)
    const artifacts: RetrievedEvidenceArtifact[] = []
    const failures: RetrievalFailure[] = []
    let totalBytes = 0

    for (const approved of selected) {
      if (plan.freshnessDeadline && this.now().getTime() >= parseTimestamp(plan.freshnessDeadline, 'freshnessDeadline')) {
        failures.push(failure(approved.url, 'budget_exceeded', false, 'Freshness deadline elapsed before retrieval'))
        break
      }
      const remainingTimeMs = deadlineAt - this.now().getTime()
      if (remainingTimeMs <= 0) {
        failures.push(failure(approved.url, 'retrieval_timeout', true, 'Retrieval plan deadline elapsed'))
        break
      }
      const remainingBytes = plan.maxTotalBytes - totalBytes
      if (remainingBytes <= 0) {
        failures.push(failure(approved.url, 'budget_exceeded', false, 'Retrieval byte budget exhausted'))
        break
      }

      try {
        const allowedBytes = Math.min(plan.maxBytesPerSource, remainingBytes)
        const document = await this.fetchDocument(approved.url, {
          timeoutMs: remainingTimeMs,
          maxBytes: allowedBytes,
          maxRedirects: plan.maxRedirects,
          allowedDomains: plan.allowedDomains,
        })
        if (document.body.length > allowedBytes) {
          throw new Error(`Retrieved document exceeded ${allowedBytes} bytes`)
        }
        if (document.status < 200 || document.status >= 300) {
          failures.push(httpFailure(approved.url, document.status))
          continue
        }
        const converted = convertDocument(document, plan.maxTextCharsPerSource)
        totalBytes += document.body.length
        artifacts.push(buildArtifact(plan.workId, approved, document, converted, this.now().toISOString()))
      } catch (error) {
        failures.push(classifyRetrievalFailure(approved.url, error))
      }
    }

    return {
      workId: plan.workId,
      artifacts,
      failures,
      skippedUrlCount: plan.urls.length - selected.length,
      totalBytes,
    }
  }
}

export function isEvidenceReusable(
  artifact: RetrievedEvidenceArtifact,
  policy: EvidenceFreshnessPolicy,
  context: EvidenceReuseContext,
): boolean {
  if (artifact.byteLength > policy.maxArtifactBytes) return false
  const ageMs = parseTimestamp(context.now, 'now') - parseTimestamp(artifact.retrievedAt, 'retrievedAt')
  if (ageMs < 0 || ageMs > policy.maxAgeMs) return false
  if (policy.invalidateOn.includes('content_hash_changed')
    && context.contentHash !== undefined
    && context.contentHash !== artifact.contentHash) return false
  if (policy.invalidateOn.includes('final_url_changed')
    && context.finalUrl !== undefined
    && normalizeUrl(context.finalUrl) !== normalizeUrl(artifact.finalUrl)) return false
  if (policy.invalidateOn.includes('source_material_change') && context.sourceMaterialChanged) return false
  if (policy.invalidateOn.includes('retrieval_became_blocked') && context.retrievalBecameBlocked) return false
  if (policy.invalidateOn.includes('manual_invalidation') && context.manuallyInvalidated) return false
  return true
}

function validatePlan(plan: DeterministicRetrievalPlan): void {
  if (!plan.workId.trim()) throw new RetrievalPlanError('workId is required')
  if (plan.urls.length === 0) throw new RetrievalPlanError('At least one approved URL is required')
  if (plan.allowedDomains.length === 0) throw new RetrievalPlanError('At least one allowed domain is required')
  for (const field of [
    'maxSources',
    'maxBytesPerSource',
    'maxTotalBytes',
    'maxTextCharsPerSource',
    'timeoutMs',
  ] as const) {
    if (!Number.isInteger(plan[field]) || plan[field] <= 0) {
      throw new RetrievalPlanError(`${field} must be a positive integer`)
    }
  }
  if (!Number.isInteger(plan.maxRedirects) || plan.maxRedirects < 0) {
    throw new RetrievalPlanError('maxRedirects must be a non-negative integer')
  }
  for (const item of plan.urls) {
    parseHttpUrl(item.url)
    if (!item.authorityId.trim()) throw new RetrievalPlanError('Every URL requires an authorityId')
  }
  if (plan.freshnessDeadline) parseTimestamp(plan.freshnessDeadline, 'freshnessDeadline')
}

function buildArtifact(
  workId: string,
  approved: ApprovedRetrievalUrl,
  document: SafePublicDocument,
  converted: { text: string, truncated: boolean },
  retrievedAt: string,
): RetrievedEvidenceArtifact {
  const contentHash = sha256(document.body)
  const finalUrl = normalizeUrl(document.finalUrl)
  const requestedUrl = normalizeUrl(approved.url)
  return {
    schemaVersion: 'myboon.evidence.v1',
    // A retrieval observation is immutable. Revalidating unchanged content at
    // a later time must create a distinct artifact so freshness can advance
    // without rewriting the original retrievedAt timestamp.
    evidenceId: `evidence_${sha256(`${requestedUrl}\n${finalUrl}\n${contentHash}\n${retrievedAt}`)}`,
    workId,
    requestedUrl,
    finalUrl,
    authority: approved.authority,
    authorityId: approved.authorityId,
    contentHash,
    contentType: document.contentType,
    httpStatus: document.status,
    retrievalMethod: 'safe_http',
    retrievedAt,
    text: converted.text,
    byteLength: document.body.length,
    truncated: converted.truncated,
  }
}

function convertDocument(document: SafePublicDocument, maxChars: number): { text: string, truncated: boolean } {
  const mediaType = document.contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? null
  if (mediaType && !mediaType.startsWith('text/') && mediaType !== 'application/xhtml+xml') {
    throw new Error(`Unsupported retrieval content type: ${mediaType}`)
  }
  const raw = document.body.toString('utf8')
  const readable = mediaType === 'text/html' || mediaType === 'application/xhtml+xml' || /<html[\s>]/i.test(raw)
    ? htmlToText(raw)
    : raw.replace(/\u0000/g, '').trim()
  if (!readable) throw new Error('Retrieved document contained no readable text')
  return {
    text: readable.slice(0, maxChars),
    truncated: readable.length > maxChars,
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?(p|div|section|article|main|header|footer|h[1-6]|li|br|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}

function classifyRetrievalFailure(requestedUrl: string, error: unknown): RetrievalFailure {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : ''
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'ETIMEDOUT' || /timed out/i.test(message)) {
    return failure(requestedUrl, 'retrieval_timeout', true, message)
  }
  if (/non-public|not public|outside the approved domain|must use http|must not include credentials|invalid/i.test(message)) {
    return failure(requestedUrl, 'retrieval_unsafe_url', false, message)
  }
  if (/exceeded .* bytes|byte budget/i.test(message)) {
    return failure(requestedUrl, 'budget_exceeded', false, message)
  }
  if (/unsupported retrieval content type|no readable text/i.test(message)) {
    return failure(requestedUrl, 'retrieval_blocked', false, message)
  }
  return failure(requestedUrl, 'permanent_source_error', false, message)
}

function httpFailure(requestedUrl: string, status: number): RetrievalFailure {
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return failure(requestedUrl, 'retrieval_blocked', true, `Retrieval returned HTTP ${status}`)
  }
  return failure(requestedUrl, 'permanent_source_error', false, `Retrieval returned HTTP ${status}`)
}

function failure(
  requestedUrl: string,
  category: RetrievalFailureCategory,
  retryable: boolean,
  message: string,
): RetrievalFailure {
  return { requestedUrl, category, retryable, message: message.slice(0, 500) }
}

function normalizeUrl(rawUrl: string): string {
  return parseHttpUrl(rawUrl).toString()
}

function parseTimestamp(value: string, field: string): number {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new RetrievalPlanError(`${field} must be an ISO timestamp`)
  return timestamp
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
