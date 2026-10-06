import assert from 'node:assert/strict'
import test from 'node:test'
import { latestArticleCapture } from './article-capture'

test('a refreshed article is selected without changing earlier captures or selecting a source hint', () => {
  const old = { authority: 'source_url', retrievedAt: '2026-10-05T10:00:00Z', evidenceId: 'old', text: 'Old page capture' }
  const current = { authority: 'source_url', retrievedAt: '2026-10-06T10:00:00Z', evidenceId: 'current', text: 'Complete refreshed article' }
  const hint = { authority: 'source_hint', retrievedAt: '2026-10-06T11:00:00Z', evidenceId: 'hint', text: 'Related page' }
  const history = [old, current, hint]
  assert.equal(latestArticleCapture(history), current)
  assert.deepEqual(history, [old, current, hint])
  assert.equal(latestArticleCapture([hint]), undefined)
})
