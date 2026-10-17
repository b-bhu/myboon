import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { entityIdentityKey } from './identity-key'

// #337 PR-A: managed_knowledge_private.entity_name_key_v1 must equal the TS key.
// The SQL check script asserts each (input, expected) fixture against Postgres;
// this test asserts the same fixtures against entityIdentityKey.
test('SQL name_key fixtures in the #337 check script equal entityIdentityKey', () => {
  const sql = readFileSync(resolve(__dirname, '../../../../supabase/tests/20261017120000_managed_entity_columns.check.sql'), 'utf8')
  const block = sql.slice(sql.indexOf('DO $namekey$'), sql.indexOf('$namekey$;'))
  const fixtures = [...block.matchAll(/\('((?:[^']|'')*)','((?:[^']|'')*)'\)/g)].map((match) => [match[1].replace(/''/g, "'"), match[2].replace(/''/g, "'")])
  assert.ok(fixtures.length >= 15, `expected the name_key fixtures, found ${fixtures.length}`)
  for (const [value, expected] of fixtures) assert.equal(entityIdentityKey(value), expected, value)
})
