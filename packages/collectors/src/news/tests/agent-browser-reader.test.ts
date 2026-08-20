import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentBrowserReader } from '../agent-browser-reader'

const publicResolver = async () => ['93.184.216.34']

test('AgentBrowserReader performs a bounded HTTP-only read and returns content', async () => {
  const calls: Array<{ command: string, args: string[] }> = []
  const reader = new AgentBrowserReader({
    command: 'agent-browser-test',
    timeoutMs: 1234,
    maxOutputChars: 4321,
    minContentChars: 10,
    resolveHost: publicResolver,
    execFileImpl: async (command, args) => {
      calls.push({ command, args })
      return {
        stdout: JSON.stringify({
          success: true,
          data: {
            content: 'A sufficiently detailed article body.',
            finalUrl: 'https://news.example/article',
            contentType: 'text/html',
            source: 'html-fallback',
            status: 200,
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
  assert.match(result.content, /article body/)
  assert.equal(calls[0].command, 'agent-browser-test')
  assert.deepEqual(calls[0].args, [
    '--json', '--content-boundaries', '--max-output', '4321',
    'read', 'https://news.example/article', '--timeout', '1234',
  ])
})

test('AgentBrowserReader rejects private destinations before execution', async () => {
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

test('AgentBrowserReader rejects short content or an unexpected browser launch', async () => {
  for (const data of [
    { content: 'short', lifecycle: { launched: false } },
    { content: 'A long enough document for this test.', lifecycle: { launched: true } },
  ]) {
    const reader = new AgentBrowserReader({
      command: 'agent-browser-test',
      minContentChars: 20,
      resolveHost: publicResolver,
      execFileImpl: async () => ({
        stdout: JSON.stringify({ success: true, data }),
        stderr: '',
      }),
    })
    const result = await reader.read('https://news.example/article')
    assert.equal(result.status, 'failed')
  }
})

test('AgentBrowserReader fails closed when a redirect resolves to a private destination', async () => {
  let resolution = 0
  const reader = new AgentBrowserReader({
    command: 'agent-browser-test',
    minContentChars: 10,
    resolveHost: async () => (++resolution === 1 ? ['93.184.216.34'] : ['127.0.0.1']),
    execFileImpl: async () => ({
      stdout: JSON.stringify({
        success: true,
        data: {
          content: 'A sufficiently detailed response body.',
          finalUrl: 'http://redirect.example/private',
          lifecycle: { launched: false },
        },
      }),
      stderr: '',
    }),
  })

  const result = await reader.read('https://news.example/article')

  assert.equal(result.status, 'failed')
  assert.equal(result.fallbackAllowed, false)
  assert.match(result.error ?? '', /Unsafe final article URL/)
})

test('AgentBrowserReader classifies command timeouts', async () => {
  const reader = new AgentBrowserReader({
    command: 'agent-browser-test',
    resolveHost: publicResolver,
    execFileImpl: async () => {
      throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' })
    },
  })

  const result = await reader.read('https://news.example/article')

  assert.equal(result.status, 'timed_out')
  assert.equal(result.fallbackAllowed, true)
  assert.match(result.error ?? '', /timed out/)
})
