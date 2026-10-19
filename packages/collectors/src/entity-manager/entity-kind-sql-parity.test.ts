import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { legacyEntityTypeToKindV1 } from './entity-knowledge-context'

// #342 PR-4: managed_knowledge_private.entity_kind_v1 (the SQL CASE in the
// migration below) must equal the TS legacyEntityTypeToKindV1 pair-for-pair and
// normalise the same way, because the writer boundary sends TS-mapped kinds and
// the SQL trigger/fill-path applies the same map on insert.
test('SQL entity_kind_v1 CASE pairs in the #342 migration equal legacyEntityTypeToKindV1', () => {
  const sql = readFileSync(resolve(__dirname, '../../../../supabase/migrations/20261019230000_entity_kind_v1.sql'), 'utf8')
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION managed_knowledge_private.entity_kind_v1')
  const end = sql.indexOf('$kind$;')
  assert.ok(start >= 0 && end > start, 'expected the entity_kind_v1 function block to exist')
  const block = sql.slice(start, end)
  const pairs = [...block.matchAll(/WHEN\s+'([^']+)'\s+THEN\s+'([^']+)'/g)].map((match) => [match[1], match[2]] as const)
  assert.ok(pairs.length >= 42, `expected the kind CASE when/then pairs, found ${pairs.length}`)
  const seen = new Set<string>()
  for (const [token, kind] of pairs) {
    assert.ok(!seen.has(token), `duplicate CASE token ${token}`)
    seen.add(token)
    assert.equal(legacyEntityTypeToKindV1(token), kind, token)
    // The SQL normalisation is lower(trim(value)) then runs of spaces/hyphens to
    // '_': the same token in separator and case variants must agree in TS.
    assert.equal(legacyEntityTypeToKindV1(token.replace(/_/g, ' ')), kind, token)
    assert.equal(legacyEntityTypeToKindV1(token.replace(/_/g, '-')), kind, token)
    assert.equal(legacyEntityTypeToKindV1(token.toUpperCase()), kind, token)
  }
  // The SQL ELSE (and the unmapped/empty/blank inputs it absorbs) is 'unclassified'.
  assert.equal(legacyEntityTypeToKindV1('made-up-value'), 'unclassified')
  assert.equal(legacyEntityTypeToKindV1(''), 'unclassified')
  assert.equal(legacyEntityTypeToKindV1('   '), 'unclassified')
  assert.ok(block.includes("ELSE 'unclassified'"))
})