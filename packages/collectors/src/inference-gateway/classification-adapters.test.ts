import assert from 'node:assert/strict'
import test from 'node:test'
import { HermesDecisionAdapter, JevSystemOneAdapter } from './classification-adapters'
import { HermesStructuredAdapter } from './hermes-adapter'
import { HermesService } from '../hermes'
import { InferenceGatewayError } from './errors'

test('real Hermes CLI composition disables all tools and ambient rules for both semantic adapters', async () => {
  const calls: string[][] = []
  const service = new HermesService({
    limiter: { async acquire() { return { release() {} } } },
    async execFileImpl(_command, args) {
      calls.push(args)
      return { stdout: '{"verdict":"new_information","reason":"Captured source supplies a new fact."}', stderr: '' }
    },
  })
  const target = { provider: 'ollama-cloud', model: 'deepseek-v4.1-flash' }
  const signal = new AbortController().signal
  await new HermesDecisionAdapter({ service }).classify({
    workload: 'research.novelty', decisionVersion: 'v1', prompt: 'Bounded classification', target, signal, deadlineMs: 1000,
  })
  await new HermesStructuredAdapter({ service }).generate({
    mode: 'generateStructured', workload: 'research.synthesis', purpose: 'research.synthesis',
    prompt: 'Bounded synthesis', target, signal, timeoutMs: 1000,
  })
  assert.equal(calls.length, 2)
  for (const args of calls) {
    assert.equal(args[args.indexOf('-t') + 1], 'context_engine')
    assert.ok(args.includes('--ignore-rules'))
    assert.ok(args.includes('-z'))
    assert.ok(!args.includes('chat'))
  }
})

test('Jev adapter preserves native Choice and Noul semantics and passes AbortSignal', async () => {
  let body: Record<string, unknown> | null = null
  let signal: AbortSignal | null = null
  const adapter = new JevSystemOneAdapter({
    apiToken: 'secret',
    fetchImpl: (async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      signal = init?.signal as AbortSignal
      return {
        ok: true, status: 200,
        async json() { return {
          model: 'jev-1.13.0',
          answers: {
            route: { type: 'choice', choice: 'keep', confidence: 0.9, probabilities: { keep: 0.9, drop: 0.1 } },
            relevant: { type: 'noul', noul: 0.72 },
            urgency: {
              type: 'score', score: 1.4, confidence: 0.4,
              legend: { 0: 'low', 1: 'medium', 2: 'high' },
              probabilities: { 0: 0, 1: 0.6, 2: 0.4 },
            },
          },
          usage: { input_tokens: 10, output_tokens: 3 },
        } },
      } as Response
    }) as typeof fetch,
  })
  const controller = new AbortController()
  const result = await adapter.classify({
    workload: 'test', decisionVersion: 'v1', state: { subject: 'SEC' },
    questions: {
      route: { type: 'choice', instructions: 'x', criteria: { keep: 'x', drop: 'y' } },
      relevant: { type: 'noul', instructions: 'x' },
      urgency: { type: 'score', instructions: 'x', criteria: ['low', 'medium', 'high'] },
    },
    target: { provider: 'typesafe', model: 'jev-1.13.0' },
    deadlineMs: 1_000, signal: controller.signal,
  })
  assert.equal(signal, controller.signal)
  assert.deepEqual(result.answers.relevant, { type: 'noul', noul: 0.72 })
  assert.equal('confidence' in result.answers.relevant!, false)
  assert.deepEqual(result.answers.urgency, {
    type: 'score', score: 1.4, confidence: 0.4,
    legend: { 0: 'low', 1: 'medium', 2: 'high' },
    probabilities: { 0: 0, 1: 0.6, 2: 0.4 },
  })
  const sent = body as unknown as Record<string, unknown>
  assert.equal(sent.model, 'jev-1.13.0')
  assert.doesNotMatch(JSON.stringify(sent), /secret/)
})

