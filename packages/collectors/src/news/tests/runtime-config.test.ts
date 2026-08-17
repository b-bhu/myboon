import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_NEWS_RESEARCH_BATCH_SIZE,
  DEFAULT_NEWS_FEED_INTERVAL_MS,
  newsResearchBatchSize,
  positiveInteger,
} from '../runtime-config'

test('news research defaults to five candidates per pipeline cycle', () => {
  assert.equal(DEFAULT_NEWS_RESEARCH_BATCH_SIZE, 5)
  assert.equal(newsResearchBatchSize(undefined), 5)
})

test('NEWS_RESEARCHER_BATCH_SIZE accepts positive integer overrides', () => {
  assert.equal(newsResearchBatchSize('1'), 1)
  assert.equal(newsResearchBatchSize('12'), 12)
})

test('invalid batch and timeout values use their fallback', () => {
  for (const value of ['', '0', '-2', '1.5', 'not-a-number']) {
    assert.equal(positiveInteger(value || undefined, 7), 7)
  }
})

test('news feed ingestion defaults to a ten-minute interval', () => {
  assert.equal(DEFAULT_NEWS_FEED_INTERVAL_MS, 10 * 60_000)
})
