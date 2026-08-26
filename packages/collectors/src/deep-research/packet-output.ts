import { createHash } from 'node:crypto'
import {
  RESEARCH_PACKET_SCHEMA_VERSION,
  type ResearchCompletion,
  type ResearchPacketV1,
} from '../signal-platform/contracts'
import { validateResearchPacket } from '../signal-platform/validation'
import { DeepResearchError } from './errors'
import {
  DEEP_RESEARCH_RESULT_SCHEMA_VERSION,
  type DeepResearchJob,
  type DeepResearchResult,
} from './types'

export const DEEP_RESEARCH_OUTPUT_SCHEMA_VERSION = 'myboon.deep_research_output.v1' as const

export interface DeepResearchOutputClaim {
  claim: string
  attributedTo: string | null
  evidenceRefs: string[]
}

export interface DeepResearchOutputVerifiedFact {
  fact: string
  evidenceRefs: string[]
}

export interface DeepResearchOutputUnresolvedClaim {
  claim: string
  reason: string
  evidenceRefs: string[]
}

export interface DeepResearchOutputEntityHint {
  name: string
  type: string | null
  role: string | null
  aliases: string[]
  source: string | null
  evidenceRefs: string[]
}

export interface DeepResearchApprovedResult {
  resultRef: string
  title: string
  url: string
  observedAt: string | null
  note: string | null
}

/** The complete model-owned stdout contract. All packet identity is omitted. */
export interface DeepResearchOutputBody {
  schemaVersion: typeof DEEP_RESEARCH_OUTPUT_SCHEMA_VERSION
  claims: DeepResearchOutputClaim[]
  verifiedFacts: DeepResearchOutputVerifiedFact[]
  unresolvedClaims: DeepResearchOutputUnresolvedClaim[]
  entityHints: DeepResearchOutputEntityHint[]
  approvedResults: DeepResearchApprovedResult[]
  limitations: string[]
  openQuestions: string[]
  completion: ResearchCompletion
}

export interface DeepResearchPacketPolicyMetadata {
  provider: string
  model: string
  promptVersion: string
}

const ROOT_KEYS = [
  'schemaVersion', 'claims', 'verifiedFacts', 'unresolvedClaims', 'entityHints',
  'approvedResults', 'limitations', 'openQuestions', 'completion',
] as const

