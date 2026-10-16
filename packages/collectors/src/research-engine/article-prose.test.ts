import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ARTICLE_TIMELINE_SUMMARY_MAX_CHARS, articleBodyValidator, articleFillerIssues, finalizeTimelineSummary,
} from './structured-synthesizer'

const branch = { name: 'Iran', relationship: 'related_story_branch' as const, priorItemId: 'item-hormuz' }
const standalone = { name: 'Federal Reserve', relationship: 'same_topic_only' as const, priorItemId: null }

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Saudi Arabia and UAE weigh response',
    timelineSummary: 'Saudi Arabia and the UAE met on Oct 15 to coordinate their response to Iranian threats on Gulf shipping.',
    body: null,
    relationSummaries: [{ entity: 'Iran', priorItemId: 'item-hormuz', text: 'Follows the Hormuz strikes: Gulf states are now coordinating, raising the cost of further escalation for Iran.' }],
    eventAt: null, limitations: [], openQuestions: [], completion: 'complete',
    ...overrides,
  }
}

describe('article prose validation (#340 relation summaries)', () => {
  it('accepts a branch summary that cites the selected prior item', () => {
    assert.equal(articleBodyValidator([branch])(body()).valid, true)
  })

  it('rejects a branch summary that cites a different or no prior item', () => {
    for (const priorItemId of ['item-other', null]) {
      const result = articleBodyValidator([branch])(body({ relationSummaries: [{ entity: 'Iran', priorItemId, text: 'Matters for Iran.' }] }))
      assert.equal(result.valid, false)
      assert.ok((result.issues ?? []).some((issue) => issue.includes('item-hormuz')))
    }
  })

  it('requires a standalone membership to claim no link', () => {
    const validate = articleBodyValidator([standalone])
    assert.equal(validate(body({ relationSummaries: [{ entity: 'Federal Reserve', priorItemId: null, text: 'Signals the Fed is watching oil-driven inflation.' }] })).valid, true)
    assert.equal(validate(body({ relationSummaries: [{ entity: 'Federal Reserve', priorItemId: 'item-hormuz', text: 'x' }] })).valid, false)
  })

  it('requires one summary per membership, in order, within 280 chars', () => {
    const validate = articleBodyValidator([branch, standalone])
    assert.equal(validate(body()).valid, false)
    const tooLong = articleBodyValidator([branch])(body({ relationSummaries: [{ entity: 'Iran', priorItemId: 'item-hormuz', text: 'a'.repeat(281) }] }))
    assert.equal(tooLong.valid, false)
    const wrongOrder = validate(body({ relationSummaries: [
      { entity: 'Federal Reserve', priorItemId: null, text: 'x' }, { entity: 'Iran', priorItemId: 'item-hormuz', text: 'y' },
    ] }))
    assert.equal(wrongOrder.valid, false)
  })

  it('rejects the legacy body shape without relationSummaries', () => {
    const legacy = body(); delete legacy.relationSummaries
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
