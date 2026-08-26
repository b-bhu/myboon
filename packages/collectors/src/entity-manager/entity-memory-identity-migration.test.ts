import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const migrationPath = resolve(
  __dirname,
  '../../../../supabase/migrations/20260826175053_add_entity_memory_identity_key.sql',
)
const sql = readFileSync(migrationPath, 'utf8')

test('identity migration adds, backfills, validates, and uniquely indexes every memory identity', () => {
  assert.match(sql, /ADD COLUMN memory_identity_key text/i)
  assert.match(sql, /UPDATE public\.entity_memories[\s\S]*SET memory_identity_key/i)
  assert.match(sql, /extensions\.digest\([\s\S]*'sha256'/i)
  assert.match(sql, /myboon\.memory_identity\.v1:legacy:/i)
  assert.match(sql, /concat_ws\([\s\S]*chr\(31\)[\s\S]*source[\s\S]*source_area[\s\S]*source_research_id[\s\S]*entity_id[\s\S]*memory_type[\s\S]*title/i)
  assert.match(sql, /ALTER COLUMN memory_identity_key SET NOT NULL/i)
  assert.match(sql, /CHECK \([\s\S]*memory_identity_key ~/i)
  assert.match(sql, /CREATE UNIQUE INDEX entity_memories_identity_key_unique_idx/i)
})

test('identity migration is non-destructive and leaves security configuration untouched', () => {
  assert.doesNotMatch(sql, /^\s*(?:DELETE|MERGE|TRUNCATE|DROP TABLE)\b/im)
  assert.doesNotMatch(sql, /\bENABLE ROW LEVEL SECURITY\b|\bDISABLE ROW LEVEL SECURITY\b/i)
  assert.doesNotMatch(sql, /\bCREATE POLICY\b|\bDROP POLICY\b|\bGRANT\b|\bREVOKE\b/i)
  assert.match(sql, /former unique tuple/i)
})
