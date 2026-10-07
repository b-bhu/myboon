import assert from 'node:assert/strict'
import test from 'node:test'
import { approvedArticleDomains, fetchPublicDocument, type SafePublicHopResponse } from '../safe-public-http'

test('safe public fetch blocks a private redirect before the destination receives a request', async () => {
  const requestedHosts: string[] = []
  const response = (redirectUrl: string | null): SafePublicHopResponse => ({
    status: redirectUrl ? 302 : 200,
    contentType: 'text/html',
    body: Buffer.alloc(0),
    redirectUrl,
  })

  await assert.rejects(() => fetchPublicDocument('https://public.example/article', {
    timeoutMs: 1_000,
    resolveHost: async (hostname) => hostname === 'public.example'
      ? ['93.184.216.34']
      : ['127.0.0.1'],
    requestImpl: async (url) => {
      requestedHosts.push(url.hostname)
      return response('http://private.example/admin')
    },
  }), /non-public/)

  assert.deepEqual(requestedHosts, ['public.example'])
})

test('safe public fetch validates and pins every public redirect hop', async () => {
  const contacts: Array<{ host: string, address: string }> = []
  const document = await fetchPublicDocument('https://one.example/article', {
    timeoutMs: 1_000,
    resolveHost: async (hostname) => hostname === 'one.example'
      ? ['93.184.216.34']
      : ['1.1.1.1'],
    requestImpl: async (url, address) => {
      contacts.push({ host: url.hostname, address })
      return url.hostname === 'one.example'
        ? { status: 302, contentType: null, body: Buffer.alloc(0), redirectUrl: 'https://two.example/final' }
        : { status: 200, contentType: 'text/html', body: Buffer.from('<h1>safe</h1>'), redirectUrl: null }
    },
  })

  assert.deepEqual(contacts, [
    { host: 'one.example', address: '93.184.216.34' },
    { host: 'two.example', address: '1.1.1.1' },
  ])
  assert.deepEqual(document.visitedHosts, ['one.example', 'two.example'])
  assert.equal(document.finalUrl, 'https://two.example/final')
})

test('safe public fetch blocks a public redirect outside the approved domains before contact', async () => {
  const requestedHosts: string[] = []

  await assert.rejects(() => fetchPublicDocument('https://news.example/article', {
    timeoutMs: 1_000,
    allowedDomains: ['news.example'],
    resolveHost: async () => ['93.184.216.34'],
    requestImpl: async (url) => {
      requestedHosts.push(url.hostname)
      return url.hostname === 'news.example'
        ? { status: 302, contentType: null, body: Buffer.alloc(0), redirectUrl: 'https://tracker.example/final' }
        : { status: 200, contentType: 'text/html', body: Buffer.from('should not be contacted'), redirectUrl: null }
    },
  }), /outside the approved domain policy/)

  assert.deepEqual(requestedHosts, ['news.example'])
})

test('PANews source policy admits its known migration without admitting arbitrary redirects', () => {
  assert.deepEqual(approvedArticleDomains('https://www.panewslab.com/en/articles/one'), ['www.panewslab.com', 'panews.io'])
  assert.deepEqual(approvedArticleDomains('https://news.example/article'), ['news.example'])
  assert.deepEqual(approvedArticleDomains('https://panewslab.com.attacker.example/article'), ['panewslab.com.attacker.example'])
})

test('a retained PANews plan accepts the reviewed alias but cannot approve an unlisted starting host', async () => {
  const contacts: string[] = []
  const options = {
    timeoutMs: 1_000, allowedDomains: ['www.panewslab.com'],
    resolveHost: async () => ['93.184.216.34'],
    requestImpl: async (url: URL) => {
      contacts.push(url.hostname)
      return url.hostname === 'www.panewslab.com'
        ? { status: 302, contentType: null, body: Buffer.alloc(0), redirectUrl: 'https://panews.io/en/articles/one' }
        : { status: 200, contentType: 'text/plain', body: Buffer.from('Article'), redirectUrl: null }
    },
  }
  const result = await fetchPublicDocument('https://www.panewslab.com/en/articles/one', options)
  assert.equal(result.finalUrl, 'https://panews.io/en/articles/one')
  assert.deepEqual(contacts, ['www.panewslab.com', 'panews.io'])
  contacts.length = 0
  await assert.rejects(fetchPublicDocument('https://panews.io/en/articles/one', options), /outside the approved/)
  assert.deepEqual(contacts, [])
})

test('safe fetch prefers public IPv4 and fails over without contacting a private address', async () => {
  const contacts: string[] = []
  const result = await fetchPublicDocument('https://news.example/article', {
    timeoutMs: 1_000,
    resolveHost: async () => ['2606:4700:4700::1111', '93.184.216.34', '1.1.1.1'],
    requestImpl: async (_url, address) => {
      contacts.push(address)
      if (address === '93.184.216.34') throw Object.assign(new Error('connection unavailable'), { code: 'ENETUNREACH' })
      return { status: 200, contentType: 'text/plain', body: Buffer.from('Captured article'), redirectUrl: null }
    },
  })
  assert.equal(result.body.toString(), 'Captured article')
  assert.deepEqual(contacts, ['93.184.216.34', '1.1.1.1'])
  await assert.rejects(fetchPublicDocument('https://news.example/article', {
    timeoutMs: 1_000, resolveHost: async () => ['93.184.216.34', '127.0.0.1'],
    requestImpl: async () => { throw new Error('must never contact any address') },
  }), /non-public/)
})

test('DNS and stalled response share a hard retrieval deadline', async () => {
  for (const dnsStalls of [true, false]) {
    const start = Date.now()
    await assert.rejects(fetchPublicDocument('https://news.example/article', {
      timeoutMs: 30,
      resolveHost: async () => dnsStalls ? new Promise<string[]>(() => {}) : ['93.184.216.34'],
      requestImpl: async () => new Promise<SafePublicHopResponse>(() => {}),
    }), /timed out/)
    assert.ok(Date.now() - start < 500)
  }
})
