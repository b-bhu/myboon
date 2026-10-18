import type { SupabaseClient } from '@supabase/supabase-js'

export const MANAGED_ENTITY_LOOKUP_MAX = 100

export interface ManagedEntityRow {
  id: string
  slug: string
  name: string
  type: string
  aliases: unknown
  summary: string | null
  status: string
  show_in_carousel: boolean | null
  metadata: Record<string, unknown>
  created_at: string | null
  updated_at: string | null
  catalog_entity_id: string | null
}

function asMetadata(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function isManagedEntityRowList(data: unknown): data is ManagedEntityRow[] {
  return Array.isArray(data) && data.every((row) => {
    const record = row as Record<string, unknown> | null
    return record !== null && typeof record === 'object' && !Array.isArray(record)
      && typeof record.id === 'string'
      && typeof record.slug === 'string'
      && typeof record.name === 'string'
      && typeof record.type === 'string'
      && typeof record.status === 'string'
  })
}

function normalizeManagedEntityRow(row: unknown): ManagedEntityRow {
  // Row shape is already validated by isManagedEntityRowList.
  const record = row as Record<string, unknown>
  return {
    id: record.id as string,
    slug: record.slug as string,
    name: record.name as string,
    type: record.type as string,
    aliases: record.aliases,
    summary: typeof record.summary === 'string' ? record.summary : null,
    status: record.status as string,
    show_in_carousel: typeof record.show_in_carousel === 'boolean' ? record.show_in_carousel : null,
    metadata: asMetadata(record.metadata),
    created_at: typeof record.created_at === 'string' ? record.created_at : null,
    updated_at: typeof record.updated_at === 'string' ? record.updated_at : null,
    catalog_entity_id: typeof record.catalog_entity_id === 'string' ? record.catalog_entity_id : null,
  }
}

export async function fetchManagedEntities(db: SupabaseClient, ids: string[]): Promise<ManagedEntityRow[]> {
  const uniqueIds = [...new Set(ids)]
  if (uniqueIds.length === 0) return []
  const rows: ManagedEntityRow[] = []
  for (let offset = 0; offset < uniqueIds.length; offset += MANAGED_ENTITY_LOOKUP_MAX) {
    const chunk = uniqueIds.slice(offset, offset + MANAGED_ENTITY_LOOKUP_MAX)
    const { data, error } = await db.rpc('read_managed_entities_v1', { p_entity_ids: chunk })
    if (error) throw new Error(`managed entity lookup failed: ${error.message}`)
    if (!isManagedEntityRowList(data)) throw new Error('managed entity lookup returned an invalid result')
    rows.push(...data.map(normalizeManagedEntityRow))
  }
  return rows
}

export async function fetchActiveManagedEntities(db: SupabaseClient, ids: string[]): Promise<ManagedEntityRow[]> {
  // read_managed_entities_v1 returns every status; callers here want the same
  // active-only view the knowledge reader RPC serves.
  return (await fetchManagedEntities(db, ids)).filter((row) => row.status === 'active')
}