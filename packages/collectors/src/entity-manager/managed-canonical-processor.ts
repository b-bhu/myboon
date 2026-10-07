import { createHash } from 'node:crypto'
import { canonicalJson } from '../signal-platform/canonical-json'
import { isArticleResearchPacket, type EntityHint, type ResearchPacketV1, type ResearchWorkItem } from '../signal-platform/contracts'
import { deriveEntityHintClaimRefs } from '../signal-platform/entity-hint-claims'
import { PlatformFailure } from '../signal-platform/failures'
import type { InferenceTelemetry } from '../inference-gateway/types'
import { CANONICAL_ENTITY_PLANNING_BUDGET, type CanonicalEntityPlanningGateway } from './canonical-planner'
import { withCanonicalEntityTelemetry } from './canonical-processor'
import { entityHintAuthorizesPrimarySelection, groundEntityCandidates } from './entity-grounding'
import { isBannedEntitySlug } from './canon'
import { knowledgeOperationSemanticDigest, type KnowledgeOperationReceipt } from './knowledge-operation-store'
import { normalizeSlug } from './normalization'
import {
  PostgresKnowledgeOperationWriter,
  type ManagedEntityBinding,
  type ManagedResearchContext,
} from './postgres-knowledge-writer'
import { deriveProgressionOperationId, ProgressionProcessor, type ProgressionPlanMetadata, type ProgressionSourcePacketReadPort } from './progression-processor'
import { progressionSourcePacketDigest } from './progression-source-packet-reader'
import type { ItemDraft, ItemEvidenceRef } from './progression-plan'
import { ArticlePersistenceProcessor } from './article-persistence'
import type {
  CanonicalPacketProcessor,
  CanonicalPacketProcessorInput,
  CanonicalPacketProcessorResult,
  EntityPacketWorkPort,
} from './shared-worker'

export const MANAGED_PROGRESSION_PROMPT_VERSION = 'myboon.entity_progression_prompt.v1' as const

/** Raw source-local access. A packet is never fetched from a legacy projection. */
export class SourceLocalProgressionPacketReader implements ProgressionSourcePacketReadPort {
  constructor(private readonly ports: readonly EntityPacketWorkPort[]) {}
  async readResearchPacket(workId: string): Promise<unknown | null> {
    const results = await Promise.all(this.ports.map((port) => port.readResearchPacket(workId)))
    const packets = results.filter((value) => value !== null)
    if (packets.length > 1) throw new Error('Research work identity exists in more than one source store')
    return packets[0] ?? null
  }
}

export interface ManagedCanonicalProcessorOptions {
  writer: PostgresKnowledgeOperationWriter
  ports: readonly EntityPacketWorkPort[]
  gatewayFactory: () => CanonicalEntityPlanningGateway
  policyVersion: string
  owner: string
  assertOwnership: (source: ResearchWorkItem['sourceType']) => void
  executeOwned: <T>(source: ResearchWorkItem['sourceType'], action: () => Promise<T>) => Promise<T>
}

/**
 * The actual Entity worker's managed branch. It never writes legacy memory or
 * public entities, and does not construct paid providers before receipt replay.
 */
export class ManagedCanonicalPacketProcessor implements CanonicalPacketProcessor {
  private readonly packets: SourceLocalProgressionPacketReader
  private readonly processor: ProgressionProcessor

  constructor(private readonly options: ManagedCanonicalProcessorOptions) {
    this.packets = new SourceLocalProgressionPacketReader(options.ports)
    this.processor = new ProgressionProcessor(options.writer, this.packets)
  }

  async recoverAccepted(work: ResearchWorkItem): Promise<CanonicalPacketProcessorResult | null> {
    const receipt = await this.options.writer.findReceipt(deriveProgressionOperationId(work.workId))
    if (!receipt) return null
    assertReceipt(receipt, work)
    return { entityTelemetry: null, memoryOutcome: 'written' }
  }

  async preflight(input: CanonicalPacketProcessorInput): Promise<void> {
    this.options.assertOwnership(input.work.sourceType)
    if (input.signal.aborted) throw heldFailure('Entity work lease is no longer live')
    // Paid availability checks intentionally live inside receipt-first process.
  }

