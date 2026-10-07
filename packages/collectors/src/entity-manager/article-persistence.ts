import { createHash } from 'node:crypto'
import { canonicalJson } from '../signal-platform/canonical-json'
import { isArticleResearchPacket, type ArticleEntityProposal, type ArticleResearchPacketV1, type ResearchPacket } from '../signal-platform/contracts'
import { PlatformFailure } from '../signal-platform/failures'
import { deriveManagedItemId, deriveProgressionOperationId } from './progression-processor'
import { knowledgeOperationSemanticDigest, type KnowledgeOperationReceipt } from './knowledge-operation-store'
import type { ManagedArticleContext, ManagedEntityBinding, PostgresKnowledgeOperationWriter } from './postgres-knowledge-writer'

/**
 * Deterministic article persistence. Research has already made placement,
 * novelty and prose decisions; Entity Manager only verifies identities and
 * durable references before asking the private writer to commit one effect.
 */
export class ArticlePersistenceProcessor {
  constructor(private readonly writer: PostgresKnowledgeOperationWriter) {}

  async persist(input: {
    packet: ResearchPacket
    source: 'news' | 'polymarket'
    owner: string
    signal: AbortSignal
  }): Promise<'written' | 'reused'> {
    if (!isArticleResearchPacket(input.packet)) throw new TypeError('Article persistence requires an article packet')
    const packet = input.packet
    const operationId = deriveProgressionOperationId(packet.workId)
    const accepted = await this.writer.findReceipt(operationId)
    if (accepted) {
      receiptOutcome(accepted, operationId, packet.workId)
      return 'written'
    }
    if (input.signal.aborted) throw hold('entity lease is no longer live', 'lease_fence')

    const labels = unique(packet.memberships.flatMap((proposal) => [proposal.name, ...proposal.aliases, ...(proposal.creationProposal ? [proposal.creationProposal.name, ...proposal.creationProposal.aliases] : [])]))
    const entityIds = unique(packet.memberships.flatMap((proposal) => [
      ...(proposal.entityId ? [proposal.entityId] : []),
      ...(duplicateTarget(proposal)?.entityId ? [duplicateTarget(proposal)!.entityId] : []),
    ]))
    const itemIds = unique(packet.memberships.flatMap((proposal) => [
      ...(proposal.priorItemId ? [proposal.priorItemId] : []),
      ...(duplicateTarget(proposal)?.itemId ? [duplicateTarget(proposal)!.itemId] : []),
    ]))
    if (labels.length > 100 || entityIds.length > 32 || itemIds.length > 32) {
      await this.raiseHold(packet, input.owner, 'Article entity/history context exceeds the bounded exact-identity coverage', 'bounded_context_resolution')
    }
    const context = await this.writer.articleContext({
      source: input.source,
      sourceRefs: unique([packet.article.sourceUrl, packet.sourceSignal.canonicalUrl, packet.sourceSignal.originalCanonicalUrl ?? '']),
      labels,
      entityIds,
      itemIds,
      historyMode: 'targeted',
      identityOnly: packet.memberships.some(proposal => proposal.placementDisposition === 'no_match'),
      limit: 32,
    })
    if ((context.candidateTruncated ?? context.truncated) && packet.memberships.some((proposal) => proposal.placementDisposition === 'no_match')) {
      await this.raiseHold(packet, input.owner, 'Article creation proposal cannot be resolved while candidate context is truncated', 'entity_resolution')
    }
    const resolved = resolveMemberships(packet, context)
    if (resolved.kind === 'hold') return this.raiseHold(packet, input.owner, resolved.reason, 'entity_resolution')

    // Research may have produced one exact primary reuse target plus related
    // entity history matches. The primary target is authoritative for the
    // shared managed item; retain secondary judgments in the saved source
    // packet, but omit them from the writer effect so the SQL boundary sees
    // exactly one durable reuse target. Without a primary target this helper
    // leaves the packet untouched and resolveDuplicate holds ambiguity.
    const packetForCommit = retainPrimaryDuplicateTarget(packet)
    const duplicate = resolveDuplicate(packetForCommit, context)
    if (duplicate.kind === 'hold') return this.raiseHold(packet, input.owner, duplicate.reason, 'duplicate_target_resolution')
    // The Research source checkpoint is immutable. A legacy caller that saved
    // the raw multi-target packet before entering Entity cannot silently swap
    // in a normalized membership shape at the SQL commit boundary: the writer
    // would reject the plan/source proof, and rewriting the checkpoint would
    // erase the paid source provenance. New packets should be normalized before
    // saveResearchSource; retain the old one for explicit reconciliation.
    if (packetForCommit !== packet) {
      return this.raiseHold(packet, input.owner,
        'article packet requires duplicate-target normalization before its immutable source checkpoint is saved',
        'immutable_article_source_checkpoint')
    }
    const contextDigest = knowledgeOperationSemanticDigest({
      baseDigest: context.digest,
      packetDigest: digest(packetForCommit),
      entities: resolved.entities,
      duplicateTarget: duplicate.target,
    })
    const targetRevisions = Object.fromEntries([
      ...resolved.entities.map((entity) => [entity.id, entity.revision]),
      ...context.articleItems.map((item) => [item.itemId, item.revision]),
    ])
    await this.writer.savePlanningContext(packet.workId, {
      contextDigest,
      watermark: context.watermark,
      entities: resolved.entities,
      itemRevisions: targetRevisions,
    })
    if (input.signal.aborted) throw hold('entity lease is no longer live', 'lease_fence')
    const lease = await this.writer.acquireLease(operationId, input.owner)
    if (!lease) {
      const raced = await this.writer.findReceipt(operationId)
      if (raced) {
        receiptOutcome(raced, operationId, packet.workId)
        return 'written'
      }
      throw hold('article persistence is owned by another live worker', 'operation_lease')
    }
    try {
      const raced = await this.writer.findReceipt(operationId)
      if (raced) {
        receiptOutcome(raced, operationId, packet.workId)
        return 'written'
      }
      if (input.signal.aborted) throw hold('entity lease is no longer live', 'lease_fence')
      const itemId = duplicate.target ? null : deriveManagedItemId(operationId, 'article')
      const committed = await this.writer.commitArticle({
        operationId, workId: packetForCommit.workId, owner: lease.owner, epoch: lease.epoch, packet: packetForCommit,
        contextDigest, contextWatermark: context.watermark, targetRevisions,
        entities: resolved.entities, itemId, duplicateTarget: duplicate.target,
      })
      receiptOutcome(committed.receipt, operationId, packet.workId)
      return duplicate.target ? 'reused' : 'written'
    } finally {
      await this.writer.releaseLease(operationId, lease.owner, lease.epoch).catch(() => false)
    }
  }

