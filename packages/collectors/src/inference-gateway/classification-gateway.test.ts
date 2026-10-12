import assert from 'node:assert/strict'
import test from 'node:test'
import { ClassificationDoubleFailureError, ClassificationOutcomeUnknownError, ClassificationGateway, InMemoryClassificationPorts } from './classification-gateway'
import { StaticClassificationRegistry } from './classification-registry'
import { InferenceGatewayError } from './errors'
import type {
  ClassificationAttemptRecord,
  ClassificationAuditSink,
  ClassificationCapacityCoordinator,
  ClassificationCapacityPolicy,
  ClassificationDefinition,
  ClassificationLease,
  ClassificationPolicyOutcomeRecord,
  HermesClassificationAdapter,
  HermesClassificationCall,
  JevClassificationAdapter,
  JevClassificationCall,
} from './classification-types'
import type { InferenceProviderTarget } from './types'

interface State { subject: string }
interface Decision { label: 'keep' | 'drop' }

function definition(mode: ClassificationDefinition['maximumLifecycleMode'] = 'active'): ClassificationDefinition<State, Decision> {
  return {
    workload: 'test.decision', decisionVersion: 'test.decision.v1',
    maximumLifecycleMode: mode, defaultLifecycleMode: mode, canaryPercent: 100,
    jevTarget: { provider: 'typesafe', model: 'jev-1.13.0' },
    hermesTarget: { provider: 'ollama-cloud', model: 'glm-5.3-flash' },
    budget: { deadlineMs: 1_000, maxStateBytes: 1_000, maxInputTokens: 100, maxOutputTokens: 100 },
    capacity: {
      liveConcurrency: 2, providerMaxCalls: 40, workloadMaxCalls: 20, windowMs: 1_000,
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
    capacity: ports, audit: ports,
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

test('a received but rejected Jev answer is marked as a provider response under one-call policy', async () => {
  const setup = gateway({ jev: { async classify() { return jevAnswer(0.6) } } })
  await assert.rejects(setup.instance.classify({ ...request(), maxProviderCalls: 1 }), (error: unknown) => {
    assert.ok(error instanceof InferenceGatewayError)
    assert.equal(error.category, 'budget_exceeded')
    assert.equal(error.providerResponseReceived, true)
    return true
  })
  assert.equal(setup.ports.attempts[0]?.calls[0]?.status, 'not_accepted')
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

test('one reserved classification call accepts Jev without fallback spend', async () => {
  const setup = gateway({})
  const result = await setup.instance.classify<Decision>({ ...request(), maxProviderCalls: 1, holdOnUnknownOutcome: true })
  assert.deepEqual(result.value, { label: 'keep' })
  assert.deepEqual(setup.calls(), { jevCalls: 1, hermesCalls: 0 })
  assert.equal(setup.ports.attempts[0]?.calls.length, 1)
})

test('a low-confidence Jev answer cannot buy Hermes under a one-call reservation', async () => {
  let jevCalls = 0
  const setup = gateway({ jev: { async classify() { jevCalls += 1; return jevAnswer(0.6) } } })
  await assert.rejects(setup.instance.classify({ ...request(), maxProviderCalls: 1 }), (error: unknown) => {
    assert.ok(error instanceof InferenceGatewayError)
    assert.equal(error.category, 'budget_exceeded')
    assert.equal(error.retryable, false)
    return true
  })
  assert.equal(jevCalls, 1)
  assert.equal(setup.calls().hermesCalls, 0)
  assert.equal(setup.ports.attempts[0]?.status, 'failed')
  assert.equal(setup.ports.attempts[0]?.calls[0]?.status, 'not_accepted')
})

for (const category of ['provider_timeout', 'provider_unavailable'] as const) {
  test(`unknown Jev ${category} cannot dispatch fallback even when two calls fit`, async () => {
    let jevCalls = 0
    const setup = gateway({ jev: { async classify() {
      jevCalls += 1
      throw new InferenceGatewayError('remote outcome unavailable', { category, retryable: true })
    } } })
    await assert.rejects(setup.instance.classify({ ...request(), maxProviderCalls: 2, holdOnUnknownOutcome: true }), (error: unknown) => {
      assert.ok(error instanceof ClassificationOutcomeUnknownError)
      assert.equal(error.retryable, false)
      assert.match(error.decisionId, /^classification_/)
      return true
    })
    assert.equal(jevCalls, 1)
    assert.equal(setup.calls().hermesCalls, 0)
    assert.equal(setup.ports.attempts[0]?.status, 'failed')
    assert.equal(setup.ports.attempts[0]?.calls.length, 1)
    assert.equal(setup.ports.attempts[0]?.fallbackUsed, false)
  })
}

test('a single reserved Jev call receives the full logical deadline', async () => {
  let observedDeadline = 0
  const setup = gateway({ jev: { async classify(call) { observedDeadline = call.deadlineMs; return jevAnswer() } } })
  await setup.instance.classify({ ...request(), maxProviderCalls: 1, tighterDeadlineMs: 800 })
  assert.equal(observedDeadline, 800)
})

test('Jev can use the full deadline when unknown dispatch outcomes forbid replacement', async () => {
  let observedDeadline = 0
  const setup = gateway({ jev: { async classify(call) { observedDeadline = call.deadlineMs; return jevAnswer() } } })
  await setup.instance.classify({ ...request(), maxProviderCalls: 2, holdOnUnknownOutcome: true, tighterDeadlineMs: 800 })
  assert.equal(observedDeadline, 800)
})

test('invalid dispatch tightening fails before reaching any provider', async () => {
  const setup = gateway({})
  await assert.rejects(setup.instance.classify({ ...request(), maxProviderCalls: 4 } as never), /one-, two- or three-provider/)
  await assert.rejects(setup.instance.classify({ ...request(), holdOnUnknownOutcome: 'yes' } as never), /must be boolean/)
  assert.deepEqual(setup.calls(), { jevCalls: 0, hermesCalls: 0 })
})

test('preflight rejects invalid state without reaching any provider', () => {
  const setup = gateway({})
  assert.throws(() => setup.instance.preflight({ ...request(), state: { subject: 42 } }), /subject required/)
  assert.deepEqual(setup.calls(), { jevCalls: 0, hermesCalls: 0 })
})

// Minimal in-memory ports mirroring the SQLite store's circuit semantics:
// retryable failures count toward circuitFailureThreshold, then acquire refuses
// with circuit_open until circuitCooldownMs has passed.
class CircuitTrackingPorts implements ClassificationCapacityCoordinator, ClassificationAuditSink {
  readonly attempts: ClassificationAttemptRecord[] = []
  readonly outcomes: ClassificationPolicyOutcomeRecord[] = []
  private readonly failures = new Map<string, number>()
  private readonly blockedUntilMs = new Map<string, number>()
  constructor(private readonly policy: ClassificationCapacityPolicy, private readonly nowMs: () => number) {}

  acquire(input: {
    workload: string
    target: InferenceProviderTarget
    mode: 'live'
    policy: ClassificationCapacityPolicy
  }): ClassificationLease {
    const key = `${input.target.provider}|${input.target.model}`
    if ((this.blockedUntilMs.get(key) ?? 0) > this.nowMs()) {
      throw new InferenceGatewayError('Classification provider circuit is open', {
        category: 'circuit_open', retryable: true,
        retryAfterMs: Math.max(1, (this.blockedUntilMs.get(key) ?? 0) - this.nowMs()),
        provider: input.target.provider, model: input.target.model,
      })
    }
    return { token: 'test-lease', release: ({ success, retryableFailure }) => {
      if (success || !retryableFailure) this.failures.set(key, 0)
      else {
        const count = (this.failures.get(key) ?? 0) + 1
        if (count >= this.policy.circuitFailureThreshold) this.blockedUntilMs.set(key, this.nowMs() + this.policy.circuitCooldownMs)
        this.failures.set(key, count)
      }
    } }
  }

  trip(definition: ClassificationDefinition): void {
    for (let index = 0; index < definition.capacity.circuitFailureThreshold; index += 1) {
      this.acquire({ workload: definition.workload, target: definition.jevTarget, mode: 'live', policy: definition.capacity })
        .release({ success: false, retryableFailure: true })
    }
  }

  recordAttempt(record: ClassificationAttemptRecord): void { this.attempts.push(record) }
  recordPolicyOutcome(record: ClassificationPolicyOutcomeRecord): void { this.outcomes.push(record) }
}

function billingError(retryAfterMs?: number): InferenceGatewayError {
  return new InferenceGatewayError('Jev classification failed with HTTP 402', {
    category: 'provider_billing', retryable: true,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    provider: 'typesafe', model: 'jev-1.13.0',
  })
}

test('a second billing failure retries Jev once, then falls back to Hermes without spending the reservation', async () => {
  const sleepCalls: number[] = []
  let jevCalls = 0
  let hermesCalls = 0
  const ports = new CircuitTrackingPorts(definition().capacity, () => 0)
  const instance = new ClassificationGateway({
    registry: new StaticClassificationRegistry([definition()]),
    jev: { async classify() {
      jevCalls += 1
      throw billingError()
    } },
    hermes: { async classify(call: HermesClassificationCall) {
      hermesCalls += 1
      return { actualProvider: call.target.provider, actualModel: call.target.model,
        value: { label: 'drop' }, durationMs: 7, usage: { inputTokens: 2, outputTokens: 1 } }
    } },
    capacity: ports, audit: ports,
    now: () => 1_700_000_000_000,
    sleep: async (ms) => { sleepCalls.push(ms) },
  })
  // The explicit three-call envelope (Jev, one 402 retry, Hermes) is what the
  // durable reservation actually covers for fallback versions.
  const result = await instance.classify<Decision>({ ...request(), maxProviderCalls: 3 })
  assert.deepEqual(result.value, { label: 'drop' })
  assert.equal(result.fallbackUsed, true)
  assert.equal(result.fallbackReason, 'provider_billing')
  assert.deepEqual({ jevCalls, hermesCalls }, { jevCalls: 2, hermesCalls: 1 })
  assert.deepEqual(sleepCalls, [1_000])
  const record = ports.attempts[0]
  assert.equal(record?.calls.length, 3)
  assert.deepEqual(record?.calls.map((call) => call.failureCategory), ['provider_billing', 'provider_billing', null])
  // The gateway result exposes the real per-call record so a durable caller
  // can settle every known provider call instead of only the final usage.
  assert.equal(result.calls.length, 3)
  assert.deepEqual(result.calls.map((call) => call.failureCategory), ['provider_billing', 'provider_billing', null])
  const retryUsage = result.calls[2]
  assert.equal(retryUsage?.inputTokens, 2)
  assert.equal(retryUsage?.outputTokens, 1)

  // The force-opened circuit must refuse the next dispatch before any Jev
  // attempt: zero new Jev calls, and the request degrades to the Hermes
  // fallback under category circuit_open.
  const nextAttempts = ports.attempts.length
  const next = await instance.classify<Decision>({ ...request(), maxProviderCalls: 3 })
  assert.equal(next.fallbackUsed, true)
  assert.equal(next.fallbackReason, 'circuit_open')
  assert.equal(ports.attempts.length, nextAttempts + 1)
  assert.deepEqual(ports.attempts[nextAttempts]?.calls.map((call) => call.failureCategory), ['circuit_open', null])
  assert.deepEqual({ jevCalls, hermesCalls }, { jevCalls: 2, hermesCalls: 2 })
})

test('a Jev billing retry that succeeds is authoritative with no fallback spend', async () => {
  let jevCalls = 0
  const ports = new CircuitTrackingPorts(definition().capacity, () => 0)
  const instance = new ClassificationGateway({
    registry: new StaticClassificationRegistry([definition()]),
    jev: { async classify() {
      jevCalls += 1
      if (jevCalls === 1) throw billingError(250)
      return jevAnswer()
    } },
    hermes: { async classify() { throw new Error('Hermes must not be called') } },
    capacity: ports, audit: ports,
    sleep: async () => {},
  })
  // The explicit three-call envelope (Jev, one 402 retry, Hermes) admits the
  // billing retry; a succeeding retry is authoritative with no fallback spend.
  const result = await instance.classify<Decision>({ ...request(), maxProviderCalls: 3 })
  assert.deepEqual(result.value, { label: 'keep' })
  assert.equal(result.fallbackUsed, false)
  assert.equal(jevCalls, 2)
  const record = ports.attempts[0]
  assert.equal(record?.calls.length, 2)
  assert.deepEqual(record?.calls.map((call) => call.status), ['failed', 'succeeded'])
  // The result carries both calls so a durable caller can settle both.
  assert.equal(result.calls.length, 2)
  assert.deepEqual(result.calls.map((call) => call.status), ['failed', 'succeeded'])
})

test('a Retry-After wait that exhausts the deadline skips the retry and falls back', async () => {
  const clock = { now: 1_700_000_000_000 }
  let jevCalls = 0
  let hermesCalls = 0
  const instance = new ClassificationGateway({
    registry: new StaticClassificationRegistry([definition()]),
    jev: { async classify() {
      jevCalls += 1
      throw billingError(60_000)
    } },
    hermes: { async classify(call: HermesClassificationCall) {
      hermesCalls += 1
      return { actualProvider: call.target.provider, actualModel: call.target.model,
        value: { label: 'drop' }, durationMs: 7, usage: { inputTokens: 2, outputTokens: 1 } }
    } },
    capacity: new InMemoryClassificationPorts(), audit: new InMemoryClassificationPorts(),
    now: () => clock.now,
    // Advancing-clock sleep: the Retry-After wait consumes the whole budget.
    sleep: async (ms) => { clock.now += ms },
  })
  await assert.rejects(
    instance.classify<Decision>({ ...request(), maxProviderCalls: 3 }),
    ClassificationDoubleFailureError,
  )
  // The wait consumed the whole budget (Retry-After larger than the deadline):
  // no second Jev attempt and the skip carries the 402 as a known, fallback-
  // eligible rejection — but with zero logical time left even the Hermes
  // fallback cannot run, so the dispatch fails without further spend.
  assert.deepEqual({ jevCalls, hermesCalls }, { jevCalls: 1, hermesCalls: 0 })
})

test('a Retry-After wait that preserves budget retries Jev with the post-wait remainder', async () => {
  const clock = { now: 1_700_000_000_000 }
  const observedDeadlines: number[] = []
  let jevCalls = 0
  const instance = new ClassificationGateway({
    registry: new StaticClassificationRegistry([definition()]),
    jev: { async classify(call) {
      jevCalls += 1
      observedDeadlines.push(call.deadlineMs)
      if (jevCalls === 1) throw billingError(200)
      return jevAnswer()
    } },
    hermes: { async classify() { throw new Error('Hermes must not be called') } },
    capacity: new InMemoryClassificationPorts(), audit: new InMemoryClassificationPorts(),
    now: () => clock.now,
    sleep: async (ms) => { clock.now += ms },
  })
  const result = await instance.classify<Decision>({ ...request(), maxProviderCalls: 3 })
  assert.deepEqual(result.value, { label: 'keep' })
  assert.equal(jevCalls, 2)
  // The wait preserved budget inside the halved primary deadline: the retry
  // runs with the exact post-wait wall-clock remainder (deadline - elapsed).
  assert.equal(observedDeadlines[1], 800)
})

test('Jev authentication failure does not retry and goes straight to Hermes', async () => {
  let jevCalls = 0
  let hermesCalls = 0
  const ports = new CircuitTrackingPorts(definition().capacity, () => 0)
  const instance = new ClassificationGateway({
    registry: new StaticClassificationRegistry([definition()]),
    jev: { async classify() {
      jevCalls += 1
      throw new InferenceGatewayError('Jev classification failed with HTTP 401', {
        category: 'provider_authentication', retryable: false,
        provider: 'typesafe', model: 'jev-1.13.0',
      })
    } },
    hermes: { async classify(call: HermesClassificationCall) {
      hermesCalls += 1
      return { actualProvider: call.target.provider, actualModel: call.target.model,
        value: { label: 'drop' }, durationMs: 7, usage: { inputTokens: 2, outputTokens: 1 } }
    } },
    capacity: ports, audit: ports,
    sleep: async () => { throw new Error('retry sleep must not run') },
  })
  const result = await instance.classify<Decision>(request())
  assert.equal(result.fallbackUsed, true)
  assert.equal(result.fallbackReason, 'provider_authentication')
  assert.deepEqual({ jevCalls, hermesCalls }, { jevCalls: 1, hermesCalls: 1 })
})

test('an already-open Jev circuit skips every Jev attempt and uses Hermes directly', async () => {
  let jevCalls = 0
  let hermesCalls = 0
  const testDefinition = definition()
  const ports = new CircuitTrackingPorts(testDefinition.capacity, () => 0)
  ports.trip(testDefinition)
  const instance = new ClassificationGateway({
    registry: new StaticClassificationRegistry([testDefinition]),
    jev: { async classify() { jevCalls += 1; return jevAnswer() } },
    hermes: { async classify(call: HermesClassificationCall) {
      hermesCalls += 1
      return { actualProvider: call.target.provider, actualModel: call.target.model,
        value: { label: 'drop' }, durationMs: 7, usage: { inputTokens: 2, outputTokens: 1 } }
    } },
    capacity: ports, audit: ports,
    sleep: async () => { throw new Error('retry sleep must not run') },
  })
  const result = await instance.classify<Decision>(request())
  assert.equal(result.fallbackUsed, true)
  assert.equal(result.fallbackReason, 'circuit_open')
  assert.deepEqual({ jevCalls, hermesCalls }, { jevCalls: 0, hermesCalls: 1 })
})

test('a billing failure on a Jev-required definition stays held with no retry and no Hermes', async () => {
  let jevCalls = 0
  const testDefinition = { ...definition(), requiresJev: true }
  const ports = new CircuitTrackingPorts(testDefinition.capacity, () => 0)
  const instance = new ClassificationGateway({
    registry: new StaticClassificationRegistry([testDefinition]),
    jev: { async classify() {
      jevCalls += 1
      throw billingError(250)
    } },
    hermes: { async classify() { throw new Error('Hermes must not be called') } },
    capacity: ports, audit: ports,
    sleep: async () => { throw new Error('retry sleep must not run') },
  })
  await assert.rejects(instance.classify<Decision>(request()), (error: unknown) => {
    assert.ok(error instanceof InferenceGatewayError)
    assert.equal(error.category, 'provider_billing')
    assert.equal(error.retryable, true)
    return true
  })
  assert.equal(jevCalls, 1)
  assert.equal(ports.attempts[0]?.calls.length, 1)
  assert.equal(ports.attempts[0]?.fallbackUsed, false)
})