  async process(input: CanonicalPacketProcessorInput): Promise<CanonicalPacketProcessorResult> {
    const recovered = await this.recoverAccepted(input.work)
    if (recovered) return recovered
    return this.options.executeOwned(input.work.sourceType,() => this.processOwned(input))
  }

  private async processOwned(input: CanonicalPacketProcessorInput): Promise<CanonicalPacketProcessorResult> {
    this.options.assertOwnership(input.work.sourceType)
    const unresolved = await this.options.writer.findPlanningDispatch(deriveProgressionOperationId(input.work.workId))
    if (unresolved?.state === 'held') throw heldFailure('planning_dispatch_reconciliation: paid planning execution remains unresolved')
    const handoff = input.handoffContext
    if (!handoff?.readiness) throw heldFailure('Research readiness is unknown; Research must explicitly assess this saved packet')
    if (!['ready_for_entity', 'resolved_without_new_item'].includes(handoff.readiness.outcome)) {
      throw heldFailure('Research has not admitted this packet for Entity processing')
    }
    await this.options.writer.saveResearchSource(input.canonicalPacket, handoff)
    if (isArticleResearchPacket(input.canonicalPacket)) {
      const result = await new ArticlePersistenceProcessor(this.options.writer).persist({
        packet: input.canonicalPacket,
        source: input.work.sourceType as 'news' | 'polymarket',
        owner: this.options.owner,
        signal: input.signal,
      })
      return { entityTelemetry: null, memoryOutcome: result === 'written' ? 'written' : 'skipped' }
    }
    const canonicalPacket = input.canonicalPacket
    const hints = deriveEntityHintClaimRefs(canonicalPacket.entityHints, canonicalPacket.claims)
    const labels = [...new Set(hints.flatMap((hint) => [hint.name, ...hint.aliases]).filter(Boolean))]
    const action = handoff.readiness.entityAction
    const prior = await this.options.writer.researchContext({
      source: input.work.sourceType,
      labels: labels.slice(0,100),
      ...(action.kind === 'evidence_attachment' && action.targetId ? { itemIds: [action.targetId] } : {}),
      limit: 16,
    })
    const grounded = groundManagedEntities(prior, hints)
    const overflow = prior.truncated || labels.length > 100 || grounded.entities.length > 16
    const entities = overflow ? [] : grounded.entities
    const itemRevisions = Object.fromEntries(prior.items.map((item) => [item.itemId,item.revision]))
    const contextDigest = knowledgeOperationSemanticDigest({ baseDigest: prior.digest, entities, itemRevisions, hints })
    await this.options.writer.savePlanningContext(input.work.workId, {
      contextDigest, watermark: prior.watermark, entities, itemRevisions,
    })
    const metadata: ProgressionPlanMetadata = {
      packetDigest: progressionSourcePacketDigest(canonicalPacket),
      contextDigest, contextWatermark: prior.watermark,
      policyVersion: this.options.policyVersion, promptVersion: MANAGED_PROGRESSION_PROMPT_VERSION,
      decisionVersions: { readiness: knowledgeOperationSemanticDigest(handoff.readiness), research: canonicalPacket.execution.promptVersion },
      targetRevisions: { ...Object.fromEntries(entities.map((entity) => [entity.id,entity.revision])), ...itemRevisions },
    }
    let telemetry: InferenceTelemetry | null = null
    let gateway: CanonicalEntityPlanningGateway | undefined
    let prompt: string | undefined
    let route: unknown
    const evidenceRefs = savedEvidenceRefs(canonicalPacket)
    const operationId = deriveProgressionOperationId(input.work.workId)
    const assertLive = () => {
      if (input.signal.aborted) throw heldFailure('Entity work lease is no longer live')
      this.options.assertOwnership(input.work.sourceType)
    }
    const result = await this.processor.process({
      operationId, workId: input.work.workId, owner: this.options.owner, metadata,
      assertPlanningAvailable: async () => {
        assertLive()
        if (overflow || action.kind !== 'entity_item' || entities.length === 0) return
        prompt = progressionPrompt(canonicalPacket, handoff.readiness, entities, prior)
        if (prompt.length > 150_000) throw new Error('Managed progression input exceeds its bounded prompt')
        gateway = this.options.gatewayFactory()
        route = gateway.resolveRoute?.('entity.extract','generateStructured') ?? { workload: 'entity.extract' }
      },
      proposeOutcome: async () => {
        assertLive()
        if (overflow) return { kind: 'hold', reason: 'Knowledge context exceeds bounded planning coverage; the complete saved source is retained', missingDependency: 'bounded_context_resolution' }
        if (action.kind === 'none') return { kind: 'retain_observation', reason: handoff.readiness!.reason }
        if (action.kind === 'evidence_attachment') {
          const target = prior.items.find((item) => item.itemId === action.targetId && item.status === 'active')
          if (!target) return { kind: 'hold', reason: 'Research attachment target is not an active grounded managed item', missingDependency: 'attachment_target_resolution' }
          return { kind: 'apply', drafts: [], operations: [{ candidateItemRef: target.itemId, kind: 'attach_evidence', payload: { actionId: action.actionId, evidenceRefs } }] }
        }
        if (entities.length === 0) return {
          kind: 'hold',
          reason: 'No explicitly evidenced entity identity can be grounded; the complete saved Research packet is retained',
          missingDependency: 'entity_identity_grounding',
        }
        const requestDigest = knowledgeOperationSemanticDigest({ prompt, route, policyVersion: metadata.policyVersion, promptVersion: metadata.promptVersion })
        const recorded = await this.options.writer.findRecordedPlanningRequest(operationId, requestDigest)
        assertLive()
        if (recorded) {
          // A returned outcome still passes current grounding, packet evidence,
          // freshness and commit checks. Reuse never accepts rejected raw output.
          if (recorded.plan) return recorded.plan.plan.outcome
          return {
            kind: 'hold',
            reason: 'This exact paid planning request already has an invalid or unresolved recorded outcome; preserve it for reconciliation without purchasing a replacement',
            missingDependency: 'planning_dispatch_reconciliation',
          }
        }
        const lease = await this.options.writer.currentLease(operationId,this.options.owner)
        if (!lease) throw heldFailure('Managed planning lease is no longer live')
        const reservation = await this.options.writer.reservePlanningDispatch({
          operationId, workId: input.work.workId, owner: lease.owner, epoch: lease.epoch, metadata,
          requestDigest,
          providerRoute: route,
        })
        if (!reservation.reserved) return { kind: 'hold', reason: 'A paid planning dispatch has no saved valid result; reconcile provider execution before any replacement', missingDependency: 'planning_dispatch_reconciliation' }
        try {
          const planned = await gateway!.generateStructured<unknown>({
            workload: 'entity.extract', purpose: 'entity.managed-progression',
            prompt: prompt!, promptVersion: metadata.promptVersion, policyVersion: metadata.policyVersion,
            holdOnUnknownOutcome: true,
            budget: CANONICAL_ENTITY_PLANNING_BUDGET,
            validate: (value) => value && typeof value === 'object' && ['apply','hold','retain_observation'].includes(String((value as { kind?: unknown }).kind))
              ? { valid: true, value }
              : { valid: false, issues: ['Return an apply, hold or retain_observation outcome'] },
          })
          telemetry = planned.telemetry
          return preserveResearchCaveats(planned.value,canonicalPacket)
        } catch (error) {
          telemetry = (error as { telemetry?: InferenceTelemetry }).telemetry ?? telemetry
          // The durable dispatch predates provider execution. A transport loss
          // or a worker crash cannot silently buy this planning attempt again.
          return { kind: 'hold', reason: 'Paid planning dispatch did not produce a saved valid result; operator reconciliation is required', missingDependency: 'planning_dispatch_reconciliation' }
        }
      },
      resolveEntityIdentity: (candidate, draft) => {
        const entity = entities.find((value) => value.id === candidate)
        if (!entity) return null
        if (draft.localKey === 'membership-removal') return entity.id
        const claimIds = grounded.claimsByEntity.get(entity.id) ?? []
        return draft.evidenceRefs.some((reference) => claimIds.includes(reference.claimId)) ? entity.id : null
      },
      resolveExistingItemIdentity: (candidate, kind) => {
        const item = prior.items.find((value) => value.itemId === candidate)
        return item && (item.status === 'active' || kind === 'annotate') ? item.itemId : null
      },
      checkPlanFreshness: async (plan) => {
        assertLive()
        const raw = await this.packets.readResearchPacket(input.work.workId)
        const sourcePort = this.options.ports.find((port) => port.sourceType === input.work.sourceType)
        const current = await sourcePort?.readHandoffContext?.(input.work.workId)
        if (!raw || progressionSourcePacketDigest(raw) !== plan.packetDigest || !current?.readiness || knowledgeOperationSemanticDigest(current.readiness) !== plan.decisionVersions.readiness) {
          return { current: false, reason: 'Saved Research packet or readiness changed', missingDependency: 'research_revalidation' }
        }
        const currentTargets = await this.options.writer.targetsCurrent(plan.targetRevisions,plan.contextWatermark)
        assertLive()
        return { current: currentTargets, reason: 'Knowledge targets or captured context changed', missingDependency: 'context_revalidation' }
      },
    })
    if (result.kind === 'held') throw withCanonicalEntityTelemetry(heldFailure(`${result.receipt.missingDependency}: ${result.receipt.reason}`),telemetry)
    if (result.kind === 'busy' || result.kind === 'fenced') throw heldFailure(`Managed progression operation is ${result.kind}`)
    return { entityTelemetry: telemetry, memoryOutcome: result.receipt.status === 'accepted' ? 'written' : 'skipped' }
  }
}

