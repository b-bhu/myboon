import assert from 'node:assert/strict'
import test from 'node:test'
import { ClassificationDoubleFailureError, ClassificationGateway, InMemoryClassificationPorts } from './classification-gateway'
import { StaticClassificationRegistry } from './classification-registry'
import { InferenceGatewayError } from './errors'
import type {
  ClassificationDefinition,
  HermesClassificationAdapter,
  HermesClassificationCall,
  JevClassificationAdapter,
  JevClassificationCall,
} from './classification-types'

interface State { subject: string }
interface Decision { label: 'keep' | 'drop' }

function definition(mode: ClassificationDefinition['maximumLifecycleMode'] = 'active'): ClassificationDefinition<State, Decision> {
  return {
    workload: 'test.decision', decisionVersion: 'test.decision.v1',
    maximumLifecycleMode: mode, defaultLifecycleMode: mode, shadowPercent: 100, canaryPercent: 100,
    jevTarget: { provider: 'typesafe', model: 'jev-1.13.0' },
    hermesTarget: { provider: 'ollama-cloud', model: 'glm-5.3-flash' },
    budget: { deadlineMs: 1_000, maxStateBytes: 1_000, maxInputTokens: 100, maxOutputTokens: 100 },
    capacity: {
      liveConcurrency: 2, shadowConcurrency: 1, maxCalls: 20, windowMs: 1_000,
      circuitFailureThreshold: 3, circuitCooldownMs: 1_000, leaseMs: 1_000,
    },
    validateState(value) {
      return !!value && typeof value === 'object' && typeof (value as State).subject === 'string'
        ? { valid: true, value: value as State } : { valid: false, issues: ['subject required'] }
    },
    questions: () => ({ label: {
      type: 'choice', instructions: 'classify', criteria: { keep: 'keep', drop: 'drop' },
    } }),
    decodeJev(answers) {
      const answer = answers.label
      return answer?.type === 'choice' && (answer.choice === 'keep' || answer.choice === 'drop')
        ? { valid: true, value: { label: answer.choice } }
        : { valid: false, issues: ['invalid label'] }
    },
    acceptJev(answers) {
      const answer = answers.label
      return answer?.type === 'choice' && answer.confidence >= 0.8
        ? { accepted: true, reason: 'accepted' } : { accepted: false, reason: 'low confidence' }
    },
    renderHermes: (state) => `Classify ${state.subject}`,
    validateHermes(value) {
      return !!value && typeof value === 'object' && ['keep', 'drop'].includes(String((value as Decision).label))
        ? { valid: true, value: value as Decision } : { valid: false, issues: ['invalid Hermes label'] }
    },
  }
}

function jevAnswer(confidence = 0.95) {
  return {
    actualProvider: 'typesafe', actualModel: 'jev-1.13.0', durationMs: 5,
    usage: { inputTokens: 5, outputTokens: 2 },
    answers: { label: { type: 'choice' as const, choice: 'keep', confidence, probabilities: { keep: confidence, drop: 1 - confidence } } },
  }
}

function request() {
  return {
    workload: 'test.decision', decisionVersion: 'test.decision.v1', state: { subject: 'SEC' },
    trace: { stableDecisionKey: 'signal-1', correlationIds: { signalId: 'signal-1' } },
  }
}

function gateway(input: {
  mode?: ClassificationDefinition['maximumLifecycleMode']
  jev?: JevClassificationAdapter
  hermes?: HermesClassificationAdapter
}) {
  const ports = new InMemoryClassificationPorts()
  let jevCalls = 0
  let hermesCalls = 0
  const instance = new ClassificationGateway({
    registry: new StaticClassificationRegistry([definition(input.mode)]),
    jev: input.jev ?? { async classify() { jevCalls += 1; return jevAnswer() } },
    hermes: input.hermes ?? { async classify(call) {
      hermesCalls += 1
      return { actualProvider: call.target.provider, actualModel: call.target.model, value: { label: 'drop' },
        durationMs: 10, usage: { inputTokens: 5, outputTokens: 2 } }
    } },
    capacity: ports, audit: ports, shadowOutbox: ports,
  })
  return { instance, ports, calls: () => ({ jevCalls, hermesCalls }) }
}