  private async raiseHold(packet: ArticleResearchPacketV1, owner: string, reason: string, missingDependency: string): Promise<never> {
    const operationId = deriveProgressionOperationId(packet.workId)
    const accepted = await this.writer.findReceipt(operationId)
    if (accepted) {
      receiptOutcome(accepted, operationId, packet.workId)
      throw hold('article operation was accepted while resolving a hold', 'operation_replay')
    }
    const lease = await this.writer.acquireLease(operationId, owner)
    if (!lease) throw hold(reason, missingDependency)
    try {
      await this.writer.commitArticleHold({
        operationId, workId: packet.workId, owner: lease.owner, epoch: lease.epoch, reason, missingDependency,
        retainedPayload: { packetDigest: digest(packet), memberships: packet.memberships, novelty: packet.novelty },
      })
    } finally {
      await this.writer.releaseLease(operationId, lease.owner, lease.epoch).catch(() => false)
    }
    throw hold(reason, missingDependency)
  }
}

function resolveMemberships(packet: ArticleResearchPacketV1, context: ManagedArticleContext):
  | { kind: 'ok', entities: ManagedEntityBinding[] }
  | { kind: 'hold', reason: string } {
  const primary = packet.memberships.filter((proposal) => proposal.role === 'primary' && (proposal.placementDisposition === 'selected' || proposal.placementDisposition === 'no_match'))
  if (primary.length !== 1) return { kind: 'hold', reason: 'prepared article must contain exactly one resolvable primary entity' }
  const seen = new Set<string>()
  const entities: ManagedEntityBinding[] = []
  for (const proposal of packet.memberships) {
    if (proposal.placementDisposition !== 'selected' && proposal.placementDisposition !== 'no_match') {
      return { kind: 'hold', reason: `prepared placement for ${proposal.name} remains uncertain` }
    }
    if (proposal.placementDisposition === 'selected') {
      const found = context.entities.find((entity) => entity.id === proposal.entityId)
      if (!found) return { kind: 'hold', reason: `selected entity ${proposal.name} is not an active private/catalog identity` }
      if (!seen.has(found.id)) { seen.add(found.id); entities.push(found) }
      continue
    }
    if (!proposal.creationProposal || proposal.creationDecision?.choice !== 'accept') {
      return { kind: 'hold', reason: `no-match placement for ${proposal.name} has no accepted bounded creation proposal` }
    }
    const labels = normalLabels([proposal.creationProposal.name, ...proposal.creationProposal.aliases])
    const collision = context.entities.filter((entity) => [...normalLabels([entity.name, entity.slug, ...entity.aliases])].some((label) => labels.has(label)))
    const identityKey = `article:${proposal.creationProposal.type.trim().toLocaleLowerCase('en-US')}:${proposal.creationProposal.name.trim().toLocaleLowerCase('en-US')}`
    const id = deterministicUuid(`myboon.article_entity_v1:${identityKey}`)
    const existingDeterministic = collision.find((entity) => entity.id === id && entity.identityKey === identityKey && entity.status === 'active')
    if (collision.length > 0 && (!existingDeterministic || collision.some((entity) => entity.id !== existingDeterministic.id))) {
      return { kind: 'hold', reason: `creation proposal for ${proposal.creationProposal.name} is equivalent to an existing identity` }
    }
    if (existingDeterministic) {
      if (!seen.has(existingDeterministic.id)) { seen.add(existingDeterministic.id); entities.push(existingDeterministic) }
      continue
    }
    if (!seen.has(id)) {
      seen.add(id)
      entities.push({
        id, slug: slug(proposal.creationProposal.name), name: proposal.creationProposal.name.trim(), type: proposal.creationProposal.type.trim(),
        aliases: unique(proposal.creationProposal.aliases), summary: proposal.creationProposal.summary.trim(), status: 'active', show_in_carousel: false,
        metadata: { scope: proposal.creationProposal.scope, articleCreated: true }, revision: 'absent', catalogEntityId: null, identityKey,
      })
    }
  }
  return { kind: 'ok', entities }
}

