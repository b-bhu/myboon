import type {
  EntityInput,
  EntityMemoryConsolidationPatch,
  EntityMemoryInput,
  EntityMemoryRecord,
  EntityMemoryStore,
  EntityMemoryType,
  EntityRecord,
  ManualCommandLogInput,
  ManualCommandLogRecord,
  MemoryLookupKey,
} from './types'

export class InMemoryEntityMemoryStore implements EntityMemoryStore {
  entities: EntityRecord[] = []
  memories: EntityMemoryRecord[] = []
  manualCommandLog: ManualCommandLogRecord[] = []
  private nextEntityId = 1
  private nextMemoryId = 1

  async listEntities(limit = 1000): Promise<EntityRecord[]> {
    return this.entities.slice(0, limit)
  }

  async findEntities(slugs: string[], aliases: string[]): Promise<EntityRecord[]> {
    const slugSet = new Set(slugs)
    const aliasSet = new Set(aliases.map((alias) => alias.toLowerCase()))
    return this.entities.filter((entity) => (
      slugSet.has(entity.slug)
      || entity.aliases.some((alias) => aliasSet.has(alias.toLowerCase()))
    ))
  }

  async createEntities(entities: EntityInput[]): Promise<EntityRecord[]> {
    const created: EntityRecord[] = []
    for (const input of entities) {
      const existing = this.entities.find((entity) => entity.slug === input.slug)
      if (existing) {
        created.push(existing)
        continue
      }
      const entity = {
        id: `entity-${this.nextEntityId++}`,
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
        show_in_carousel: false,
        ...input,
      }
      this.entities.push(entity)
      created.push(entity)
    }
    return created
  }

  async updateEntity(entity: EntityRecord): Promise<EntityRecord> {
    const index = this.entities.findIndex((item) => item.id === entity.id)
    if (index === -1) throw new Error(`missing entity ${entity.id}`)
    this.entities[index] = entity
    return entity
  }

  async findMemories(keys: MemoryLookupKey[]): Promise<EntityMemoryRecord[]> {
    const wanted = new Set(keys.map((key) => [
      key.source,
      key.sourceArea,
      key.sourceResearchId,
      key.entityId ?? '',
      key.memoryType,
      key.title,
    ].join('|')))
    return this.memories.filter((memory) => wanted.has([
      memory.source,
      memory.source_area,
      memory.source_research_id,
      memory.entity_id ?? '',
      memory.memory_type,
      memory.title,
    ].join('|')))
  }

  async upsertMemories(memories: EntityMemoryInput[]): Promise<EntityMemoryRecord[]> {
    const upserted: EntityMemoryRecord[] = []
    for (const input of memories) {
      const existing = this.memories.find((memory) => (
        memory.source === input.source
        && memory.source_area === input.source_area
        && memory.source_research_id === input.source_research_id
        && (memory.entity_id ?? '') === (input.entity_id ?? '')
        && memory.memory_type === input.memory_type
        && memory.title === input.title
      ))
      if (existing) {
        Object.assign(existing, input)
        upserted.push(existing)
        continue
      }
      const memory: EntityMemoryRecord = {
        id: `memory-${this.nextMemoryId++}`,
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
        ...input,
      }
      this.memories.push(memory)
      upserted.push(memory)
    }
    return upserted
  }

  async listRecentMemories(
    entityIds: string[],
    sinceIso: string,
    untilIso: string,
    limit: number,
    source: string,
  ): Promise<EntityMemoryRecord[]> {
    const entityIdSet = new Set(entityIds)
    const since = Date.parse(sinceIso)
    const until = Date.parse(untilIso)
    return this.memories
      .filter((memory) => (
        memory.entity_id !== null
        && entityIdSet.has(memory.entity_id)
        && memory.source === source
        && Date.parse(memory.observed_at) >= since
        && Date.parse(memory.observed_at) <= until
      ))
      .sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at))
      .slice(0, Math.max(0, limit))
  }

  async findLatestMemorySince(
    entityId: string,
    memoryType: EntityMemoryType,
    sinceIso: string,
  ): Promise<EntityMemoryRecord | null> {
    const since = Date.parse(sinceIso)
    const matches = this.memories
      .filter((memory) => (
        memory.entity_id === entityId
        && memory.memory_type === memoryType
        && Date.parse(memory.observed_at) >= since
      ))
      .sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at))
    return matches[0] ?? null
  }

  async updateMemory(id: string, patch: EntityMemoryConsolidationPatch): Promise<EntityMemoryRecord> {
    const index = this.memories.findIndex((memory) => memory.id === id)
    if (index === -1) throw new Error(`missing memory ${id}`)
    this.memories[index] = { ...this.memories[index], ...patch, updated_at: new Date().toISOString() }
    return this.memories[index]
  }

  async findManualCommand(requestId: string): Promise<ManualCommandLogRecord | null> {
    return this.manualCommandLog.find((record) => record.requestId === requestId) ?? null
  }

  async recordManualCommand(input: ManualCommandLogInput): Promise<ManualCommandLogRecord> {
    const existingIndex = this.manualCommandLog.findIndex((record) => record.requestId === input.requestId)
    const record: ManualCommandLogRecord = {
      requestId: input.requestId,
      commandHash: input.commandHash,
      actor: input.actor,
      entityId: input.entityId,
      appliedAt: new Date().toISOString(),
    }
    if (existingIndex === -1) {
      this.manualCommandLog.push(record)
    } else {
      this.manualCommandLog[existingIndex] = record
    }
    return record
  }
}
