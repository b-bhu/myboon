import assert from 'node:assert/strict'
import test from 'node:test'
import { JevSystemOneAdapter } from './classification-adapters'

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
