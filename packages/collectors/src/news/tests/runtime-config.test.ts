import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_NEWS_RESEARCH_BACKLOG_WARN_AGE_MS,
  DEFAULT_NEWS_RESEARCH_BACKLOG_WARN_COUNT,
  DEFAULT_NEWS_RESEARCH_BATCH_SIZE,
  DEFAULT_NEWS_RESEARCH_CONCURRENCY,
  MAX_NEWS_RESEARCH_CONCURRENCY,
  DEFAULT_NEWS_FEED_INTERVAL_MS,
  newsResearchBacklogWarnAgeMs,
  newsResearchBacklogWarnCount,
  newsResearchBatchSize,
  newsResearchConcurrency,
  positiveInteger,
} from '../runtime-config'

test('news research defaults to ten candidates across two bounded lanes', () => {
  assert.equal(DEFAULT_NEWS_RESEARCH_BATCH_SIZE, 10)
  assert.equal(newsResearchBatchSize(undefined), 10)
  assert.equal(DEFAULT_NEWS_RESEARCH_CONCURRENCY, 2)
  assert.equal(newsResearchConcurrency(undefined), 2)
})

test('NEWS_RESEARCHER_BATCH_SIZE accepts positive integer overrides', () => {
  assert.equal(newsResearchBatchSize('1'), 1)
  assert.equal(newsResearchBatchSize('12'), 12)
})

test('research concurrency and backlog warning thresholds accept positive overrides', () => {
  assert.equal(newsResearchConcurrency('3'), 3)
  assert.equal(MAX_NEWS_RESEARCH_CONCURRENCY, 4)
  assert.equal(newsResearchConcurrency('100'), 4)
  assert.equal(DEFAULT_NEWS_RESEARCH_BACKLOG_WARN_COUNT, 20)
  assert.equal(newsResearchBacklogWarnCount('40'), 40)
  assert.equal(DEFAULT_NEWS_RESEARCH_BACKLOG_WARN_AGE_MS, 60 * 60_000)
  assert.equal(newsResearchBacklogWarnAgeMs('7200000'), 7_200_000)
})

test('invalid batch and timeout values use their fallback', () => {
  for (const value of ['', '0', '-2', '1.5', 'not-a-number']) {
    assert.equal(positiveInteger(value || undefined, 7), 7)
  }
})

test('news feed ingestion defaults to a ten-minute interval', () => {
  assert.equal(DEFAULT_NEWS_FEED_INTERVAL_MS, 10 * 60_000)
})