export function parseDeepResearchOutput(stdout: string, job: DeepResearchJob): DeepResearchOutputBody {
  if (!stdout.trim() || Buffer.byteLength(stdout, 'utf8') > job.budget.maxOutputBytes) {
    throw invalidOutput('Contained stdout is empty or exceeds its declared byte budget')
  }
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch (error) {
    throw invalidOutput('Contained stdout must be one JSON object with no wrapper text', error)
  }
  const root = exactObject(value, ROOT_KEYS, 'output')
  if (root.schemaVersion !== DEEP_RESEARCH_OUTPUT_SCHEMA_VERSION) {
    throw invalidOutput('Contained stdout schemaVersion is unsupported')
  }

  const suppliedIds = new Set(job.evidence.map((item) => item.evidenceId))
  const approvedResults = objectArray(root.approvedResults, 'output.approvedResults', 50, (item, path) => {
    exactKeys(item, ['resultRef', 'title', 'url', 'observedAt', 'note'], path)
    const resultRef = boundedIdentifier(item.resultRef, `${path}.resultRef`)
    if (suppliedIds.has(resultRef)) throw invalidOutput(`${path}.resultRef collides with supplied evidence`)
    const url = approvedUrl(item.url, job.approvedDomains, `${path}.url`)
    return {
      resultRef,
      title: boundedString(item.title, `${path}.title`, 1, 500),
      url,
      observedAt: nullableTimestamp(item.observedAt, `${path}.observedAt`),
      note: nullableBoundedString(item.note, `${path}.note`, 1_000),
    }
  })
  const resultRefs = new Set(approvedResults.map((item) => item.resultRef))
  if (resultRefs.size !== approvedResults.length) throw invalidOutput('approvedResults resultRef values must be unique')
  const allowedRefs = new Set([...suppliedIds, ...resultRefs])

  const claims = objectArray(root.claims, 'output.claims', 100, (item, path) => {
    exactKeys(item, ['claim', 'attributedTo', 'evidenceRefs'], path)
    return {
      claim: boundedString(item.claim, `${path}.claim`, 1, 4_000),
      attributedTo: nullableBoundedString(item.attributedTo, `${path}.attributedTo`, 500),
      evidenceRefs: evidenceRefs(item.evidenceRefs, allowedRefs, `${path}.evidenceRefs`, false),
    }
  })
  const verifiedFacts = objectArray(root.verifiedFacts, 'output.verifiedFacts', 100, (item, path) => {
    exactKeys(item, ['fact', 'evidenceRefs'], path)
    return {
      fact: boundedString(item.fact, `${path}.fact`, 1, 4_000),
      evidenceRefs: evidenceRefs(item.evidenceRefs, allowedRefs, `${path}.evidenceRefs`, true),
    }
  })
  const unresolvedClaims = objectArray(root.unresolvedClaims, 'output.unresolvedClaims', 100, (item, path) => {
    exactKeys(item, ['claim', 'reason', 'evidenceRefs'], path)
    return {
      claim: boundedString(item.claim, `${path}.claim`, 1, 4_000),
      reason: boundedString(item.reason, `${path}.reason`, 1, 2_000),
      evidenceRefs: evidenceRefs(item.evidenceRefs, allowedRefs, `${path}.evidenceRefs`, false),
    }
  })
  const entityHints = objectArray(root.entityHints, 'output.entityHints', 100, (item, path) => {
    exactKeys(item, ['name', 'type', 'role', 'aliases', 'source', 'evidenceRefs'], path)
    return {
      name: boundedString(item.name, `${path}.name`, 1, 500),
      type: nullableBoundedString(item.type, `${path}.type`, 200),
      role: nullableBoundedString(item.role, `${path}.role`, 500),
      aliases: stringArray(item.aliases, `${path}.aliases`, 50, 500),
      source: nullableBoundedString(item.source, `${path}.source`, 500),
      evidenceRefs: evidenceRefs(item.evidenceRefs, allowedRefs, `${path}.evidenceRefs`, true),
    }
  })
  const limitations = stringArray(root.limitations, 'output.limitations', 100, 2_000)
  const openQuestions = stringArray(root.openQuestions, 'output.openQuestions', 100, 2_000)
  if (root.completion !== 'complete' && root.completion !== 'partial' && root.completion !== 'failed') {
    throw invalidOutput('output.completion must be complete, partial, or failed')
  }
  return {
    schemaVersion: DEEP_RESEARCH_OUTPUT_SCHEMA_VERSION,
    claims, verifiedFacts, unresolvedClaims, entityHints, approvedResults,
    limitations, openQuestions, completion: root.completion,
  }
}

