import type { EntityCatalogProfile } from './contracts'

export function maintenanceProfile(
  partial: Partial<EntityCatalogProfile> & Pick<EntityCatalogProfile, 'id' | 'name'>,
): EntityCatalogProfile {
  const timestamp = '2026-09-20T00:00:00.000Z'
  return {
    id: partial.id,
    slug: partial.slug ?? partial.name.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, '-'),
    name: partial.name,
    type: partial.type ?? 'organization',
    aliases: partial.aliases ?? [],
    summary: partial.summary ?? null,
    status: partial.status ?? 'active',
    showInCarousel: partial.showInCarousel ?? false,
    tags: partial.tags ?? [],
    createdAt: partial.createdAt ?? timestamp,
    updatedAt: partial.updatedAt ?? timestamp,
    changedAt: partial.changedAt ?? partial.updatedAt ?? timestamp,
    memoryCount: partial.memoryCount ?? 0,
    sourceCount: partial.sourceCount ?? 0,
    firstMemoryAt: partial.firstMemoryAt ?? null,
    lastMemoryAt: partial.lastMemoryAt ?? null,
    recentMemories: partial.recentMemories ?? [],
  }
}
