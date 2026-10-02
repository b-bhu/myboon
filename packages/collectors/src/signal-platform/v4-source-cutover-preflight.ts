import { assertActiveCutoverReceipts } from './cutover-receipt'
import type { CutoverStage } from './cutover-receipt'
import type { FeedV3Source } from './runtime-config'

export const V4_SOURCE_CUTOVER_PREFLIGHT_ENABLED_BY_DEFAULT = false as const
export type V4CutoverAction = 'cutover' | 'retire_legacy' | 'rollback'
export type V4CutoverOwner = 'legacy' | 'shared'
export type V4CutoverDomain = 'research' | 'entity'

export interface V4CutoverPreflightInput {
  enabled?: boolean
  action: V4CutoverAction
  source: Extract<FeedV3Source, 'news' | 'polymarket'>
  /** Required to enforce the fixed source order. */
  newsCutoverComplete?: boolean
  /** Separate owner domains are required; one cannot imply the other. */
  owners: Readonly<Record<V4CutoverDomain, V4CutoverOwner>>
  receiptManifestPath?: string | null
  now?: Date
  /** Explicit product/operator approval; this module invents no thresholds. */
  ownerApprovedEvaluation: boolean
  backupRestoreVerified: boolean
  outboxReconciled: boolean
  cursorReconciled: boolean
  inflightReconciled: boolean
  canonicalPathHealthy?: boolean
  residualReferencesAccounted?: boolean
  /** Rollback sequencing: stop claims, reconcile obligations, establish exclusivity, then reopen prior owner. */
  newClaimsStopped?: boolean
  priorOwnerReopened?: boolean
  /** Must be true only after exclusive ownership has been independently established. */
  exclusiveOwnershipEstablished?: boolean
  /** Supplied only by an implementation that verifies the source-level Stage 7 receipt and bound artifacts. */
  verifySourceOwnershipEvidence?: (source: V4CutoverPreflightInput['source']) => boolean
  /** Independent writer fence proving obsolete collector queue writes are stopped. */
  obsoleteQueueWritesStopped?: boolean
}

export interface V4CutoverPreflightDecision {
  /** Advisory checks only: caller assertions and a mutable receipt path are not cutover authority. */
  advisoryChecksPassed: boolean
  /** No V4 action is authorized until source evidence and writer fences are independently bound at execution. */
  authorizesOwnershipChange: false
  source: V4CutoverPreflightInput['source']
  action: V4CutoverAction
  reasons: ReadonlyArray<string>
  receiptPairsRequired: ReadonlyArray<{ sourceType: V4CutoverPreflightInput['source']; stage: CutoverStage }>
}

/**
 * Read-only advisory helper. Its caller-supplied assertions and mutable receipt
 * path cannot authorize a cutover, retirement, or rollback. The eventual action
 * must bind and recheck evidence and writer fences atomically at execution.
 */
export function evaluateV4SourceCutoverPreflight(input: V4CutoverPreflightInput): V4CutoverPreflightDecision {
  const reasons: string[] = []
  const receiptPairsRequired = (['research', 'entity'] as const).map((stage) => ({ sourceType: input.source, stage }))
  if (input.enabled !== true) reasons.push('preflight is disabled (opt in explicitly)')
  if (input.source === 'polymarket' && input.action !== 'rollback' && input.newsCutoverComplete !== true) {
    reasons.push('news cutover must complete before polymarket')
  }
  if (!input.ownerApprovedEvaluation) reasons.push('owner-approved evaluation is required')
  if (!input.backupRestoreVerified) reasons.push('backup and restore verification is required')
  if (!input.outboxReconciled) reasons.push('outbox obligations must be reconciled')
  if (!input.cursorReconciled) reasons.push('consumer cursors must be reconciled')
  if (!input.inflightReconciled) reasons.push('in-flight work must be reconciled')
  if (input.action === 'retire_legacy' && (!input.canonicalPathHealthy || !input.residualReferencesAccounted)) {
    reasons.push('legacy retirement requires a healthy canonical path and accounted residual references')
  }
  if (input.action === 'retire_legacy') {
    if (!input.verifySourceOwnershipEvidence) reasons.push('source-level ownership receipt verifier is not supplied; retirement is not ready')
    else {
      try {
        if (input.verifySourceOwnershipEvidence(input.source) !== true) reasons.push('source-level ownership evidence is missing or invalid')
      } catch {
        reasons.push('source-level ownership evidence is missing or invalid')
      }
    }
    if (!input.obsoleteQueueWritesStopped) reasons.push('obsolete collector queue writes must be fenced before retirement')
  }
  if (input.action === 'rollback') {
    if (!input.newClaimsStopped) reasons.push('stop new claims before rollback')
    if (!input.exclusiveOwnershipEstablished) reasons.push('establish exclusive ownership before rollback')
    if (!input.priorOwnerReopened) reasons.push('prior owner may reopen only after reconciliation and exclusivity')
  }
  if ((input.owners.research !== 'shared' || input.owners.entity !== 'shared') && input.action === 'retire_legacy') {
    reasons.push('legacy retirement requires both research and entity ownership to be shared')
  }
  if (input.action === 'cutover' && input.owners.research === 'shared' && input.owners.entity === 'shared') {
    reasons.push('both owner domains already report shared ownership')
  }
  if (input.action !== 'rollback') {
    if (!input.receiptManifestPath) reasons.push('separate research and entity cutover receipts are required')
    else {
      try {
        assertActiveCutoverReceipts({ path: input.receiptManifestPath, required: receiptPairsRequired, ...(input.now ? { now: input.now } : {}) })
      } catch (error) {
        reasons.push(`research/entity receipt validation failed: ${error instanceof Error ? error.message : 'unknown error'}`)
      }
    }
  }
  return Object.freeze({ advisoryChecksPassed: reasons.length === 0, authorizesOwnershipChange: false as const, source: input.source, action: input.action, reasons: Object.freeze(reasons), receiptPairsRequired: Object.freeze(receiptPairsRequired) })
}