function resolveDuplicate(packet: ArticleResearchPacketV1, context: ManagedArticleContext):
  | { kind: 'ok', target: { itemId: string, source: 'legacy' | 'managed', entityId: string } | null }
  | { kind: 'hold', reason: string } {
  const proposals = packet.memberships
  const targets = proposals.map(duplicateTarget).filter((value): value is NonNullable<ReturnType<typeof duplicateTarget>> => value !== null)
  const contextualTargets = proposals.map(contextualDuplicateTarget).filter((value): value is NonNullable<ReturnType<typeof contextualDuplicateTarget>> => value !== null)
  const novelty = packet.novelty.choice
  const contextualTargetsAreGrounded = contextualTargets.every((candidate) => context.articleItems.some((item) =>
    item.itemId === candidate.itemId && item.origin === candidate.source && item.entityId === candidate.entityId,
  ))
  if (!contextualTargetsAreGrounded) {
    return { kind: 'hold', reason: 'contextual duplicate target is not a valid durable history reference' }
  }
  if (novelty === 'uncertain') {
    return targets.length > 0
      ? { kind: 'hold', reason: 'prepared article novelty remains uncertain despite an exact duplicate target' }
      : { kind: 'ok', target: null }
  }
  if (novelty === 'already_known' && targets.length === 0) {
    return { kind: 'hold', reason: 'already-known article requires an exact durable duplicate target' }
  }
  const primaryTargets = proposals.filter((proposal) => proposal.role === 'primary' && duplicateTarget(proposal) !== null)
  if (novelty === 'already_known' && primaryTargets.length !== 1) {
    return { kind: 'hold', reason: 'already-known article requires exactly one primary exact durable duplicate target' }
  }
  if (novelty === 'new_information' || novelty === 'contradicts_prior') {
    if (proposals.some((proposal) => proposal.role === 'primary' && duplicateTarget(proposal) !== null)) {
      return { kind: 'hold', reason: 'primary duplicate target conflicts with the prepared new or contradictory novelty decision' }
    }
    return { kind: 'ok', target: null }
  }
  if (novelty !== 'already_known') return { kind: 'hold', reason: `unsupported prepared article novelty decision: ${novelty}` }
  const uniqueTargets = unique(targets.map((target) => `${target.source}:${target.itemId}`))
  if (uniqueTargets.length !== 1) return { kind: 'hold', reason: 'article duplicate decisions disagree on the durable target' }
  const target = targets[0]!
  if (target.source === 'legacy' && proposals.some((proposal) => proposal.entityId !== target.entityId)) {
    return { kind: 'hold', reason: 'legacy duplicate reuse cannot add entity memberships; preserve the source for explicit legacy-reference resolution' }
  }
  const targetExists = context.articleItems.some((item) => item.itemId === target.itemId && item.origin === target.source)
  const everyAssociationIsValid = targets.every((candidate) => context.articleItems.some((item) =>
    item.itemId === candidate.itemId && item.origin === candidate.source && item.entityId === candidate.entityId,
  ))
  return targetExists && everyAssociationIsValid
    ? { kind: 'ok', target }
    : { kind: 'hold', reason: 'article duplicate target is not a valid durable history reference' }
}

