import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyNewsCandidate } from '../dedupe'
import {
  canonicalArticleUrl,
  fingerprintNewsCandidate,
  hashText,
} from '../fingerprint'
import type { NewsCandidate, PriorNewsObservation } from '../types'

const sourceId = 'news_feed:articles'
const urlId = 'feed'

function candidate(overrides: Partial<NewsCandidate> = {}): NewsCandidate {
  return {
    headline: 'Bitcoin ETF inflows rise again',
    article_url: 'https://www.coindesk.com/markets/2026/07/04/bitcoin-etf-inflows-rise/?utm_source=x&gclid=123',
    summary: 'Funds saw another day of net inflows.',
    ...overrides,
  }
}

function priorObservation(
  input: NewsCandidate,
  overrides: Partial<PriorNewsObservation> = {}
): PriorNewsObservation {
  const fingerprint = fingerprintNewsCandidate(sourceId, urlId, input)
  return {
    sourceId: fingerprint.sourceId,
    urlId: fingerprint.urlId,
    canonicalArticleUrl: fingerprint.canonicalArticleUrl,
    headlineHash: fingerprint.headlineHash,
    summaryHash: fingerprint.summaryHash,
    articleIdentityKey: fingerprint.articleIdentityKey,
    observationDedupeKey: fingerprint.observationDedupeKey,
    observedAt: '2026-07-04T12:00:00.000Z',
    ...overrides,
  }
}

test('canonicalArticleUrl removes tracking params and fragments', () => {
  assert.equal(
    canonicalArticleUrl('HTTPS://WWW.COINDesk.com/article/?utm_source=x&utm_medium=y&fbclid=1&gclid=2#section'),
    'https://www.coindesk.com/article'
  )
})

test('canonicalArticleUrl sorts query params deterministically', () => {
  assert.equal(
    canonicalArticleUrl('https://www.coindesk.com/article?b=2&a=1&b=1'),
    'https://www.coindesk.com/article?a=1&b=1&b=2'
  )
})

test('hashText trims and collapses whitespace', () => {
  assert.equal(hashText(' Bitcoin   ETF\ninflows '), hashText('Bitcoin ETF inflows'))
})

test('same article URL, headline, and summary is known_unchanged', () => {
  const input = candidate()
  const decision = classifyNewsCandidate(sourceId, urlId, input, [priorObservation(input)])

  assert.equal(decision.outcome, 'known_unchanged')
  assert.ok(decision.fingerprint)
})

test('same article URL with changed headline is known_unchanged', () => {
  const prior = priorObservation(candidate())
  const decision = classifyNewsCandidate(sourceId, urlId, candidate({
    headline: 'Bitcoin ETF inflows accelerate',
  }), [prior])

  assert.equal(decision.outcome, 'known_unchanged')
  assert.notEqual(decision.fingerprint?.observationDedupeKey, prior.observationDedupeKey)
})

test('stable feed identity ignores cosmetic headline changes for the same canonical URL', () => {
  const prior = priorObservation(candidate())
  const decision = classifyNewsCandidate(sourceId, urlId, candidate({
    headline: 'COINDESK: Bitcoin ETF inflows rise again',
  }), [prior])

  assert.equal(decision.outcome, 'known_unchanged')
  assert.match(decision.reason, /stable feed identity/)
})

test('same article URL with changed summary is known_unchanged', () => {
  const prior = priorObservation(candidate())
  const decision = classifyNewsCandidate(sourceId, urlId, candidate({
    summary: 'Funds saw a larger day of net inflows.',
  }), [prior])

  assert.equal(decision.outcome, 'known_unchanged')
  assert.notEqual(decision.fingerprint?.summaryHash, prior.summaryHash)
})

test('new canonical article URL is new_candidate', () => {
  const decision = classifyNewsCandidate(sourceId, urlId, candidate({
    article_url: 'https://www.coindesk.com/markets/2026/07/04/new-article',
  }), [priorObservation(candidate())])

  assert.equal(decision.outcome, 'new_candidate')
})

test('malformed article URL is ignored_invalid_candidate', () => {
  const decision = classifyNewsCandidate(sourceId, urlId, candidate({
    article_url: 'not a url',
  }), [])

  assert.equal(decision.outcome, 'ignored_invalid_candidate')
  assert.equal(decision.fingerprint, null)
})

test('truncated article URLs are ignored per candidate', () => {
  for (const articleUrl of [
    'https://www.theblock.co/post/12345/bitcoin-mar...',
    'https://www.theblock.co/post/12345/bitcoin-mar…',
  ]) {
    const decision = classifyNewsCandidate(sourceId, urlId, candidate({
      article_url: articleUrl,
    }), [])

    assert.equal(decision.outcome, 'ignored_invalid_candidate')
    assert.equal(decision.fingerprint, null)
    assert.equal(decision.reason, 'candidate article_url is truncated')
  }
})

test('missing article URL is ignored_invalid_candidate', () => {
  const decision = classifyNewsCandidate(sourceId, urlId, candidate({
    article_url: '',
  }), [])

  assert.equal(decision.outcome, 'ignored_invalid_candidate')
  assert.equal(decision.fingerprint, null)
})

test('missing headline is ignored_invalid_candidate', () => {
  const decision = classifyNewsCandidate(sourceId, urlId, candidate({
    headline: ' ',
  }), [])

  assert.equal(decision.outcome, 'ignored_invalid_candidate')
  assert.equal(decision.fingerprint, null)
})

test('same article on a different configured URL shares article identity but has a different observation key', () => {
  const input = candidate()
  const latestFingerprint = fingerprintNewsCandidate(sourceId, 'latest_crypto_news', input)
  const policyFingerprint = fingerprintNewsCandidate(sourceId, 'policy', input)

  assert.equal(policyFingerprint.articleIdentityKey, latestFingerprint.articleIdentityKey)
  assert.notEqual(policyFingerprint.observationDedupeKey, latestFingerprint.observationDedupeKey)
})

test('same article content on a different configured URL is known_unchanged', () => {
  const input = candidate()
  const decision = classifyNewsCandidate(sourceId, 'policy', input, [priorObservation(input)])

  assert.equal(decision.outcome, 'known_unchanged')
  assert.notEqual(decision.fingerprint?.observationDedupeKey, priorObservation(input).observationDedupeKey)
})

test('same article from a different source is not collapsed as a duplicate', () => {
  const input = candidate()
  const prior = priorObservation(input, {
    sourceId: 'other_source',
    articleIdentityKey: fingerprintNewsCandidate('other_source', urlId, input).articleIdentityKey,
  })
  const decision = classifyNewsCandidate(sourceId, urlId, input, [prior])

  assert.equal(decision.outcome, 'new_candidate')
})
