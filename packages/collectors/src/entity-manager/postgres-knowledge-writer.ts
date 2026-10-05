import { createHash } from 'node:crypto'
import { Pool } from 'pg'
import { canonicalJson } from '../signal-platform/canonical-json'
import { isArticleResearchPacket, type ArticleResearchPacketV1, type ResearchPacket, type Signal } from '../signal-platform/contracts'
import { validateResearchPacket } from '../signal-platform/validation'
import type { EntityHandoffContext } from './canonical-packet-adapter'
import {
  KnowledgeOperationConflictError,
  KnowledgeOperationFencingError,
  KnowledgeOperationStaleTargetError,
  knowledgeOperationSemanticDigest,
  normalizeCommitInput,
  normalizeHoldInput,
  type KnowledgeOperationCommitInput,
  type KnowledgeOperationCommitResult,
  type KnowledgeOperationHoldInput,
  type KnowledgeOperationLease,
  type KnowledgeOperationReceipt,
  type KnowledgeOperationWriterPort,
  type SavedProgressionPlan,
  type SaveProgressionPlanInput,
} from './knowledge-operation-store'
import { progressionPlanDigest, type ItemEvidenceRef } from './progression-plan'
import { progressionSourcePacketDigest } from './progression-source-packet-reader'
import { buildProgressionEffects, deriveProgressionAttemptDigest, type ProgressionPlanMetadata } from './progression-processor'
import type { EntityRecord } from './types'

export interface ManagedEntityBinding extends EntityRecord {
  revision: string
  /** Null for a private new identity; existing public catalogue rows stay unchanged. */
  catalogEntityId: string | null
  identityKey: string
}

export interface ManagedContextItem {
  itemId: string
  entityIds: string[]
  note: string
  status: 'active' | 'corrected' | 'superseded' | 'retracted'
  revision: string
  observedAt: string
  packetRefs: string[]
  evidenceRefs: ItemEvidenceRef[]
  successorItemIds: string[]
}

export interface ManagedResearchContext {
  entities: ManagedEntityBinding[]
  items: ManagedContextItem[]
  digest: string
  watermark: string
  truncated: boolean
}

/** Private context used only to validate Researcher's prepared article placement. */
export interface ManagedArticleContext extends ManagedResearchContext {
  /** Story entries retain their physical origin; legacy IDs never become managed IDs. */
  articleItems: Array<{
    itemId: string
    entityId: string
    origin: 'legacy' | 'managed'
    title: string
    summary: string
    publishedAt: string | null
    eventAt: string | null
    observedAt: string
    /** Public catalogue identity for legacy records; private rows retain their mapping. */
    catalogEntityId: string | null
    aliases: string[]
    metadata: Record<string, unknown>
    revision: string
  }>
}

export interface ArticleCommitInput {
  operationId: string
  workId: string
  owner: string
  epoch: number
  packet: ArticleResearchPacketV1
  contextDigest: string
  contextWatermark: string
  targetRevisions: Record<string, string>
  entities: readonly ManagedEntityBinding[]
  /** Null means the source is deliberately attached to an existing duplicate. */
  itemId: string | null
  duplicateTarget: { itemId: string, source: 'legacy' | 'managed', entityId: string } | null
}

export interface ArticleHoldInput {
  operationId: string
  workId: string
  owner: string
  epoch: number
  reason: string
  missingDependency: string
  retainedPayload: unknown
}

export interface ManagedResearchContextQuery {
  source?: string
  sourceRefs?: readonly string[]
  labels?: readonly string[]
  entityIds?: readonly string[]
  itemIds?: readonly string[]
  /** Recent ignores lexical/source filters; targeted searches bounded older history. */
  historyMode?: 'recent' | 'targeted'
  limit?: number
}

export interface ManagedKnowledgeWriterOptions {
  connectionString: string
  ca?: string | null
  leaseTtlMs?: number
}

export interface ManagedPlanningDispatch {
  operationId: string
  attemptDigest: string
  state: 'dispatched' | 'settled' | 'held' | 'resolved_without_execution'
  dispatchedAt: string
  requestDigest?: string
  providerRoute?: unknown
}

export interface ManagedKnowledgeOperationalStatus {
  schemaVersion: 'myboon.managed_knowledge_status.v1'
  capturedAt: string
  source: 'news' | 'polymarket' | null
  plans: number
  holds: number
  leases: number
  receipts: number
  items: number
  contexts: number
  unresolvedPlanningDispatches: number
}