function groundManagedEntities(context: ManagedResearchContext, hints: EntityHint[]): {
  entities: ManagedEntityBinding[]; claimsByEntity: Map<string,string[]>
} {
  // The legacy resolver is primary-subject focused. Managed membership also
  // admits explicitly evidenced secondary participants while preserving its
  // exact-name/alias ambiguity safeguards. Source/publisher roles remain out.
  const membershipHints = hints.map((hint) => managedMembershipRole(hint.role) ? { ...hint,role: 'subject' } : hint)
  const grounded = groundEntityCandidates(context.entities,membershipHints)
  const entities = grounded.candidates.map((entity) => context.entities.find((value) => value.id === entity.id)!)
  const claimsByEntity = new Map(grounded.support.filter((support) => support.primarySelectionAuthorized).map((support) => [support.entityId,support.supportingClaimIds]))
  for (const hint of hints) {
    if (!managedMembershipRole(hint.role) || !hint.type || hint.claimRefs.length === 0 || hint.evidenceRefs.length === 0) continue
    const name = hint.name.normalize('NFKC').replace(/\s+/g,' ').trim()
    const labels = [name,...hint.aliases].map((value) => value.toLocaleLowerCase('en-US'))
    // Existing or ambiguous aliases never authorize creating a second identity.
    if (context.entities.some((entity) => [entity.name,entity.slug,...entity.aliases].some((label) => labels.includes(label.toLocaleLowerCase('en-US'))))) continue
    const type = hint.type.trim().toLocaleLowerCase('en-US')
    const slug = normalizeSlug(name,name)
    if (!name || name.length > 200 || isBannedEntitySlug(slug)) continue
    const identityKey = `${type}:${name.toLocaleLowerCase('en-US')}`
    const bytes = createHash('sha256').update(`myboon.entity_v4:${identityKey}`).digest('hex').slice(0,32)
    const id = `${bytes.slice(0,8)}-${bytes.slice(8,12)}-${bytes.slice(12,16)}-${bytes.slice(16,20)}-${bytes.slice(20)}`
    if (entities.some((entity) => entity.id === id)) continue
    entities.push({ id,slug,name,type,aliases: [...new Set(hint.aliases)],summary: null,status: 'active',show_in_carousel: false,metadata: {},revision: 'absent',catalogEntityId: null,identityKey })
    claimsByEntity.set(id,hint.claimRefs)
  }
  return { entities,claimsByEntity }
}

