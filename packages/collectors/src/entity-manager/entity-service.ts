import { createHash } from 'node:crypto'
import { normalizeManualEntityCommand } from './manual-adapter'
import { markExtractionFailed, writeExtraction } from './resolver'
import type {
  EntityInput,
  EntityMemoryInput,
  EntityMemoryStore,
  EntityRecord,
  ExtractionProvider,
  ManualEntityApplyResult,
  ManualEntityCommand,
  ManualEntityPreview,
  MemoryLookupKey,
  NormalizedManualEntityCommand,
  ResearchPacket,
  WriteExtractionResult,
} from './types'

interface ManualPlan {
  preview: ManualEntityPreview
  existing: EntityRecord | null
  proposed: EntityRecord | EntityInput
}

export class ManualEntityConflictError extends Error {
  readonly code = 'manual_entity_conflict'

  constructor(message: string) {
    super(message)
    this.name = 'ManualEntityConflictError'
  }
}

/**
 * One Entity Manager application service shared by automated extraction and
 * trusted manual inputs from the dashboard, Codex, CLIs, and other agents.
 */
export class EntityService {
  constructor(private readonly store: EntityMemoryStore) {}

  writeExtraction(packet: ResearchPacket, provider: ExtractionProvider): Promise<WriteExtractionResult> {
    return writeExtraction(this.store, packet, provider)
  }

  markExtractionFailed(packet: ResearchPacket, error: string): Promise<WriteExtractionResult> {
    return markExtractionFailed(this.store, packet, error)
  }

  async previewManual(input: ManualEntityCommand | unknown): Promise<ManualEntityPreview> {
    return (await this.buildManualPlan(input)).preview
  }

  async applyManual(input: ManualEntityCommand | unknown, previewHash: string): Promise<ManualEntityApplyResult> {
    const normalized = normalizeManualEntityCommand(input)
    const replay = await this.findAppliedCommand(normalized)
    if (replay) return replay

    const plan = await this.buildManualPlan(normalized)
    if (!previewHash || previewHash !== plan.preview.planHash) {
      throw new ManualEntityConflictError('The Entity changed after preview. Preview the command again before applying it.')
    }

    const entity = plan.existing
      ? (plan.preview.entity.action === 'update'
          ? await this.store.updateEntity(plan.proposed as EntityRecord)
          : plan.existing)
      : (await this.store.createEntities([plan.proposed as EntityInput]))[0]
    if (!entity) throw new Error('Entity creation returned no row.')

    const eventInputs = normalized.memories.map((memory, index) => memoryInput(normalized, entity.id, memory, index))
    const existing = await this.store.findMemories(eventInputs.map(memoryLookupKey))
    const existingKeys = new Set(existing.map(memoryRecordKey))
    const pending = eventInputs.filter((memory) => !existingKeys.has(memoryInputKey(memory)))
    const written = await this.store.upsertMemories(pending)

    await this.store.recordManualCommand({
      requestId: normalized.requestId,
      commandHash: hash(normalized),
      actor: normalized.actor,
      entityId: entity.id,
    })

    return {
      requestId: normalized.requestId,
      entity,
      memoriesWritten: written.length,
      duplicateMemoriesSkipped: eventInputs.length - pending.length,
      auditMarkerWritten: true,
      replayed: false,
    }
  }

  private async buildManualPlan(input: ManualEntityCommand | unknown): Promise<ManualPlan> {
    const command = normalizeManualEntityCommand(input)
    const matches = await this.store.findEntities([command.entity.slug], command.entity.aliases)
    const existing = selectEntityMatch(command, matches)
    const proposed = existing ? updatedEntity(existing, command) : newEntity(command)
    const changes = existing ? entityChanges(existing, proposed as EntityRecord) : ['entity']
    const action: ManualEntityPreview['entity']['action'] = existing
      ? (changes.length > 0 ? 'update' : 'reuse')
      : 'create'

    const duplicateKeys = existing
      ? command.memories.map((memory, index) => memoryLookupKey(memoryInput(command, existing.id, memory, index)))
      : []
    const duplicateRows = await this.store.findMemories(duplicateKeys)
    const duplicateSet = new Set(duplicateRows.map(memoryRecordKey))
    const memories = command.memories.map((memory, index) => ({
      index,
      action: existing && duplicateSet.has(memoryInputKey(memoryInput(command, existing.id, memory, index)))
        ? 'skip_duplicate' as const
        : 'create' as const,
      title: memory.title,
      summary: memory.summary,
      eventAt: memory.eventAt,
      memoryType: memory.memoryType,
    }))
    const warnings: string[] = []
    if (memories.length === 0) warnings.push('This creates or updates the Entity without adding a timeline memory.')
    const showInCarousel = 'show_in_carousel' in proposed
      ? Boolean(proposed.show_in_carousel)
      : false
    if (showInCarousel && memories.length === 0 && !existing) {
      warnings.push('A new carousel Entity will have no timeline memories.')
    }

    const previewBase = {
      requestId: command.requestId,
      command,
      entity: {
        action,
        existingEntityId: existing?.id ?? null,
        currentUpdatedAt: existing?.updated_at ?? null,
        slug: proposed.slug,
        name: proposed.name,
        type: proposed.type,
        aliases: proposed.aliases,
        summary: proposed.summary,
        status: proposed.status,
        showInCarousel,
        metadata: proposed.metadata,
        changes,
      },
      memories,
      warnings,
    }
    const preview: ManualEntityPreview = {
      ...previewBase,
      planHash: hash(previewBase),
    }
    return { preview, existing, proposed }
  }

