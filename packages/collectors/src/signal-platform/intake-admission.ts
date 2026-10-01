import { createHash } from 'node:crypto'
import { stableContractId } from './adapters/identity'
import { canonicalJson } from './canonical-json'
import type { ResearchWorkItem, Signal } from './contracts'
import type { TriageDecisionV1 } from './triage-contracts'
import { createResearchWorkItemFromDecision, type ResearchWorkCreationPolicy } from './triage-engine'
import { ContractValidationError, validateResearchWorkItem } from './validation'

export const ADMISSION_DISPOSITION_SCHEMA_VERSION = 'myboon.admission_disposition.v1' as const

/**
 * Intake mode provenance. It is recorded with the admission so a later reader
 * can tell a deliberate observe decision from a lost active admission; the
 * legacy decision schema alone cannot prove which mode produced a row.
 */
export type IntakeMode = 'shadow' | 'observe' | 'active'

/**
 * Admission intent, which is a different fact from the triage decision.
 *
 * - `active_intake`: an active-mode admission that requires the frozen work row.
 * - `observe_evaluation`: observe mode recorded the decision and deliberately
 *   withheld admission.
 * - `no_work_outcome`: an active-mode decision that is deliberately no-work
 *   (archive/defer), not a lost admission.
 * - `admission_withheld`: an active-mode request that reused a decision already
 *   recorded in another mode. Authorization for a new active admission of
 *   observed material is a separate, explicitly recorded event.
 */
export type AdmissionAuthorization =
  | 'active_intake'
  | 'observe_evaluation'
  | 'no_work_outcome'
  | 'admission_withheld'

/**
 * Versioned admission disposition with the frozen canonical work payload.
 *
 * A stable work identity does not freeze the inputs that produced it, so the
 * original work payload, its digest, and the retrieval policy snapshot are
 * retained here. Recovery replays this record instead of re-deriving the
 * payload from the current clock, capacity, or retrieval policy.
 */
export interface AdmissionDispositionV1 {
  schemaVersion: typeof ADMISSION_DISPOSITION_SCHEMA_VERSION
  dispositionId: string
  signalId: string
  sourceType: Signal['sourceType']
  decisionId: string
  mode: IntakeMode
  authorization: AdmissionAuthorization
  requiresWork: boolean
  workId: string | null
  workPayload: ResearchWorkItem | null
  workPayloadDigest: string | null
  retrievalPolicyVersion: string | null
  retrievalPolicy: ResearchWorkCreationPolicy | null
  reason: string
  recordedAt: string
}

export function admissionWorkPayloadDigest(work: ResearchWorkItem): string {
  return createHash('sha256').update(canonicalJson(work), 'utf8').digest('hex')
}

export function isActiveAdmissionIntake(disposition: AdmissionDispositionV1): boolean {
  return disposition.authorization === 'active_intake' && disposition.requiresWork
}

export function createActiveIntakeDisposition(input: {
  signal: Signal
  decision: TriageDecisionV1
  work: ResearchWorkItem
  retrievalPolicy: ResearchWorkCreationPolicy
  recordedAt: string
}): AdmissionDispositionV1 {
  const work = validateResearchWorkItem(input.work)
  assertDecisionIdentity(input.signal, input.decision)
  if (work.signalId !== input.signal.signalId || work.triageDecisionId !== input.decision.decisionId) {
    throw new ContractValidationError(
      'admissionDisposition.workPayload',
      'must be the work item derived from this decision',
    )
  }
  // The frozen payload must be exactly what this decision and this frozen
  // retrieval policy derive, so an admission cannot smuggle in a different plan.
  const derived = createResearchWorkItemFromDecision({
    signal: input.signal,
    decision: input.decision,
    retrievalPolicy: input.retrievalPolicy,
  })
  if (canonicalJson(derived) !== canonicalJson(work)) {
    throw new ContractValidationError(
      'admissionDisposition.workPayload',
      'must be the work item derived from this decision',
    )
  }
  return validateAdmissionDisposition({
    schemaVersion: ADMISSION_DISPOSITION_SCHEMA_VERSION,
    dispositionId: admissionDispositionId(input.decision.decisionId, 'active'),
    signalId: input.signal.signalId,
    sourceType: input.signal.sourceType,
    decisionId: input.decision.decisionId,
    mode: 'active',
    authorization: 'active_intake',
    requiresWork: true,
    workId: work.workId,
    workPayload: work,
    workPayloadDigest: admissionWorkPayloadDigest(work),
    retrievalPolicyVersion: input.retrievalPolicy.policyVersion,
    retrievalPolicy: structuredClone(input.retrievalPolicy),
    reason: 'Active intake admitted the frozen canonical work payload.',
    recordedAt: input.recordedAt,
  })
}

export function createNoAdmissionDisposition(input: {
  signal: Signal
  decision: TriageDecisionV1
  mode: Exclude<IntakeMode, 'shadow'>
  authorization: Exclude<AdmissionAuthorization, 'active_intake'>
  reason: string
  recordedAt: string
}): AdmissionDispositionV1 {
  assertDecisionIdentity(input.signal, input.decision)
  return validateAdmissionDisposition({
    schemaVersion: ADMISSION_DISPOSITION_SCHEMA_VERSION,
    dispositionId: admissionDispositionId(input.decision.decisionId, input.mode),
    signalId: input.signal.signalId,
    sourceType: input.signal.sourceType,
    decisionId: input.decision.decisionId,
    mode: input.mode,
    authorization: input.authorization,
    requiresWork: false,
    workId: null,
    workPayload: null,
    workPayloadDigest: null,
    retrievalPolicyVersion: null,
    retrievalPolicy: null,
    reason: input.reason,
    recordedAt: input.recordedAt,
  })
}