export function assembleDeepResearchPacket(input: {
  job: DeepResearchJob
  result: DeepResearchResult
  body: DeepResearchOutputBody
  policy: DeepResearchPacketPolicyMetadata
  attempt: number
  createdAt: string
  queuedAt: string
}): ResearchPacketV1 {
  const { job, result, body, policy } = input
  const expectedCapabilities = [...job.capabilities].sort()
  const actualCapabilities = [...result.capabilities].sort()
  if (result.schemaVersion !== DEEP_RESEARCH_RESULT_SCHEMA_VERSION
    || result.jobId !== job.jobId || result.workId !== job.workItem.workId || result.traceId !== job.workItem.traceId
    || expectedCapabilities.length !== actualCapabilities.length
    || expectedCapabilities.some((capability, index) => capability !== actualCapabilities[index])) {
    throw invalidOutput('Contained execution result linkage does not match the canonical job')
  }
  validateMeasuredUsage(result, job)
  for (const [name, value] of Object.entries(policy)) {
    boundedString(value, `policy.${name}`, 1, 500)
  }
  const packetId = deterministicDeepPacketId(job.workItem.workId, job.workItem.researchContractVersion)
  const resultEvidenceIds = new Map(body.approvedResults.map((item) => [
    item.resultRef,
    stableId('deep_evidence', packetId, item.url),
  ]))
  const mapRefs = (refs: string[]) => refs.map((ref) => resultEvidenceIds.get(ref) ?? ref)
  const packet: ResearchPacketV1 = {
    schemaVersion: RESEARCH_PACKET_SCHEMA_VERSION,
    packetId,
    workId: job.workItem.workId,
    signalId: job.signal.signalId,
    sourceType: job.signal.sourceType,
    observedAt: job.signal.observedAt,
    sourceSignal: {
      sourceId: job.signal.sourceId,
      title: job.signal.title,
      canonicalUrl: job.signal.canonicalUrl,
      publishedAt: job.signal.publishedAt,
      provenance: { ...job.signal.provenance },
      visibleSummary: job.signal.visibleSummary,
      contentKind: job.signal.contentKind,
      content: { ...job.signal.content },
      media: { ...job.signal.media },
      sourceHints: {
        ...job.signal.sourceHints,
        entities: [...job.signal.sourceHints.entities],
        assets: [...job.signal.sourceHints.assets],
      },
    },
    claims: body.claims.map((claim, index) => ({
      claimId: stableId('claim', packetId, String(index), claim.claim),
      claim: claim.claim,
      attributedTo: claim.attributedTo,
      evidenceRefs: mapRefs(claim.evidenceRefs),
    })),
    verifiedFacts: body.verifiedFacts.map((fact) => ({ ...fact, evidenceRefs: mapRefs(fact.evidenceRefs) })),
    unresolvedClaims: body.unresolvedClaims.map((claim) => ({ ...claim, evidenceRefs: mapRefs(claim.evidenceRefs) })),
    evidence: [
      ...job.evidence.map((artifact) => ({
        evidenceId: artifact.evidenceId,
        title: artifact.authority === 'source_url' ? job.signal.title : artifact.finalUrl,
        url: artifact.finalUrl,
        sourceType: artifact.authority,
        observedAt: artifact.retrievedAt,
        note: artifact.truncated ? 'Deterministic retrieval output was truncated.' : null,
      })),
      ...body.approvedResults.map((item) => ({
        evidenceId: resultEvidenceIds.get(item.resultRef)!,
        title: item.title,
        url: item.url,
        sourceType: 'deep_research_approved_result',
        observedAt: item.observedAt,
        note: item.note,
      })),
    ],
    entityHints: body.entityHints.map((hint) => ({
      name: hint.name,
      type: hint.type,
      role: hint.role,
      aliases: [...hint.aliases],
      source: hint.source,
      claimRefs: [],
      evidenceRefs: mapRefs(hint.evidenceRefs),
    })),
    limitations: [...body.limitations],
    openQuestions: [...body.openQuestions],
    completion: body.completion,
    budgetUsed: {
      providerCalls: result.budgetUsed.providerCalls,
      repairCalls: 0,
      inputTokens: result.budgetUsed.inputTokens,
      outputTokens: result.budgetUsed.outputTokens,
      toolCalls: result.budgetUsed.toolCalls,
      wallTimeMs: result.durationMs,
      budgetExceeded: false,
    },
    execution: {
      provider: policy.provider,
      model: policy.model,
      fallbackProvider: null,
      fallbackModel: null,
      fallbackUsed: false,
      promptVersion: policy.promptVersion,
      policyVersion: job.workItem.policyVersion,
      traceId: job.workItem.traceId,
      attempt: input.attempt,
      containedUnit: result.unitName,
      containedStartedAt: result.startedAt,
      containedFinishedAt: result.finishedAt,
      queueWaitMs: elapsedMs(input.queuedAt, result.startedAt),
      containmentCapabilities: [...result.capabilities],
      outputBytes: result.budgetUsed.outputBytes,
    },
    researchContractVersion: job.workItem.researchContractVersion,
    createdAt: input.createdAt,
  }
  try {
    return validateResearchPacket(packet)
  } catch (error) {
    throw invalidOutput('Code-assembled deep research packet failed canonical validation', error)
  }
}

export function deterministicDeepPacketId(workId: string, researchContractVersion: string): string {
  return stableId('deep_research', workId, researchContractVersion)
}

