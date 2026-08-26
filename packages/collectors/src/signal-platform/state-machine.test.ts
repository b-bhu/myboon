import assert from 'node:assert/strict'
import test from 'node:test'
import { failureIncrementsAttempt, isRetryableFailure } from './failures'
import { assertWorkTransition, canTransition, planFailureTransition } from './state-machine'

test('state machine exposes the happy path and rejects stage skips', () => {
  const path = [
    'signal_observed', 'triage_pending', 'research_pending', 'retrieval_leased',
    'synthesis_pending', 'synthesis_leased', 'research_ready', 'entity_pending',
    'entity_leased', 'complete',
  ] as const
  for (let index = 1; index < path.length; index += 1) {
    assert.equal(canTransition(path[index - 1], path[index]), true)
  }
  assert.equal(canTransition('research_pending', 'complete'), false)
  assert.throws(() => assertWorkTransition('research_pending', 'complete'))
})

test('deep research uses its explicit side-queue states and cannot enter structured synthesis', () => {
  assert.equal(canTransition('retrieval_leased', 'deep_pending'), true)
  assert.equal(canTransition('deep_pending', 'deep_leased'), true)
  assert.equal(canTransition('deep_leased', 'research_ready'), true)
  assert.equal(canTransition('deep_pending', 'synthesis_leased'), false)
  assert.equal(canTransition('deep_leased', 'synthesis_pending'), false)
})

test('circuit_open schedules retry without incrementing an attempt', () => {
  assert.equal(isRetryableFailure('circuit_open'), true)
  assert.equal(failureIncrementsAttempt('circuit_open'), false)
  assert.deepEqual(planFailureTransition({
    from: 'retrieval_leased',
    category: 'circuit_open',
    nextAttemptAt: '2026-08-26T12:05:00.000Z',
  }), {
    status: 'retry_wait',
    failureCategory: 'circuit_open',
    attemptDelta: 0,
    nextAttemptAt: '2026-08-26T12:05:00.000Z',
  })
})

test('retryable provider execution failures require a retry time and spend an attempt', () => {
  assert.throws(() => planFailureTransition({ from: 'synthesis_leased', category: 'provider_timeout' }))
  assert.equal(planFailureTransition({
    from: 'synthesis_leased', category: 'provider_timeout', nextAttemptAt: '2026-08-26T12:05:00.000Z',
  }).attemptDelta, 1)
})