export function admissionDispositionId(decisionId: string, mode: IntakeMode): string {
  return stableContractId('admission', decisionId, mode)
}

export function validateAdmissionDisposition(value: unknown): AdmissionDispositionV1 {
  const record = object(value, 'admissionDisposition')
  literal(record.schemaVersion, ADMISSION_DISPOSITION_SCHEMA_VERSION, 'admissionDisposition.schemaVersion')
  for (const key of ['dispositionId', 'signalId', 'decisionId', 'reason'] as const) {
    nonEmpty(record[key], `admissionDisposition.${key}`)
  }
  oneOf(record.sourceType, ['news', 'polymarket', 'market_calendar', 'x'], 'admissionDisposition.sourceType')
  const mode = oneOf(record.mode, ['shadow', 'observe', 'active'], 'admissionDisposition.mode')
  const authorization = oneOf(
    record.authorization,
    ['active_intake', 'observe_evaluation', 'no_work_outcome', 'admission_withheld'],
    'admissionDisposition.authorization',
  )
  if (record.dispositionId !== admissionDispositionId(record.decisionId as string, mode)) {
    throw new ContractValidationError(
      'admissionDisposition.dispositionId',
      'must be stable for its decision and intake mode',
    )
  }
  if ((authorization === 'active_intake' && mode !== 'active')
    || (authorization === 'observe_evaluation' && mode !== 'observe')
    || ((authorization === 'no_work_outcome' || authorization === 'admission_withheld') && mode !== 'active')) {
    throw new ContractValidationError(
      'admissionDisposition.authorization',
      'must agree with the recorded intake mode',
    )
  }
  timestamp(record.recordedAt, 'admissionDisposition.recordedAt')
  if (typeof record.requiresWork !== 'boolean') {
    throw new ContractValidationError('admissionDisposition.requiresWork', 'must be boolean')
  }
  if (record.requiresWork !== (authorization === 'active_intake')) {
    throw new ContractValidationError(
      'admissionDisposition.requiresWork',
      'must be true only for an active intake authorization',
    )
  }
  if (!record.requiresWork) {
    for (const key of ['workId', 'workPayload', 'workPayloadDigest', 'retrievalPolicyVersion', 'retrievalPolicy'] as const) {
      if (record[key] !== null) {
        throw new ContractValidationError(`admissionDisposition.${key}`, 'must be null without admission')
      }
    }
    return value as AdmissionDispositionV1
  }
  nonEmpty(record.workId, 'admissionDisposition.workId')
  nonEmpty(record.retrievalPolicyVersion, 'admissionDisposition.retrievalPolicyVersion')
  const work = validateResearchWorkItem(record.workPayload)
  if (work.workId !== record.workId || work.signalId !== record.signalId) {
    throw new ContractValidationError(
      'admissionDisposition.workPayload',
      'must match the disposition signal and work identity',
    )
  }
  if (work.triageDecisionId !== record.decisionId) {
    throw new ContractValidationError(
      'admissionDisposition.workPayload.triageDecisionId',
      'must match the originating decision',
    )
  }
  const policy = object(record.retrievalPolicy, 'admissionDisposition.retrievalPolicy')
  nonEmpty(policy.policyVersion, 'admissionDisposition.retrievalPolicy.policyVersion')
  if (policy.policyVersion !== record.retrievalPolicyVersion) {
    throw new ContractValidationError(
      'admissionDisposition.retrievalPolicyVersion',
      'must match the frozen retrieval policy',
    )
  }
  if (!Array.isArray(policy.allowedDomains)
    || policy.allowedDomains.some((domain) => typeof domain !== 'string')) {
    throw new ContractValidationError('admissionDisposition.retrievalPolicy.allowedDomains', 'must be strings')
  }
  const byDepth = object(
    policy.maxExternalSourcesByDepth,
    'admissionDisposition.retrievalPolicy.maxExternalSourcesByDepth',
  )
  for (const depth of ['light', 'standard', 'deep'] as const) {
    if (!Number.isInteger(byDepth[depth]) || Number(byDepth[depth]) < 0) {
      throw new ContractValidationError(
        `admissionDisposition.retrievalPolicy.maxExternalSourcesByDepth.${depth}`,
        'must be a non-negative integer',
      )
    }
  }
  if (record.workPayloadDigest !== admissionWorkPayloadDigest(work)) {
    throw new ContractValidationError(
      'admissionDisposition.workPayloadDigest',
      'must equal the digest of the frozen work payload',
    )
  }
  return value as AdmissionDispositionV1
}

function assertDecisionIdentity(signal: Signal, decision: TriageDecisionV1): void {
  if (decision.signalId !== signal.signalId || decision.sourceType !== signal.sourceType) {
    throw new Error('Triage decision does not belong to the supplied signal')
  }
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

function nonEmpty(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ContractValidationError(path, 'must be non-empty')
  }
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ContractValidationError(path, `must be one of ${allowed.join(', ')}`)
  }
  return value as T
}

function timestamp(value: unknown, path: string): void {
  nonEmpty(value, path)
  if (!Number.isFinite(Date.parse(value))) throw new ContractValidationError(path, 'must be a timestamp')
}
