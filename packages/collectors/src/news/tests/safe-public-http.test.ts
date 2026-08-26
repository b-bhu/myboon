import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchPublicDocument, type SafePublicHopResponse } from '../safe-public-http'

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