test('both Hermes adapters report the native Codex backup and measured token usage', async () => {
  const service = { async oneshot() {
    return { stdout: '{"ok":true}', stderr: '', usage: {
      provider: 'openai-codex', model: 'gpt-5.6-luna', inputTokens: 12, outputTokens: 4, apiCalls: 1,
    } }
  } }
  const target = { provider: 'ollama-cloud', model: 'glm-5.3-flash' }
  const structured = await new HermesStructuredAdapter({ service }).generate({
    mode: 'generateStructured', workload: 'test', purpose: 'test.backup', prompt: 'P', target,
    timeoutMs: 1000, signal: new AbortController().signal,
  })
  const decision = await new HermesDecisionAdapter({ service }).classify({
    workload: 'test', decisionVersion: 'v1', prompt: 'P', target, deadlineMs: 1000,
    signal: new AbortController().signal,
  })
  for (const result of [structured, decision]) {
    assert.equal(result.actualProvider, 'openai-codex')
    assert.equal(result.actualModel, 'gpt-5.6-luna')
    assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 4 })
  }
  assert.equal(structured.fallbackInvoked, true)
})

test('Jev adapter rejects wrong-model and incomplete answer envelopes', async () => {
  const adapter = new JevSystemOneAdapter({
    apiToken: 'secret',
    fetchImpl: (async () => ({
      ok: true, status: 200,
      async json() { return { model: 'jev-latest', answers: {}, usage: { input_tokens: 1, output_tokens: 1 } } },
    })) as unknown as typeof fetch,
  })
  await assert.rejects(adapter.classify({
    workload: 'test', decisionVersion: 'v1', state: {},
    questions: { relevant: { type: 'noul', instructions: 'x' } },
    target: { provider: 'typesafe', model: 'jev-1.13.0' },
    deadlineMs: 1_000, signal: new AbortController().signal,
  }), /wrong model/)
})

test('Jev adapter rejects unsafe native token and monetary usage before settlement', async () => {
  for (const field of ['input_tokens', 'output_tokens', 'cost_usd_micros']) {
    const adapter = new JevSystemOneAdapter({ apiToken: 'secret',
      fetchImpl: (async () => ({ ok: true, status: 200, async json() { return {
        model: 'jev-1.13.0', answers: { relevant: { type: 'noul', noul: 0.72 } },
        usage: { input_tokens: 1, output_tokens: 1, cost_usd_micros: 1, [field]: Number.MAX_SAFE_INTEGER + 1 },
      } } })) as unknown as typeof fetch,
    })
    await assert.rejects(adapter.classify({ workload: 'test', decisionVersion: 'v1', state: {},
      questions: { relevant: { type: 'noul', instructions: 'x' } }, target: { provider: 'typesafe', model: 'jev-1.13.0' },
      deadlineMs: 1_000, signal: new AbortController().signal,
    }), /non-negative safe integer/)
  }
})

test('Jev retry headers remain available to live callers', async () => {
  const request = {
    workload: 'test', decisionVersion: 'v1', state: {},
    questions: { relevant: { type: 'noul' as const, instructions: 'x' } },
    target: { provider: 'typesafe', model: 'jev-1.13.0' },
    deadlineMs: 1_000, signal: new AbortController().signal,
  }
  const failureFor = async (retryAfter: string): Promise<InferenceGatewayError> => {
    const adapter = new JevSystemOneAdapter({
      apiToken: 'secret',
      fetchImpl: (async () => new Response('{}', {
        status: 429,
        headers: { 'Retry-After': retryAfter },
      })) as typeof fetch,
    })
    try {
      await adapter.classify(request)
      throw new Error('Expected Jev 429 failure')
    } catch (error) {
      assert.ok(error instanceof InferenceGatewayError)
      return error
    }
  }

  const delta = await failureFor('45')
  assert.equal(delta.retryAfterMs, 45_000)

  const date = await failureFor(new Date(Date.now() + 60_000).toUTCString())
  assert.ok((date.retryAfterMs ?? 0) >= 58_000 && (date.retryAfterMs ?? 0) <= 60_000)
  const bounded = await failureFor('999999999999999999999999')
  assert.equal(bounded.retryAfterMs, 24 * 60 * 60_000)
})
