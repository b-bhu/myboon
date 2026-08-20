import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentBrowserReader } from '../agent-browser-reader'
import type { SafePublicDocument } from '../safe-public-http'

function publicDocument(overrides: Partial<SafePublicDocument> = {}): SafePublicDocument {
  return {
    body: Buffer.from('<h1>A sufficiently detailed article body for testing.</h1>'),
    finalUrl: 'https://news.example/article',
    contentType: 'text/html',
    status: 200,
    visitedHosts: ['news.example'],
    ...overrides,
  }
}

test('AgentBrowserReader gives only loopback content to agent-browser and returns external provenance', async () => {
  const calls: Array<{ command: string, args: string[] }> = []
  const reader = new AgentBrowserReader({
    command: 'agent-browser-test',
    timeoutMs: 1234,
    maxOutputChars: 4321,
    minContentChars: 10,
    fetchDocumentImpl: async () => publicDocument(),
    execFileImpl: async (command, args) => {
      calls.push({ command, args })
      return {
        stdout: JSON.stringify({
          success: true,
          data: {
            content: 'A sufficiently detailed article body.',
            source: 'html-fallback',
            truncated: false,
            lifecycle: { launched: false },
          },
          error: null,
        }),
        stderr: '',
      }
    },
  })

  const result = await reader.read('https://news.example/article')

  assert.equal(result.status, 'succeeded')
  assert.equal(result.browserLaunched, false)
  assert.equal(result.finalUrl, 'https://news.example/article')
  assert.deepEqual(result.allowedFallbackDomains, ['news.example'])
  assert.equal(calls[0].command, 'agent-browser-test')
  assert.deepEqual(calls[0].args.slice(0, 5), [
    '--json', '--content-boundaries', '--max-output', '4321', 'read',
  ])
  assert.match(calls[0].args[5], /^http:\/\/127\.0\.0\.1:\d+\/document\//)
  assert.deepEqual(calls[0].args.slice(6), ['--timeout', '1234'])
  assert.equal(calls[0].args.some((arg) => arg.includes('news.example')), false)
})

test('AgentBrowserReader rejects private destinations before agent-browser execution', async () => {
  let executed = false
  const reader = new AgentBrowserReader({
    command: 'agent-browser-test',
    execFileImpl: async () => {
      executed = true
      return { stdout: '', stderr: '' }
    },
  })

  const result = await reader.read('http://127.0.0.1/admin')

  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /non-public/)
  assert.equal(result.fallbackAllowed, false)
  assert.equal(executed, false)
})

test('AgentBrowserReader allows contained fallback after safe fetch but rejects short content or browser launch', async () => {
  for (const data of [
    { content: 'short', lifecycle: { launched: false } },
    { content: 'A long enough document for this test.', lifecycle: { launched: true } },
  ]) {
    const reader = new AgentBrowserReader({
      command: 'agent-browser-test',
      minContentChars: 20,
      fetchDocumentImpl: async () => publicDocument(),
      execFileImpl: async () => ({
        stdout: JSON.stringify({ success: true, data }),
        stderr: '',
      }),
    })
    const result = await reader.read('https://news.example/article')
    assert.equal(result.status, 'failed')
    assert.equal(result.fallbackAllowed, true)
    assert.deepEqual(result.allowedFallbackDomains, ['news.example'])
  }
})

test('AgentBrowserReader classifies local conversion timeouts after a safe fetch', async () => {
  const reader = new AgentBrowserReader({
    command: 'agent-browser-test',
    fetchDocumentImpl: async () => publicDocument(),
    execFileImpl: async () => {
      throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' })
    },
  })

  const result = await reader.read('https://news.example/article')

  assert.equal(result.status, 'timed_out')
  assert.equal(result.fallbackAllowed, true)
  assert.deepEqual(result.allowedFallbackDomains, ['news.example'])
  assert.match(result.error ?? '', /timed out/)
})
