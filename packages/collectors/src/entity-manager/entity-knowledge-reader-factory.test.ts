import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  ENTITY_KNOWLEDGE_READ_SOURCE_ENV,
  createEntityKnowledgeReader,
  entityKnowledgeReadSource,
} from './entity-knowledge-reader-factory'
import { DualEntityKnowledgeReader, SupabaseManagedEntityKnowledgeReader } from './managed-entity-knowledge-reader'
import { SupabaseEntityKnowledgeReader } from './supabase-entity-knowledge-reader'

test('missing or blank ENTITY_V4_READ_SOURCE falls back to the legacy reader', () => {
  assert.equal(entityKnowledgeReadSource({}), 'legacy')
  assert.equal(entityKnowledgeReadSource({ [ENTITY_KNOWLEDGE_READ_SOURCE_ENV]: '' }), 'legacy')
  assert.equal(entityKnowledgeReadSource({ [ENTITY_KNOWLEDGE_READ_SOURCE_ENV]: '  ' }), 'legacy')
})

test('ENTITY_V4_READ_SOURCE selects the dual and managed sources', () => {
  assert.equal(entityKnowledgeReadSource({ [ENTITY_KNOWLEDGE_READ_SOURCE_ENV]: 'dual' }), 'dual')
  assert.equal(entityKnowledgeReadSource({ [ENTITY_KNOWLEDGE_READ_SOURCE_ENV]: 'managed' }), 'managed')
})

test('unknown ENTITY_V4_READ_SOURCE values fail closed naming the variable', () => {
  assert.throws(
    () => entityKnowledgeReadSource({ [ENTITY_KNOWLEDGE_READ_SOURCE_ENV]: 'Managed' }),
    /ENTITY_V4_READ_SOURCE must be legacy, dual or managed \(got "Managed"\)/,
  )
  assert.throws(
    () => entityKnowledgeReadSource({ [ENTITY_KNOWLEDGE_READ_SOURCE_ENV]: 'v4' }),
    /ENTITY_V4_READ_SOURCE must be legacy, dual or managed \(got "v4"\)/,
  )
})

test('createEntityKnowledgeReader builds the reader matching the source', () => {
  const db = {} as SupabaseClient
  assert.ok(createEntityKnowledgeReader(db, {}) instanceof SupabaseEntityKnowledgeReader)
  assert.ok(
    createEntityKnowledgeReader(db, { [ENTITY_KNOWLEDGE_READ_SOURCE_ENV]: 'dual' }) instanceof DualEntityKnowledgeReader,
  )
  assert.ok(
    createEntityKnowledgeReader(db, { [ENTITY_KNOWLEDGE_READ_SOURCE_ENV]: 'managed' }) instanceof
      SupabaseManagedEntityKnowledgeReader,
  )
})