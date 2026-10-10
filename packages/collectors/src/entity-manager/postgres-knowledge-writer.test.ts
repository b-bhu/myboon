import assert from 'node:assert/strict'
import test from 'node:test'
import { PostgresKnowledgeOperationWriter } from './postgres-knowledge-writer'

test('article adapter advertises combined coverage only after a supported deployed response', async () => {
  // Prototype fixture exercises the real method/getter without creating a pool.
  const writer = Object.create(PostgresKnowledgeOperationWriter.prototype) as PostgresKnowledgeOperationWriter
  let context: Record<string, unknown> = { entities: [], items: [], articleItems: [], digest: 'fixture', watermark: null, truncated: false }
  Object.defineProperty(writer, 'pool', { value: { query: async () => ({ rows: [{ result: context }] }) } })
  assert.equal(writer.articleHistoryCoverage, undefined)
  await writer.articleContext({ source: 'news', sourceRefs: [] })
  assert.equal(writer.articleHistoryCoverage, undefined, 'older response keeps the uncached compatibility path')
  context = { ...context, candidateTruncated: false }
  await writer.articleContext({ source: 'news', sourceRefs: [] })
  assert.equal(writer.articleHistoryCoverage, 'legacy_and_managed')
  context = { ...context, articleItems: undefined }
  await writer.articleContext({ source: 'news', sourceRefs: [] })
  assert.equal(writer.articleHistoryCoverage, undefined, 'a later old-shaped response revokes the capability')
})
