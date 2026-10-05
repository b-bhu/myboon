import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { JevClassificationAdapter, HermesClassificationAdapter } from '../../inference-gateway/classification-types'
import { RESEARCH_EVALUATION_FIXTURES } from './fixtures'
import { runLiveResearchEvaluation, type LiveResearchEvaluationOptions } from './live-evaluation'

function fixtureRun(t: { after(callback: () => void): void }, jev: JevClassificationAdapter): LiveResearchEvaluationOptions {
  const directory = mkdtempSync(join(tmpdir(), 'myboon-research-live-harness-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const hermes: HermesClassificationAdapter = { classify: async () => { throw new Error('Hermes must never be a replacement') } }
  return { directory, runId: 'reviewed-test-run', fixtures: [RESEARCH_EVALUATION_FIXTURES[0]],
    providers: ['jev'], maxProviderCalls: 1, maxInputTokens: 10_000, maxOutputTokens: 1_000,
    deadlineMs: 1_000, env: {}, adapters: { jev, hermes } }
}
const alreadyKnown: JevClassificationAdapter = { classify: async (request) => ({ actualProvider: request.target.provider,
  actualModel: request.target.model, answers: { novelty: { type: 'choice', choice: 'already_known', confidence: 0.99,
    probabilities: { already_known: 0.99, new_information: 0.01, contradicts_prior: 0 } } },
  durationMs: 14, usage: { inputTokens: 30, outputTokens: 10 } }) }

test('live harness saves exact reviewed requests privately and restart reuses saved native-adapter response without spend', async (t) => {
  let calls = 0
  const options = fixtureRun(t, { classify: async (request) => { calls++; return alreadyKnown.classify(request) } })
  const first = await runLiveResearchEvaluation(options)
  assert.equal(first.byProvider.jev.savedResponses, 1)
  assert.equal(first.byProvider.jev.agreements, 1)
  assert.equal(first.byProvider.jev.knownSkipCount, 1)
  assert.equal(first.byProvider.jev.measuredCostUsdMicros, null)
  assert.equal(first.byProvider.jev.unknownCostCount, 1)
  assert.equal(first.byProvider.jev.latencyP50Ms, 14)
  assert.equal(statSync(options.directory).mode & 0o777, 0o700)
  for (const name of readdirSync(options.directory)) assert.equal(statSync(join(options.directory, name)).mode & 0o777, 0o600)
  await runLiveResearchEvaluation(options)
  assert.equal(calls, 1)
  const request = JSON.parse(readFileSync(join(options.directory, readdirSync(options.directory).find((name) => name.endsWith('.request.json'))!), 'utf8'))
  assert.equal(request.request.target.model, 'jev-1.13.0')
  assert.equal(request.requestDigest.length, 64)
})

test('live harness retains unknown paid outcome and never calls either adapter again on restart', async (t) => {
  let calls = 0
  const options = fixtureRun(t, { classify: async () => { calls++; throw new Error('Response lost after dispatch') } })
  const first = await runLiveResearchEvaluation(options)
  assert.equal(first.byProvider.jev.unknownOutcomes, 1)
  assert.equal(first.byProvider.jev.savedResponses, 0)
  assert.equal(first.byProvider.jev.unknownInputTokenCount, 1)
  assert.equal(first.byProvider.jev.unknownProviderCallCount, 1)
  await runLiveResearchEvaluation(options)
  assert.equal(calls, 1)
})

test('live harness cannot change reviewed state/limits behind saved dispatch identities', async (t) => {
  const options = fixtureRun(t, alreadyKnown)
  await runLiveResearchEvaluation(options)
  await assert.rejects(() => runLiveResearchEvaluation({ ...options, maxProviderCalls: 2 }), /receipt changed/)
  await assert.rejects(() => runLiveResearchEvaluation({ ...options,
    fixtures: [{ ...options.fixtures[0], label: 'new_information' }] }), /receipt changed/)
})

test('all admission contracts validate before first paid call; explicit caps cannot mint another allowance', async (t) => {
  let calls = 0
  const options = fixtureRun(t, { classify: async (request) => { calls++; return alreadyKnown.classify(request) } })
  const invalid = { ...RESEARCH_EVALUATION_FIXTURES[1], state: { ...RESEARCH_EVALUATION_FIXTURES[1].state,
    signal: { ...RESEARCH_EVALUATION_FIXTURES[1].state.signal, sourceMaterial: 'x'.repeat(12_001) } } }
  await assert.rejects(() => runLiveResearchEvaluation({ ...options, fixtures: [options.fixtures[0], invalid] }), /state contract/)
  assert.equal(calls, 0)
  await assert.rejects(() => runLiveResearchEvaluation({ ...options, fixtures: RESEARCH_EVALUATION_FIXTURES.slice(0, 2) }), /aggregate/)
  assert.equal(calls, 1)
})

test('high-confidence false known stays measurable while incomplete source forces conservative disposition', async (t) => {
  const options = { ...fixtureRun(t, alreadyKnown), fixtures: [RESEARCH_EVALUATION_FIXTURES.find((fixture) => fixture.id === 'news-title-only')!] }
  const summary = await runLiveResearchEvaluation(options)
  assert.equal(summary.byProvider.jev.rawFalseKnown, 1)
  assert.equal(summary.byProvider.jev.guardedFalseKnown, 0)
  assert.equal(summary.byProvider.jev.knownSkipCount, 0)
  assert.equal(summary.byProvider.jev.paidFollowupInvestigations, 0)
  const row = JSON.parse(readFileSync(join(options.directory, readdirSync(options.directory).find((name) => name.endsWith('.dispatch.json'))!), 'utf8'))
  assert.equal(row.guardedDisposition, 'proceed_conservatively')
})

test('native route mismatches and invalid token/cost measurements remain held without shrinking aggregate exposure', async (t) => {
  for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const options = fixtureRun(t, { classify: async (request) => ({ ...await alreadyKnown.classify(request),
      usage: { inputTokens: value, outputTokens: 10 } }) })
    const result = await runLiveResearchEvaluation(options)
    assert.equal(result.byProvider.jev.unknownOutcomes, 1)
    assert.equal(result.byProvider.jev.acceptedCount, 0)
    assert.equal(result.byProvider.jev.unknownInputTokenCount, 1)
  }
  const options = fixtureRun(t, { classify: async (request) => ({ ...await alreadyKnown.classify(request), actualModel: 'unapproved-latest' }) })
  assert.equal((await runLiveResearchEvaluation(options)).byProvider.jev.unknownOutcomes, 1)
})

test('approved Luna evaluation binds production route/profile to immutable receipts and refuses unapproved models before dispatch', async (t) => {
  let calls = 0
  const options = fixtureRun(t, alreadyKnown)
  const hermes: HermesClassificationAdapter = { classify: async (request) => {
    calls++
    assert.deepEqual(request.target, { provider: 'openai-codex', model: 'gpt-5.6-luna' })
    return { actualProvider: request.target.provider, actualModel: request.target.model,
      value: { verdict: 'already_known', reason: 'The supplied complete assertion is present.' },
      usage: { inputTokens: 100, outputTokens: 15 }, durationMs: 25 }
  } }
  const luna: LiveResearchEvaluationOptions = { ...options, providers: ['hermes'], hermesProviderCallCeiling: 1,
    env: { INFERENCE_GATEWAY_PRIMARY_PROVIDER: 'openai-codex', INFERENCE_GATEWAY_PRIMARY_MODEL: 'gpt-5.6-luna',
      INFERENCE_GATEWAY_HERMES_PROFILE: 'myboonv4codex20261003' }, adapters: { jev: alreadyKnown, hermes } }
  const result = await runLiveResearchEvaluation(luna)
  assert.equal(result.byProvider.hermes.savedResponses, 1)
  assert.equal(result.byProvider.hermes.knownSkipCount, 1)
  const receipt = JSON.parse(readFileSync(join(luna.directory, 'run-receipt.json'), 'utf8'))
  assert.deepEqual(receipt.hermesTarget, { provider: 'openai-codex', model: 'gpt-5.6-luna' })
  assert.equal(receipt.hermesProfile, 'myboonv4codex20261003')
  assert.equal(receipt.hermesProviderCallCeiling, 1)
  assert.equal(receipt.evaluationOnlyHermesRoute, undefined, 'Luna is now the approved production route')
  await runLiveResearchEvaluation(luna)
  assert.equal(calls, 1)
  await assert.rejects(() => runLiveResearchEvaluation({ ...luna, env: { ...luna.env,
    INFERENCE_GATEWAY_HERMES_PROFILE: 'different-profile' } }), /receipt changed/)
  await assert.rejects(() => runLiveResearchEvaluation({ ...luna, env: { ...luna.env,
    INFERENCE_GATEWAY_PRIMARY_MODEL: 'gpt-unapproved' } }), /route is not approved/)
  assert.equal(calls, 1)
})
