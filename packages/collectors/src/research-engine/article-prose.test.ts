import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ARTICLE_TIMELINE_SUMMARY_MAX_CHARS, articleBodyValidator, buildArticlePrompt, articleFillerIssues, finalizeTimelineSummary,
} from './structured-synthesizer'

const branch = { name: 'Iran', relationship: 'related_story_branch' as const, priorItemId: 'item-hormuz', summary: 'Iran holds the Hormuz strait.' }
const standalone = { name: 'Federal Reserve', relationship: 'same_topic_only' as const, priorItemId: null, summary: 'The Fed is watching inflation.' }

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Saudi Arabia and UAE weigh response',
    timelineSummary: 'Saudi Arabia and the UAE met on Oct 15 to coordinate their response to Iranian threats on Gulf shipping.',
    body: null,
    entityUpdates: [{ entity: 'Iran', priorItemId: 'item-hormuz', itemSummary: 'Follows the Hormuz strikes: Gulf states are now coordinating, raising the cost of further escalation for Iran.', updatedEntitySummary: 'Iran faces coordinated Gulf pressure on shipping, which raises the cost of further escalation after the Hormuz strikes.' }],
    eventAt: null, completion: 'complete',
    ...overrides,
  }
}

describe('article prose validation (#341 entity updates)', () => {
  it('accepts a branch update that cites the selected prior item', () => {
    assert.equal(articleBodyValidator([branch])(body()).valid, true)
  })

  it('rejects a branch update that cites a different or no prior item', () => {
    for (const priorItemId of ['item-other', null]) {
      const result = articleBodyValidator([branch])(body({ entityUpdates: [{ entity: 'Iran', priorItemId, itemSummary: 'Matters for Iran.', updatedEntitySummary: 'Iran now faces coordinated Gulf pressure.' }] }))
      assert.equal(result.valid, false)
      assert.ok((result.issues ?? []).some((issue) => issue.includes('item-hormuz')))
    }
  })

  it('requires a standalone membership to claim no link', () => {
    const validate = articleBodyValidator([standalone])
    assert.equal(validate(body({ entityUpdates: [{ entity: 'Federal Reserve', priorItemId: null, itemSummary: 'Signals the Fed is watching oil-driven inflation.', updatedEntitySummary: 'The Fed is watching oil-driven inflation.' }] })).valid, true)
    assert.equal(validate(body({ entityUpdates: [{ entity: 'Federal Reserve', priorItemId: 'item-hormuz', itemSummary: 'x', updatedEntitySummary: 'y' }] })).valid, false)
  })

  it('requires one update per membership, in order, with itemSummary within 280 chars', () => {
    const validate = articleBodyValidator([branch, standalone])
    assert.equal(validate(body()).valid, false)
    const tooLong = articleBodyValidator([branch])(body({ entityUpdates: [{ entity: 'Iran', priorItemId: 'item-hormuz', itemSummary: 'a'.repeat(281), updatedEntitySummary: 'Iran now faces coordinated Gulf pressure.' }] }))
    assert.equal(tooLong.valid, false)
    const wrongOrder = validate(body({ entityUpdates: [
      { entity: 'Federal Reserve', priorItemId: null, itemSummary: 'x', updatedEntitySummary: 'Fed stands.' },
      { entity: 'Iran', priorItemId: 'item-hormuz', itemSummary: 'y', updatedEntitySummary: 'Iran stands.' },
    ] }))
    assert.equal(wrongOrder.valid, false)
  })

  it('rejects the legacy body shape without entityUpdates', () => {
    const legacy = body(); delete legacy.entityUpdates
    assert.equal(articleBodyValidator([branch])(legacy).valid, false)
  })
})

describe('concise summaries (#345)', () => {
  it('rejects editor credits and article-retelling filler', () => {
    const validate = articleBodyValidator([branch])
    for (const filler of [
      'Iran warned Gulf shippers, edited by Estefano Gomez.',
      'Per the article, Iran warned Gulf shippers.',
      'According to the report, Iran warned Gulf shippers.',
      'The article says Iran warned Gulf shippers.',
    ]) assert.equal(validate(body({ timelineSummary: filler })).valid, false, filler)
    assert.deepEqual(articleFillerIssues('Reuters reported Iran warned Gulf shippers.', 'x'), [])
    for (const attribution of ['Iran warned Gulf shippers, as reported by Reuters.', 'A statement written by the Fed said rates hold.', 'Iran warned shippers, reported by Reuters on Thursday.']) {
      assert.equal(validate(body({ timelineSummary: attribution })).valid, true, attribution)
    }
    assert.equal(validate(body({ timelineSummary: 'Iran warned shippers. Fact-checked by Jane Doe.' })).valid, false)
  })

  it('rejects summaries far beyond the blurb limit and trims the rest at a sentence boundary', () => {
    assert.equal(articleBodyValidator([branch])(body({ timelineSummary: 'Iran news. '.repeat(200) })).valid, false)
    const long = `${'Iran closed the strait to tankers on Thursday. '.repeat(12)}`
    const trimmed = finalizeTimelineSummary(long)
    assert.ok(trimmed.length <= ARTICLE_TIMELINE_SUMMARY_MAX_CHARS, String(trimmed.length))
    assert.ok(trimmed.endsWith('Thursday.'))
  })

  it('falls back to a word boundary when there is no sentence end', () => {
    const trimmed = finalizeTimelineSummary(`Iran ${'escalates '.repeat(80)}`)
    assert.ok(trimmed.length <= ARTICLE_TIMELINE_SUMMARY_MAX_CHARS)
    assert.ok(trimmed.endsWith('escalates…'))
  })

  it('leaves short summaries untouched apart from whitespace', () => {
    assert.equal(finalizeTimelineSummary('  Iran warned  shippers. '), 'Iran warned shippers.')
  })
})

describe('article prompt (#345 lead-with-entity)', () => {
  it('names the primary entity in the lead instruction and passes the prior item id and current summary', () => {
    const prompt = buildArticlePrompt({
      signal: { title: 'Gulf talks', publishedAt: null, observedAt: '2026-10-16T00:00:00.000Z' },
      articlePreparation: {
        memberships: [
          { name: 'Bitcoin', role: 'related', relationship: 'same_topic_only', priorItemId: null, summary: 'Bitcoin has been range-bound.' },
          { name: 'Iran', role: 'primary', relationship: 'related_story_branch', priorItemId: 'item-hormuz', summary: 'Iran holds the Hormuz strait.' },
        ],
        novelty: { choice: 'new_development' }, contextualHistory: 'history',
      },
    } as never, { finalUrl: 'https://example.com/a', retrievedAt: '2026-10-16T00:00:00.000Z', truncated: false, text: 'body' } as never)
    assert.match(prompt, /leads with the news about "Iran"/)
    assert.match(prompt, /"priorItemId":"item-hormuz"/)
    assert.match(prompt, /"currentSummary":"Iran holds the Hormuz strait\."/)
  })
})