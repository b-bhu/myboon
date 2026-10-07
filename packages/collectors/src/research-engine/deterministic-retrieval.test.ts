import assert from 'node:assert/strict'
import test from 'node:test'
import type { SafePublicDocument, SafePublicFetchOptions } from '../news/safe-public-http'
import {
  DeterministicRetriever,
  RetrievalPlanError,
  isEvidenceReusable,
  type DeterministicRetrievalPlan,
  type RetrievedEvidenceArtifact,
} from './deterministic-retrieval'

const NOW = '2026-08-26T12:00:00.000Z'

function plan(overrides: Partial<DeterministicRetrievalPlan> = {}): DeterministicRetrievalPlan {
  return {
    workId: 'work-1',
    urls: [{
      url: 'https://news.example/article',
      authority: 'source_url',
      authorityId: 'signal-1',
    }],
    allowedDomains: ['news.example'],
    maxSources: 1,
    maxBytesPerSource: 10_000,
    maxTotalBytes: 10_000,
    maxTextCharsPerSource: 1_000,
    maxRedirects: 3,
    timeoutMs: 5_000,
    ...overrides,
  }
}

function document(overrides: Partial<SafePublicDocument> = {}): SafePublicDocument {
  return {
    body: Buffer.from('<html><style>ignore</style><h1>Market update</h1><p>Useful &amp; verified.</p></html>'),
    finalUrl: 'https://news.example/article',
    contentType: 'text/html; charset=utf-8',
    status: 200,
    visitedHosts: ['news.example'],
    ...overrides,
  }
}

test('deterministic retrieval emits stable immutable evidence from an approved plan', async () => {
  const calls: Array<{ url: string, options: SafePublicFetchOptions }> = []
  const retriever = new DeterministicRetriever({
    now: () => new Date(NOW),
    fetchDocument: async (url, options) => {
      calls.push({ url, options })
      return document()
    },
  })

  const first = await retriever.retrieve(plan())
  const second = await retriever.retrieve(plan())

  assert.equal(first.failures.length, 0)
  assert.equal(first.artifacts.length, 1)
  assert.equal(first.artifacts[0].schemaVersion, 'myboon.evidence.v1')
  assert.equal(first.artifacts[0].retrievalMethod, 'safe_http')
  assert.equal(first.artifacts[0].text, 'Market update\nUseful & verified.')
  assert.equal(first.artifacts[0].retrievedAt, NOW)
  assert.equal(first.artifacts[0].evidenceId, second.artifacts[0].evidenceId)
  assert.equal(first.artifacts[0].contentHash, second.artifacts[0].contentHash)
  assert.deepEqual(calls[0].options.allowedDomains, ['news.example'])
  assert.equal(calls[0].options.maxRedirects, 3)
})

test('retrieval honors source and text caps without discovering extra URLs', async () => {
  const requested: string[] = []
  const retriever = new DeterministicRetriever({
    now: () => new Date(NOW),
    fetchDocument: async (url) => {
      requested.push(url)
      return document({
        finalUrl: url,
        body: Buffer.from('<p>abcdefghijklmnopqrstuvwxyz</p>'),
      })
    },
  })
  const result = await retriever.retrieve(plan({
    urls: [
      { url: 'https://news.example/one', authority: 'source_url', authorityId: 'signal-1' },
      { url: 'https://news.example/two', authority: 'source_hint', authorityId: 'hint-1' },
      { url: 'https://news.example/three', authority: 'search_connector', authorityId: 'search-1' },
    ],
    maxSources: 2,
    maxTextCharsPerSource: 10,
  }))

  assert.deepEqual(requested, ['https://news.example/one', 'https://news.example/two'])
  assert.equal(result.skippedUrlCount, 1)
  assert.equal(result.artifacts.length, 2)
  assert.equal(result.artifacts[0].text.length, 10)
  assert.equal(result.artifacts[0].truncated, true)
})