function duplicateTarget(proposal: ArticleEntityProposal): { itemId: string, source: 'legacy' | 'managed', entityId: string } | null {
  const target = (proposal as ArticleEntityProposal & { duplicateTarget?: unknown }).duplicateTarget
  if (!target || typeof target !== 'object') return null
  const value = target as { itemId?: unknown, source?: unknown, entityId?: unknown }
  return typeof value.itemId === 'string' && typeof value.entityId === 'string' && (value.source === 'legacy' || value.source === 'managed')
    ? { itemId: value.itemId, source: value.source, entityId: value.entityId }
    : null
}

function contextualDuplicateTarget(proposal: ArticleEntityProposal): { itemId: string, source: 'legacy' | 'managed', entityId: string } | null {
  const target = (proposal as ArticleEntityProposal & { contextualDuplicateTarget?: unknown }).contextualDuplicateTarget
  if (!target || typeof target !== 'object') return null
  const value = target as { itemId?: unknown, source?: unknown, entityId?: unknown }
  return typeof value.itemId === 'string' && typeof value.entityId === 'string' && (value.source === 'legacy' || value.source === 'managed')
    ? { itemId: value.itemId, source: value.source, entityId: value.entityId } : null
}

/**
 * Reduce a replayable already-known packet to the one source-grounded item
 * that the primary exact duplicate selected. Related duplicate judgments are
 * retained as packet history, but they are not additional writer effects.
 */
export function retainPrimaryDuplicateTarget(packet: ArticleResearchPacketV1): ArticleResearchPacketV1 {
  if (packet.novelty.choice !== 'already_known') return packet
  const primary = packet.memberships.find((proposal) => proposal.role === 'primary' && duplicateTarget(proposal) !== null)
  const authoritative = primary ? duplicateTarget(primary) : null
  if (!authoritative) return packet
  let changed = false
  const memberships = packet.memberships.map((proposal) => {
    const target = duplicateTarget(proposal)
    if (!target || proposal === primary) return proposal
    changed = true
    // Keep the exact secondary target and raw relationship decision as
    // contextual history. Only the primary exact duplicate is a writer effect.
    return { ...proposal, duplicateTarget: null, contextualDuplicateTarget: target }
  })
  return changed ? { ...packet, memberships } : packet
}

function receiptOutcome(receipt: KnowledgeOperationReceipt, operationId: string, workId: string): void {
  if (receipt.status !== 'accepted' || receipt.operationId !== operationId || receipt.workId !== workId) throw new Error('article receipt does not match its work')
}
function hold(message: string, missingDependency: string): PlatformFailure {
  return new PlatformFailure({ category: 'entity_resolution_failed', message: `${missingDependency}: ${message}`, retryable: false, incrementsAttempt: false })
}
function digest(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex') }
function deterministicUuid(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`
}
function slug(value: string): string { return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 200) }
function normalLabels(values: readonly string[]): Set<string> { return new Set(values.map((value) => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US')).filter(Boolean)) }
function unique(values: readonly string[]): string[] { return [...new Set(values.filter((value) => value.trim().length > 0))] }