/**
 * Pipeline-internal managed storage. The dedicated LOGIN has only USAGE and
 * named-function EXECUTE; no table writes, REST RPC or service-role fallback.
 * Pool construction opens no connection. TLS certificate validation is never
 * disabled, including when a connection string carries SSL parameters.
 */
export class PostgresKnowledgeOperationWriter implements KnowledgeOperationWriterPort {
  private readonly pool: Pool
  private readonly leaseTtlMs: number

  constructor(options: ManagedKnowledgeWriterOptions) {
    const url = new URL(options.connectionString)
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username) {
      throw new TypeError('Managed knowledge requires a dedicated PostgreSQL LOGIN URL')
    }
    if (/^(postgres|service_role|supabase_admin|authenticator)$/i.test(decodeURIComponent(url.username))) {
      throw new TypeError('Managed knowledge must use an operator-provisioned function-only LOGIN')
    }
    for (const key of url.searchParams.keys()) {
      if (/^ssl/i.test(key)) throw new TypeError('Configure managed knowledge TLS through MYBOON_MANAGED_KNOWLEDGE_DATABASE_CA, not URL SSL parameters')
    }
    this.leaseTtlMs = options.leaseTtlMs ?? 90_000
    if (!Number.isSafeInteger(this.leaseTtlMs) || this.leaseTtlMs < 30_000 || this.leaseTtlMs > 300_000) {
      throw new RangeError('Managed writer lease must be between 30000 and 300000 milliseconds')
    }
    this.pool = new Pool({
      connectionString: options.connectionString,
      ssl: { rejectUnauthorized: true, ...(options.ca ? { ca: options.ca } : {}) },
      max: 4,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 20_000,
      query_timeout: 25_000,
      application_name: 'myboon_entity_v4_private_writer',
    })
    // Idle connection errors must not terminate a worker or expose credentials.
    // The next named operation reports storage failure to its durable queue.
    this.pool.on('error', () => {})
  }

  async close(): Promise<void> { await this.pool.end() }

  async findReceipt(operationId: string): Promise<KnowledgeOperationReceipt | null> {
    return this.call('receipt', { operationId })
  }
  async findSavedPlan(operationId: string, attemptDigest: string): Promise<SavedProgressionPlan | null> {
    return this.call('plan', { operationId, attemptDigest })
  }
  async findSavedPlanHistory(operationId: string): Promise<readonly SavedProgressionPlan[]> {
    return this.call('plan_history', { operationId })
  }
  async findHoldHistory(operationId: string): Promise<readonly KnowledgeOperationReceipt[]> {
    return this.call('hold_history', { operationId })
  }
  async saveValidatedPlan(input: SaveProgressionPlanInput): Promise<SavedProgressionPlan> {
    if (input.plan.operationId !== input.operationId || input.plan.workId !== input.workId || progressionPlanDigest(input.plan) !== input.planDigest) {
      throw new KnowledgeOperationConflictError(input.operationId, 'validated plan identity/digest mismatch')
    }
    const { contractVersion: _version, operationId: _operation, workId: _work, outcome, ...metadata } = input.plan
    if (deriveProgressionAttemptDigest(input.operationId, metadata) !== input.attemptDigest) {
      throw new KnowledgeOperationConflictError(input.operationId, 'plan attempt digest mismatch')
    }
    const effects = outcome.kind === 'apply' ? buildProgressionEffects(input.operationId, outcome.drafts, outcome.operations) : []
    return this.call('save_plan', { ...input, planCanonical: canonicalJson(input.plan), effects, effectsCanonical: canonicalJson(effects) })
  }
  async acquireLease(operationId: string, owner: string): Promise<KnowledgeOperationLease | null> {
    return this.call('acquire', { operationId, owner, leaseTtlMs: this.leaseTtlMs })
  }
  async renewLease(operationId: string, owner: string, epoch: number): Promise<KnowledgeOperationLease | null> {
    return this.call('renew', { operationId, owner, epoch, leaseTtlMs: this.leaseTtlMs })
  }
  async releaseLease(operationId: string, owner: string, epoch: number): Promise<boolean> {
    return this.call('release', { operationId, owner, epoch })
  }
  async currentLease(operationId: string, owner: string): Promise<KnowledgeOperationLease | null> {
    return this.call('lease', { operationId, owner })
  }
  async commitOperations(input: KnowledgeOperationCommitInput): Promise<KnowledgeOperationCommitResult> {
    const normalized = normalizeCommitInput(input)
    if (knowledgeOperationSemanticDigest(normalized.effects) !== input.contentDigest) {
      throw new KnowledgeOperationConflictError(input.operationId, 'effect digest mismatch')
    }
    return this.call('commit', { ...normalized, workId: input.workId, owner: input.owner, epoch: input.epoch, effectsCanonical: canonicalJson(normalized.effects) })
  }
  async commitHold(input: KnowledgeOperationHoldInput): Promise<KnowledgeOperationCommitResult> {
    const normalized = normalizeHoldInput(input)
    return this.call('hold', { ...normalized, workId: input.workId, owner: input.owner, epoch: input.epoch, contentCanonical: canonicalJson({
      schemaVersion: 'myboon.knowledge_operation_hold.v1', reason: normalized.reason,
      missingDependency: normalized.missingDependency, retainedGroups: normalized.retainedGroups, retainedPayload: normalized.retainedPayload,
    }) })
  }

  /** Immutable source proof; authoritative items are written only by commit. */
  async saveResearchSource(packet: ResearchPacket, handoff: EntityHandoffContext): Promise<void> {
    const validated = validateResearchPacket(packet)
    if (isArticleResearchPacket(validated)) {
      await this.articleCall('source', {
        workId: validated.workId,
        packetDigest: progressionSourcePacketDigest(validated),
        packet: validated,
        packetCanonical: canonicalJson(validated),
        readinessCanonical: canonicalJson(handoff.readiness),
        readiness: handoff.readiness,
        readinessDigest: knowledgeOperationSemanticDigest(handoff.readiness),
        source: validated.sourceType,
        sourceRefs: managedSignalSourceRefs(handoff.signal),
      })
      return
    }
    const evidence = handoff.persistedEvidence.map((value) => ({
      evidenceId: value.evidenceId, requestedUrl: value.requestedUrl, finalUrl: value.finalUrl,
      contentHash: value.contentHash, authority: value.authority, authorityId: value.authorityId,
      retrievalMethod: value.retrievalMethod, retrievedAt: value.retrievedAt,
      truncated: value.truncated,
      textDigest: createHash('sha256').update(value.text).digest('hex'),
    }))
    await this.call('source', {
      workId: packet.workId, packetDigest: progressionSourcePacketDigest(validated), packet: validated,
      packetCanonical: canonicalJson(validated), readinessCanonical: canonicalJson(handoff.readiness),
      readiness: handoff.readiness, readinessDigest: knowledgeOperationSemanticDigest(handoff.readiness),
      source: packet.sourceType, sourceRefs: managedSignalSourceRefs(handoff.signal),
      evidence,
    })
  }

  /** An internal bounded query for Entity planning and Research consultation. */
  async researchContext(input: ManagedResearchContextQuery): Promise<ManagedResearchContext> {
    const result = await this.pool.query<{ result: ManagedResearchContext }>(
      'select managed_knowledge_private.context_v1($1::jsonb) as result',
      [boundedJson({
        source: input.source ?? null,
        sourceRefs: boundedStrings(input.sourceRefs ?? [], 32),
        labels: boundedStrings(input.labels ?? [], 100),
        entityIds: boundedStrings(input.entityIds ?? [], 32),
        itemIds: boundedStrings(input.itemIds ?? [], 32),
        limit: Math.min(32, Math.max(1, input.limit ?? 24)),
      })],
    )
    return result.rows[0].result
  }

  /** Bounded private article context, including immutable legacy history by origin. */
  async articleContext(input: ManagedResearchContextQuery): Promise<ManagedArticleContext> {
    const result = await this.pool.query<{ result: ManagedArticleContext }>(
      'select managed_knowledge_private.article_context_v1($1::jsonb) as result',
      [boundedJson({
        source: input.source ?? null,
        sourceRefs: boundedStrings(input.sourceRefs ?? [], 32),
        labels: boundedStrings(input.labels ?? [], 100),
        entityIds: boundedStrings(input.entityIds ?? [], 32),
        itemIds: boundedStrings(input.itemIds ?? [], 32),
        historyMode: input.historyMode ?? 'targeted',
        limit: Math.min(32, Math.max(1, input.limit ?? 24)),
      })],
    )
    return result.rows[0].result
  }

  /**
   * Article commits are deterministic: no planner, claims or evidence tuples
   * are accepted on this route. The function checkpoints its immutable plan,
   * validates the live fenced lease, writes effects, and records the receipt
   * in one database transaction.
   */
  async commitArticle(input: ArticleCommitInput): Promise<KnowledgeOperationCommitResult> {
    const packet = validateResearchPacket(input.packet)
    if (!isArticleResearchPacket(packet)) throw new TypeError('Article commit requires an article packet')
    const itemId = input.itemId
    const effect = {
      kind: itemId === null ? 'article_source_attachment' : 'article_item',
      itemId,
      duplicateTarget: input.duplicateTarget,
      memberships: packet.memberships,
      article: packet.article,
    }
    const plan = {
      schemaVersion: 'myboon.article_progression_plan.v1',
      operationId: input.operationId,
      workId: input.workId,
      packetDigest: progressionSourcePacketDigest(packet),
      contextDigest: input.contextDigest,
      contextWatermark: input.contextWatermark,
      targetRevisions: input.targetRevisions,
      entities: input.entities,
      effect,
    }
    const planCanonical = canonicalJson(plan)
    const effects = [effect]
    const effectsCanonical = canonicalJson(effects)
    return this.articleCall('commit', {
      operationId: input.operationId, workId: input.workId, owner: input.owner, epoch: input.epoch,
      plan, planCanonical, planDigest: createHash('sha256').update(planCanonical).digest('hex'),
      effects, effectsCanonical, contentDigest: createHash('sha256').update(effectsCanonical).digest('hex'),
    })
  }

  async commitArticleHold(input: ArticleHoldInput): Promise<KnowledgeOperationCommitResult> {
    const retainedCanonical = canonicalJson(input.retainedPayload)
    const attemptDigest = createHash('sha256').update(canonicalJson({
      schemaVersion: 'myboon.article_hold_attempt.v1', operationId: input.operationId,
      workId: input.workId, reason: input.reason, missingDependency: input.missingDependency,
    })).digest('hex')
    const contentCanonical = canonicalJson({
      schemaVersion: 'myboon.article_hold.v1', reason: input.reason,
      missingDependency: input.missingDependency, retainedPayload: input.retainedPayload,
    })
    return this.articleCall('hold', {
      ...input, attemptDigest, retainedCanonical,
      contentCanonical, contentDigest: createHash('sha256').update(contentCanonical).digest('hex'),
    })
  }

  /** Immutable planning input sidecar. No item/entity effects are visible yet. */
  async savePlanningContext(workId: string, input: {
    contextDigest: string
    watermark: string
    entities: readonly ManagedEntityBinding[]
    itemRevisions: Record<string, string>
  }): Promise<void> {
    await this.call('context_checkpoint', { workId, ...input })
  }

  async targetsCurrent(revisions: Record<string, string>, watermark: string | null): Promise<boolean> {
    return this.call('targets_current', { targetRevisions: revisions, watermark })
  }

  async reservePlanningDispatch(input: {
    operationId: string; workId: string; owner: string; epoch: number;
    metadata: ProgressionPlanMetadata
    requestDigest: string
    providerRoute: unknown
  }): Promise<{ reserved: boolean; dispatch: ManagedPlanningDispatch }> {
    return this.call('reserve_plan_dispatch', { ...input, attemptDigest: deriveProgressionAttemptDigest(input.operationId, input.metadata) })
  }

  /** Operator-only reconciliation. Unknown execution is never released by time. */
  async resolvePlanningDispatch(input: {
    operationId: string
    attemptDigest: string
    requestDigest: string
    resolution: 'confirmed_no_execution'
    proof: { source: 'provider_execution_record'; provider: string; proofRef: string; proofDigest: string; confirmedBy: string }
  }): Promise<void> {
    await this.call('resolve_plan_dispatch', input)
  }

  async readOperationalStatus(source?: 'news' | 'polymarket'): Promise<ManagedKnowledgeOperationalStatus> {
    return this.call('status', { source: source ?? null })
  }

  async findPlanningDispatch(operationId: string, attemptDigest?: string): Promise<ManagedPlanningDispatch | null> {
    return this.call('planning_dispatch', {operationId,attemptDigest: attemptDigest ?? null})
  }

  /**
   * An attempt watermark is not permission to purchase the same paid request
   * again. Histories also cover rejected results and an older A -> B -> A
   * request; the latest dispatch alone cannot establish absence.
   */
  async findRecordedPlanningRequest(operationId: string, requestDigest: string): Promise<{
    dispatch: ManagedPlanningDispatch
    plan: SavedProgressionPlan | null
  } | null> {
    const [plans, holds, latest] = await Promise.all([
      this.findSavedPlanHistory(operationId),
      this.findHoldHistory(operationId),
      this.findPlanningDispatch(operationId),
    ])
    const newestPlans = [...plans].reverse()
    const attempts = new Set([
      ...(latest ? [latest.attemptDigest] : []),
      ...newestPlans.map((plan) => plan.attemptDigest),
      ...[...holds].reverse().map((hold) => hold.attemptDigest),
    ])
    for (const attemptDigest of attempts) {
      const dispatch = latest?.attemptDigest === attemptDigest
        ? latest
        : await this.findPlanningDispatch(operationId, attemptDigest)
      if (!dispatch || dispatch.requestDigest !== requestDigest || dispatch.state === 'resolved_without_execution') continue
      const plan = dispatch.state === 'settled'
        ? newestPlans.find((candidate) => candidate.attemptDigest === attemptDigest) ?? null
        : null
      if (plan && (plan.plan.operationId !== operationId || progressionPlanDigest(plan.plan) !== plan.planDigest)) {
        throw new KnowledgeOperationConflictError(operationId, 'recorded planning result failed immutable digest verification')
      }
      return { dispatch, plan }
    }
    return null
  }

  private async call<T>(action: string, input: unknown): Promise<T> {
    try {
      const result = await this.pool.query<{ result: T }>(
        'select managed_knowledge_private.writer_v1($1::text, $2::jsonb) as result',
        [action, boundedJson(input)],
      )
      return result.rows[0].result
    } catch (error) {
      const value = error as { code?: string; detail?: string }
      const operationId = typeof input === 'object' && input ? String((input as { operationId?: unknown }).operationId ?? 'internal') : 'internal'
      if (value.code === 'MK001') throw new KnowledgeOperationConflictError(operationId, 'private writer rejected a conflicting request')
      if (value.code === 'MK002') throw new KnowledgeOperationFencingError(operationId, 'private writer rejected a stale lease')
      if (value.code === 'MK003') throw new KnowledgeOperationStaleTargetError(operationId, value.detail ?? 'context')
      // Connection failures can contain the URL/login. Surface only SQLSTATE.
      throw new Error(`Managed knowledge storage unavailable (${value.code ?? 'connection_failure'})`)
    }
  }

  private async articleCall<T>(action: string, input: unknown): Promise<T> {
    try {
      const result = await this.pool.query<{ result: T }>(
        'select managed_knowledge_private.article_writer_v1($1::text, $2::jsonb) as result',
        [action, boundedJson(input)],
      )
      return result.rows[0].result
    } catch (error) {
      const value = error as { code?: string; detail?: string }
      const operationId = typeof input === 'object' && input ? String((input as { operationId?: unknown }).operationId ?? 'internal') : 'internal'
      if (value.code === 'MK001') throw new KnowledgeOperationConflictError(operationId, 'article writer rejected a conflicting request')
      if (value.code === 'MK002') throw new KnowledgeOperationFencingError(operationId, 'article writer rejected a stale lease')
      if (value.code === 'MK003') throw new KnowledgeOperationStaleTargetError(operationId, value.detail ?? 'context')
      throw new Error(`Managed knowledge storage unavailable (${value.code ?? 'connection_failure'})`)
    }
  }
}

/** Source-native identity and canonical URLs are preserved alongside signal ID. */
export function managedSignalSourceRefs(signal: Signal): string[] {
  const content = signal.content as Record<string, unknown>
  return boundedStrings([
    signal.signalId, signal.sourceId, signal.canonicalUrl,
    signal.sourceHints.eventId, content.sourceRefId, content.nativeId,
    content.marketSlug, content.market_slug, content.slug, content.storyKey,
    signal.sourceHints.marketSlug,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0), 32)
}

function boundedStrings(input: readonly string[], max: number): string[] {
  if (input.length > max) throw new RangeError('Managed context identity input exceeds its bounded limit')
  return [...new Set(input.map((value) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 1000) throw new TypeError('Invalid managed context identity')
    return value.trim()
  }))]
}

function boundedJson(value: unknown): string {
  const serialized = canonicalJson(value)
  if (Buffer.byteLength(serialized, 'utf8') > 17 * 1_048_576) throw new RangeError('Managed operation exceeds the bounded input size')
  return serialized
}
