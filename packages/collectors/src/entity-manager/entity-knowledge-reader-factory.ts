import type { SupabaseClient } from '@supabase/supabase-js'
import type { EntityKnowledgeReader } from './entity-knowledge-reader'
import { DualEntityKnowledgeReader, SupabaseManagedEntityKnowledgeReader } from './managed-entity-knowledge-reader'
import { SupabaseEntityKnowledgeReader } from './supabase-entity-knowledge-reader'

export const ENTITY_KNOWLEDGE_READ_SOURCE_ENV = 'ENTITY_V4_READ_SOURCE'

export type EntityKnowledgeReadSource = 'legacy' | 'dual' | 'managed'

export function entityKnowledgeReadSource(
  env: Readonly<Record<string, string | undefined>>,
): EntityKnowledgeReadSource {
  const value = env[ENTITY_KNOWLEDGE_READ_SOURCE_ENV]?.trim() ?? ''
  if (value === '') return 'legacy'
  if (value === 'legacy' || value === 'dual' || value === 'managed') return value
  throw new Error(`${ENTITY_KNOWLEDGE_READ_SOURCE_ENV} must be legacy, dual or managed (got ${JSON.stringify(value)})`)
}

export function createEntityKnowledgeReader(
  db: SupabaseClient,
  env: Readonly<Record<string, string | undefined>> = process.env,
): EntityKnowledgeReader {
  const readers: Record<EntityKnowledgeReadSource, (db: SupabaseClient) => EntityKnowledgeReader> = {
    legacy: (nextDb) => new SupabaseEntityKnowledgeReader(nextDb),
    dual: (nextDb) => new DualEntityKnowledgeReader(nextDb),
    managed: (nextDb) => new SupabaseManagedEntityKnowledgeReader(nextDb),
  }
  return readers[entityKnowledgeReadSource(env)](db)
}