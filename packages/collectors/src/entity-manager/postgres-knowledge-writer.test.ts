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

test('checkArticleContextAvailability probes EXECUTE via has_function_privilege without running the function', async () => {
  const queries: string[] = []
  {
    const writer = Object.create(PostgresKnowledgeOperationWriter.prototype) as PostgresKnowledgeOperationWriter
    Object.defineProperty(writer, 'pool', { value: { query: async (text: string) => { queries.push(text); return { rows: [{ ok: true }] } } } })
    await writer.checkArticleContextAvailability()
  }
  assert.equal(queries.length, 1)
  assert.equal(queries[0],
    "select pg_catalog.has_function_privilege('managed_knowledge_private.article_context_v1(jsonb)', 'EXECUTE') as ok")
  const refused = Object.create(PostgresKnowledgeOperationWriter.prototype) as PostgresKnowledgeOperationWriter
  Object.defineProperty(refused, 'pool', { value: { query: async () => ({ rows: [{ ok: false }] }) } })
  await assert.rejects(refused.checkArticleContextAvailability(), /Managed article context is not executable by this login/)
})

test('articleContext forwards perEntityLimit only when given and clamps it to 1..10', async () => {
  const writer = Object.create(PostgresKnowledgeOperationWriter.prototype) as PostgresKnowledgeOperationWriter
  const inputs: Array<Record<string, unknown>> = []
  const context = { entities: [], items: [], digest: 'fixture', watermark: null, truncated: false, articleItems: [], candidateTruncated: false }
  Object.defineProperty(writer, 'pool', { value: { query: async (_text: string, params: string[]) => {
    inputs.push(JSON.parse(params[0]))
    return { rows: [{ result: context }] }
  } } })
  await writer.articleContext({ source: 'news', sourceRefs: [] })
  await writer.articleContext({ source: 'news', sourceRefs: [], perEntityLimit: 99 })
  await writer.articleContext({ source: 'news', sourceRefs: [], perEntityLimit: 0 })
  await writer.articleContext({ source: 'news', sourceRefs: [], perEntityLimit: 5.7 })
  assert.equal(inputs[0].perEntityLimit, undefined, 'omitted key keeps today\'s function input')
  assert.equal(inputs[1].perEntityLimit, 10)
  assert.equal(inputs[2].perEntityLimit, 1)
  assert.equal(inputs[3].perEntityLimit, 5)
})