function approvedUrl(value: unknown, domains: readonly string[], path: string): string {
  const raw = boundedString(value, path, 1, 2_000)
  let url: URL
  try { url = new URL(raw) } catch (error) { throw invalidOutput(`${path} must be an absolute URL`, error) }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.hash) {
    throw invalidOutput(`${path} is not an approved public HTTP URL`)
  }
  const hostname = url.hostname.toLowerCase()
  if (!domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
    throw invalidOutput(`${path} is outside the job approved domains`)
  }
  return url.toString()
}

function validateMeasuredUsage(result: DeepResearchResult, job: DeepResearchJob): void {
  const limits = {
    providerCalls: job.budget.maxProviderCalls,
    inputTokens: job.budget.maxInputTokens,
    outputTokens: job.budget.maxOutputTokens,
    toolCalls: job.budget.maxToolCalls,
    wallTimeMs: job.budget.maxWallTimeMs,
    outputBytes: job.budget.maxOutputBytes,
  } as const
  const usage = result.budgetUsed as unknown as Record<string, unknown>
  for (const [field, limit] of Object.entries(limits)) {
    const measured = usage[field]
    if (!Number.isInteger(measured) || (measured as number) < 0) {
      throw invalidOutput(`Contained measured ${field} is missing or invalid`)
    }
    if ((measured as number) > limit) {
      throw new DeepResearchError(`Contained measured ${field} exceeded its executable budget`, {
        category: 'budget_exceeded', retryable: false,
      })
    }
  }
}

function evidenceRefs(value: unknown, allowed: ReadonlySet<string>, path: string, required: boolean): string[] {
  const refs = stringArray(value, path, 100, 300)
  if (required && refs.length === 0) throw invalidOutput(`${path} must not be empty`)
  if (new Set(refs).size !== refs.length || refs.some((ref) => !allowed.has(ref))) {
    throw invalidOutput(`${path} contains duplicate or unknown evidence references`)
  }
  return refs
}

function exactObject(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidOutput(`${path} must be an object`)
  const record = value as Record<string, unknown>
  exactKeys(record, keys, path)
  return record
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalidOutput(`${path} must contain exactly: ${keys.join(', ')}`)
  }
}

function objectArray<T>(
  value: unknown,
  path: string,
  max: number,
  map: (item: Record<string, unknown>, path: string) => T,
): T[] {
  if (!Array.isArray(value) || value.length > max) throw invalidOutput(`${path} must be an array of at most ${max}`)
  return value.map((item, index) => map(exactObjectShape(item, `${path}[${index}]`), `${path}[${index}]`))
}

function exactObjectShape(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidOutput(`${path} must be an object`)
  return value as Record<string, unknown>
}

function stringArray(value: unknown, path: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw invalidOutput(`${path} must be a bounded string array`)
  return value.map((item, index) => boundedString(item, `${path}[${index}]`, 1, maxLength))
}

function boundedIdentifier(value: unknown, path: string): string {
  const result = boundedString(value, path, 1, 200)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(result)) throw invalidOutput(`${path} must be a safe identifier`)
  return result
}

function boundedString(value: unknown, path: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max || value.includes('\0')) {
    throw invalidOutput(`${path} must be a bounded non-empty string`)
  }
  return value
}

function nullableBoundedString(value: unknown, path: string, max: number): string | null {
  return value === null ? null : boundedString(value, path, 1, max)
}

function nullableTimestamp(value: unknown, path: string): string | null {
  if (value === null) return null
  const result = boundedString(value, path, 1, 100)
  if (!Number.isFinite(Date.parse(result))) throw invalidOutput(`${path} must be an ISO timestamp or null`)
  return result
}

function stableId(prefix: string, ...parts: string[]): string {
  const digest = createHash('sha256')
    .update(parts.map((part) => `${part.length}:${part}`).join('|'))
    .digest('hex')
    .slice(0, 32)
  return `${prefix}_${digest}`
}

function elapsedMs(start: string, finish: string): number {
  const value = Date.parse(finish) - Date.parse(start)
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function invalidOutput(message: string, cause?: unknown): DeepResearchError {
  return new DeepResearchError(message, { category: 'invalid_job', retryable: false, cause })
}