test('publisher Markdown JSON-LD captures the full matching article without duplicated metadata or navigation', async () => {
  const body = '<p>First reported development.</p><p>The complete final paragraph.</p>'
  const unrelated = { '@type': 'NewsArticle', url: 'https://news.example/other', articleBody: 'Unrelated recommendation' }
  const matching = { '@type': ['NewsArticle'], mainEntityOfPage: { '@id': 'https://news.example/article' }, articleBody: body }
  const raw = `Navigation ${'menu '.repeat(4_000)}\n\n# Headline\nFirst reported development.\n\n\`\`\`json\n${JSON.stringify(unrelated)}\n${JSON.stringify(matching)}\n\`\`\``
  const result = await new DeterministicRetriever({ fetchDocument: async () => document({ body: Buffer.from(raw), contentType: 'text/markdown' }) })
    .retrieve(plan({ maxBytesPerSource: 100_000, maxTotalBytes: 100_000 }))
  assert.equal(result.failures.length, 0)
  assert.equal(result.artifacts[0].text, 'First reported development.\nThe complete final paragraph.')
  assert.equal(result.artifacts[0].truncated, false)
})

test('HTML JSON-LD requires a matching article URL and conflicting bodies fall back to visible article text', async () => {
  for (const nodes of [
    [{ '@type': 'NewsArticle', url: 'https://news.example/other', articleBody: 'Wrong article' }],
    ['First', 'Second'].map(articleBody => ({ '@type': 'NewsArticle', url: 'https://news.example/article', articleBody })),
  ]) {
    const raw = `<html><body><div itemprop="articleBody"><p>Complete visible article.</p></div><script type="application/ld+json">${JSON.stringify({ '@graph': nodes })}</script></body></html>`
    const result = await new DeterministicRetriever({ fetchDocument: async () => document({ body: Buffer.from(raw) }) }).retrieve(plan())
    assert.equal(result.artifacts[0].text, 'Complete visible article.')
  }
})

test('retrieval records typed timeout, unsafe, HTTP, and byte-budget failures', async () => {
  const cases: Array<{
    error?: Error & { code?: string }
    response?: SafePublicDocument
    category: string
    retryable: boolean
  }> = [
    {
      error: Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' }),
      category: 'retrieval_timeout',
      retryable: true,
    },
    {
      error: new Error('Article URL resolved to a non-public address'),
      category: 'retrieval_unsafe_url',
      retryable: false,
    },
    {
      response: document({ status: 429, body: Buffer.alloc(0) }),
      category: 'retrieval_blocked',
      retryable: true,
    },
    {
      response: document({ body: Buffer.alloc(20) }),
      category: 'budget_exceeded',
      retryable: false,
    },
  ]

  for (const item of cases) {
    const retriever = new DeterministicRetriever({
      now: () => new Date(NOW),
      fetchDocument: async () => {
        if (item.error) throw item.error
        return item.response!
      },
    })
    const result = await retriever.retrieve(plan({ maxBytesPerSource: 10, maxTotalBytes: 10 }))
    assert.equal(result.artifacts.length, 0)
    assert.equal(result.failures[0].category, item.category)
    assert.equal(result.failures[0].retryable, item.retryable)
  }
})

test('retrieval rejects malformed or unbounded plans before fetching', async () => {
  let called = false
  const retriever = new DeterministicRetriever({
    fetchDocument: async () => {
      called = true
      return document()
    },
  })

  await assert.rejects(
    () => retriever.retrieve(plan({ allowedDomains: [] })),
    (error: unknown) => error instanceof RetrievalPlanError && /allowed domain/.test(error.message),
  )
  await assert.rejects(
    () => retriever.retrieve(plan({ maxSources: 0 })),
    (error: unknown) => error instanceof RetrievalPlanError && /maxSources/.test(error.message),
  )
  assert.equal(called, false)
})