function managedMembershipRole(role: string | null): boolean {
  if (entityHintAuthorizesPrimarySelection(role)) return true
  return role !== null && new Set(['secondary_subject','participant','actor','regulator','respondent','complainant','defendant','issuer','counterparty']).has(role.trim().toLowerCase().replace(/[\s-]+/g,'_'))
}

function savedEvidenceRefs(packet: ResearchPacketV1): ItemEvidenceRef[] {
  const evidence = new Map(packet.evidence.map((item) => [item.evidenceId,item.url]))
  return packet.claims.flatMap((claim) => claim.evidenceRefs.map((evidenceId) => ({ claimId: claim.claimId,evidenceId,sourceRef: evidence.get(evidenceId)! })))
}

function progressionPrompt(packet: ResearchPacketV1, readiness: unknown, entities: ManagedEntityBinding[], context: ManagedResearchContext): string {
  return [
    'Propose one bounded Entity knowledge progression outcome as JSON. Only kind=apply|retain_observation|hold.',
    'apply={kind:"apply",drafts:[],operations:[]}. At most 4 drafts and 4 operations; do not fill quotas.',
    'A draft has localKey,candidateId:null,note,entityLinks:[{candidateEntityRef:<supplied entity id>,role}],continuityLinks:[{toLocalKey,kind}],evidenceRefs:[{claimId,evidenceId,sourceRef}].',
    'Entity IDs are candidate references only. Code grounds every identity from explicit current Research claims. Each linked entity needs its own cited claim edge.',
    'One shared development may belong to several explicitly evidenced entities. Group related claims; do not split by paragraph or publisher.',
    'Cite exact saved claim/evidence edges and their evidence URL. A note needs at least one supplied evidence edge. Preserve who says what, limitations, disputed claims and partial readiness.',
    'Research readiness is authoritative. Do not independently reject useful attributed partial research merely because verification remains incomplete.',
    'Existing operation={candidateItemRef:<supplied item id>,kind:annotate|correct|supersede|retract|attach_evidence|remove_membership,payload:{...}}.',
    'correct/supersede require successorLocalKey pointing to a new same-plan draft; never overwrite old prose. retract requires reason. remove_membership requires a grounded entityId and reason.',
    'attach_evidence requires evidenceRefs from this packet. annotate may carry a bounded note/evidenceRefs. Only supplied active existing items may receive state changes.',
    'Same-packet continuity links are response/development links, never arbitrary external item IDs. Keep evidence-only updates as attachments rather than paid rewritten prose.',
    'If identity, context coverage or dependencies are unresolved return {kind:"hold",reason,missingDependency}. If no durable change is justified return {kind:"retain_observation",reason}.',
    'Do not browse, use tools, invent IDs, claim independent verification, or include internal reasoning.',
    canonicalJson({ research: packet,readiness,entityCandidates: entities,existingItems: context.items }),
  ].join('\n')
}