test('accepted Jev decision is authoritative and does not call Hermes', async () => {
  const setup = gateway({})
  const result = await setup.instance.classify<Decision>(request())
  assert.deepEqual(result.value, { label: 'keep' })
  assert.equal(result.actualProvider, 'typesafe')
  assert.deepEqual(setup.calls(), { jevCalls: 1, hermesCalls: 0 })
  assert.equal(setup.ports.attempts[0]?.calls.length, 1)
})

test('not-accepted Jev answer falls back with the complete Hermes definition and no repair', async () => {
  let jevCalls = 0
  let hermesCalls = 0
  const setup = gateway({
    jev: { async classify() { jevCalls += 1; return jevAnswer(0.6) } },
    hermes: { async classify(call: HermesClassificationCall) {
      hermesCalls += 1
      assert.equal(call.prompt, 'Classify SEC')
      return { actualProvider: call.target.provider, actualModel: call.target.model,
        value: { label: 'drop' }, durationMs: 7, usage: { inputTokens: 2, outputTokens: 1 } }
    } },
  })
  const result = await setup.instance.classify<Decision>(request())
  assert.deepEqual(result.value, { label: 'drop' })
  assert.equal(result.fallbackUsed, true)
  assert.equal(jevCalls, 1)
  assert.equal(hermesCalls, 1)
  assert.deepEqual(setup.ports.attempts[0]?.calls.map((item) => item.status), ['not_accepted', 'succeeded'])
})

test('invalid Jev output goes directly to Hermes and double failure carries decisionId', async () => {
  const setup = gateway({
    jev: { async classify(_call: JevClassificationCall) {
      throw new InferenceGatewayError('invalid', { category: 'invalid_structured_output', retryable: false })
    } },
    hermes: { async classify() {
      throw new InferenceGatewayError('down', { category: 'provider_unavailable', retryable: true })
    } },
  })
  await assert.rejects(setup.instance.classify(request()), (error: unknown) => {
    assert.ok(error instanceof ClassificationDoubleFailureError)
    assert.match(error.decisionId, /^classification_/)
    assert.equal(error.jevFailure, 'invalid_structured_output')
    return true
  })
  assert.equal(setup.ports.attempts[0]?.status, 'failed')
  assert.equal(setup.ports.attempts[0]?.calls.length, 2)
})

test('shadow mode returns Hermes immediately and only enqueues immutable Jev work', async () => {
  const setup = gateway({ mode: 'shadow' })
  const result = await setup.instance.classify<Decision>(request())
  assert.deepEqual(result.value, { label: 'drop' })
  assert.deepEqual(setup.calls(), { jevCalls: 0, hermesCalls: 1 })
  assert.equal(setup.ports.shadows.length, 1)
  assert.equal(setup.ports.shadows[0]?.decisionId, result.decisionId)
  assert.deepEqual(setup.ports.shadows[0]?.state, { subject: 'SEC' })
})

test('caller cannot inject questions, schema, confidence policy, or budget', async () => {
  const setup = gateway({})
  await assert.rejects(setup.instance.classify({ ...request(), questions: {} } as never), /caller-owned policy fields/)
  await assert.rejects(setup.instance.classify({ ...request(), budget: {} } as never), /caller-owned policy fields/)
  assert.deepEqual(setup.calls(), { jevCalls: 0, hermesCalls: 0 })
})

test('consumer policy outcome is a second linked record', async () => {
  const setup = gateway({})
  const result = await setup.instance.classify(request())
  await setup.instance.recordPolicyOutcome({
    decisionId: result.decisionId, consumer: 'test-consumer', policyVersion: 'policy.v1',
    outcome: 'held', reasonCode: 'known',
  })
  assert.equal(setup.ports.outcomes[0]?.decisionId, result.decisionId)
  assert.equal(setup.ports.outcomes[0]?.outcome, 'held')
})