test('evidence reuse applies TTL, byte cap, and configured invalidation triggers', () => {
  const artifact: RetrievedEvidenceArtifact = {
    schemaVersion: 'myboon.evidence.v1',
    evidenceId: 'evidence-1',
    workId: 'work-1',
    requestedUrl: 'https://news.example/article',
    finalUrl: 'https://news.example/article',
    authority: 'source_url',
    authorityId: 'signal-1',
    contentHash: 'hash-1',
    contentType: 'text/plain',
    httpStatus: 200,
    retrievalMethod: 'safe_http',
    retrievedAt: '2026-08-26T10:00:00.000Z',
    text: 'evidence',
    byteLength: 8,
    truncated: false,
  }
  const policy = {
    policyVersion: 'news-v1',
    maxAgeMs: 3 * 60 * 60 * 1_000,
    maxArtifactBytes: 1_000,
    invalidateOn: ['content_hash_changed', 'final_url_changed', 'manual_invalidation'] as const,
  }

  assert.equal(isEvidenceReusable(artifact, { ...policy, invalidateOn: [...policy.invalidateOn] }, {
    now: NOW,
    contentHash: 'hash-1',
    finalUrl: artifact.finalUrl,
  }), true)
  assert.equal(isEvidenceReusable(artifact, { ...policy, invalidateOn: [...policy.invalidateOn] }, {
    now: NOW,
    contentHash: 'hash-2',
  }), false)
  assert.equal(isEvidenceReusable(artifact, { ...policy, invalidateOn: [...policy.invalidateOn] }, {
    now: '2026-08-26T14:00:00.000Z',
  }), false)
  assert.equal(isEvidenceReusable(artifact, { ...policy, invalidateOn: [...policy.invalidateOn] }, {
    now: NOW,
    manuallyInvalidated: true,
  }), false)
})

test('article extraction retains the full development while removing site navigation and executable content', async () => {
  const html = '<html><head><title>Source development</title></head><body><nav>' + 'SITE MENU '.repeat(3_000)
    + '</nav><article><h1>Source development</h1><p>The opening factual development.</p><p>'
    + 'Additional source detail. '.repeat(30) + '</p><p>The final factual development.</p></article>'
    + '<footer>UNRELATED FOOTER</footer><script>throw new Error("must not execute")</script></body></html>'
  const retriever = new DeterministicRetriever({ fetchDocument: async () => ({
    body: Buffer.from(html), contentType: 'text/html', finalUrl: 'https://example.com/article', status: 200, visitedHosts: ['example.com'],
  }) })
  const result = await retriever.retrieve(plan({ maxBytesPerSource: 100_000, maxTotalBytes: 100_000, maxTextCharsPerSource: 10_000 }))
  assert.equal(result.artifacts.length, 1)
  assert.match(result.artifacts[0].text, /opening factual development/)
  assert.match(result.artifacts[0].text, /final factual development/)
  assert.doesNotMatch(result.artifacts[0].text, /SITE MENU|UNRELATED FOOTER|must not execute/)
  assert.equal(result.artifacts[0].truncated, false)
})

test('short and split article bodies exclude neighbouring recommendation cards without losing later paragraphs', async () => {
  for (const body of [
    '<article class="article-content"><p>The first factual development.</p><p>The final factual development.</p></article>',
    '<div class="document-body"><p>The first factual development.</p></div><aside>ADVERTISEMENT</aside>'
      + '<div class="document-body"><p>The final factual development.</p></div>',
  ]) {
    const html = '<html><body><h1>Source development</h1>' + body
      + '<section><h2>Recommended news</h2><p>' + 'UNRELATED NEWS '.repeat(30) + '</p></section></body></html>'
    const retriever = new DeterministicRetriever({ fetchDocument: async () => ({
      body: Buffer.from(html), contentType: 'text/html', finalUrl: 'https://example.com/article', status: 200, visitedHosts: ['example.com'],
    }) })
    const result = await retriever.retrieve(plan({ maxBytesPerSource: 100_000, maxTotalBytes: 100_000, maxTextCharsPerSource: 10_000 }))
    assert.equal(result.artifacts.length, 1)
    assert.match(result.artifacts[0].text, /first factual development/)
    assert.match(result.artifacts[0].text, /final factual development/)
    assert.doesNotMatch(result.artifacts[0].text, /UNRELATED NEWS|Recommended news|ADVERTISEMENT/)
    assert.equal(result.artifacts[0].truncated, false)
  }
})