function preserveResearchCaveats(value: unknown, packet: ResearchPacketV1): unknown {
  if (!value || typeof value !== 'object' || (value as { kind?: unknown }).kind !== 'apply') return value
  const outcome = value as { drafts?: unknown }
  if (!Array.isArray(outcome.drafts)) return value
  const caveats = [
    ...(packet.completion === 'partial' ? ['Research contribution is partial.'] : []),
    ...packet.limitations.map((limitation) => `Limitation: ${limitation}`),
    ...packet.openQuestions.map((question) => `Open question: ${question}`),
  ]
  return { ...value,drafts: outcome.drafts.map((draft: unknown) => {
    if (!draft || typeof draft !== 'object') return draft
    const candidate = draft as Partial<ItemDraft>
    const note = typeof candidate.note === 'string' ? [candidate.note,...caveats].join('\n') : candidate.note
    return { ...draft,note }
  }) }
}

function assertReceipt(receipt: KnowledgeOperationReceipt, work: ResearchWorkItem): void {
  if (receipt.status !== 'accepted' || receipt.operationId !== deriveProgressionOperationId(work.workId) || receipt.workId !== work.workId) {
    throw new Error('Managed terminal receipt does not match Entity work')
  }
}

function heldFailure(message: string): PlatformFailure {
  return new PlatformFailure({ category: 'storage_transient',message,retryable: true,incrementsAttempt: false,retryAfterMs: 300_000 })
}
