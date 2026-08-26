import type { ResearchWorkItem, RetrievedEvidence, Signal } from '../signal-platform/contracts'
import {
  isEvidenceReusable,
  type EvidenceFreshnessPolicy,
  type EvidenceReuseContext,
  type RetrievedEvidenceArtifact,
} from './deterministic-retrieval'

export const WORK_CONTRACT_EVIDENCE_REUSE_POLICY_VERSION = 'myboon.evidence_reuse.work_contract.v1' as const

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
  void input
  return {}
}