  private async findAppliedCommand(command: NormalizedManualEntityCommand): Promise<ManualEntityApplyResult | null> {
    const logged = await this.store.findManualCommand(command.requestId)
    if (!logged) return null
    if (logged.commandHash !== hash(command)) {
      throw new ManualEntityConflictError('requestId has already been applied with a different command.')
    }
    const matches = await this.store.findEntities([command.entity.slug], command.entity.aliases)
    const entity = selectEntityMatch(command, matches)
    if (!entity) throw new ManualEntityConflictError('The command was applied, but its Entity can no longer be resolved.')
    return {
      requestId: command.requestId,
      entity,
      memoriesWritten: 0,
      duplicateMemoriesSkipped: command.memories.length,
      auditMarkerWritten: false,
      replayed: true,
    }
  }
}

function selectEntityMatch(command: NormalizedManualEntityCommand, matches: EntityRecord[]): EntityRecord | null {
  const exact = matches.find((entity) => entity.slug === command.entity.slug)
  if (exact) return exact
  if (matches.length === 0) return null
  if (matches.length > 1) {
    throw new ManualEntityConflictError('More than one Entity matched these aliases. Use an existing Entity slug before applying.')
  }
  return matches[0]
}

function newEntity(command: NormalizedManualEntityCommand): EntityInput {
  return {
    slug: command.entity.slug,
    name: command.entity.name,
    type: command.entity.type,
    aliases: command.entity.aliases,
    summary: command.entity.summary ?? null,
    status: command.entity.status ?? 'active',
    ...(command.entity.showInCarousel !== undefined
      ? { show_in_carousel: command.entity.showInCarousel }
      : {}),
    metadata: command.entity.metadata,
  }
}

function updatedEntity(existing: EntityRecord, command: NormalizedManualEntityCommand): EntityRecord {
  return {
    ...existing,
    name: command.entity.name,
    type: command.entity.type,
    aliases: unique([...existing.aliases, ...command.entity.aliases]),
    summary: command.entity.summary !== undefined ? command.entity.summary : existing.summary,
    status: command.entity.status ?? existing.status,
    show_in_carousel: command.entity.showInCarousel ?? existing.show_in_carousel,
    metadata: { ...existing.metadata, ...command.entity.metadata },
  }
}

function entityChanges(before: EntityRecord, after: EntityRecord): string[] {
  const changes: string[] = []
  if (before.name !== after.name) changes.push('name')
  if (before.type !== after.type) changes.push('type')
  if (JSON.stringify(before.aliases) !== JSON.stringify(after.aliases)) changes.push('aliases')
  if (before.summary !== after.summary) changes.push('summary')
  if (before.status !== after.status) changes.push('status')
  if (before.show_in_carousel !== after.show_in_carousel) changes.push('showInCarousel')
  if (JSON.stringify(before.metadata) !== JSON.stringify(after.metadata)) changes.push('metadata')
  return changes
}

function memoryInput(
  command: NormalizedManualEntityCommand,
  entityId: string,
  memory: NormalizedManualEntityCommand['memories'][number],
  index: number,
): EntityMemoryInput {
  return {
    entity_id: entityId,
    source: 'manual',
    source_area: command.actor.kind,
    source_type: memory.sourceType,
    source_ref_id: memory.sourceRefId,
    source_research_id: command.requestId,
    memory_type: memory.memoryType,
    title: memory.title,
    summary: memory.summary,
    body: memory.body,
    event_at: memory.eventAt,
    observed_at: memory.observedAt,
    confidence: memory.confidence,
    evidence: memory.evidence,
    mentions: memory.mentions,
    metrics: memory.metrics,
    context: {
      ...memory.context,
      entry_mode: 'manual',
      actor: command.actor,
      source_label: memory.sourceLabel,
      source_url: memory.sourceUrl,
      command_memory_index: index,
    },
  }
}

function memoryLookupKey(memory: EntityMemoryInput): MemoryLookupKey {
  return {
    source: memory.source,
    sourceArea: memory.source_area,
    sourceResearchId: memory.source_research_id,
    entityId: memory.entity_id,
    memoryType: memory.memory_type,
    title: memory.title,
  }
}

function memoryInputKey(memory: EntityMemoryInput): string {
  return [memory.source, memory.source_area, memory.source_research_id, memory.entity_id ?? '', memory.memory_type, memory.title].join('|')
}

function memoryRecordKey(memory: { source: string; source_area: string; source_research_id: string; entity_id: string | null; memory_type: string; title: string }): string {
  return [memory.source, memory.source_area, memory.source_research_id, memory.entity_id ?? '', memory.memory_type, memory.title].join('|')
}

function unique(values: string[]): string[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    const key = value.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
