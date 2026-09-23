import assert from 'node:assert/strict'
import test from 'node:test'
import { InferenceGatewayError } from './errors'
import { classificationShadowRetryAt } from './run-classification-shadow'

const OPTIONS = {
  attempt: 1,
  nowMs: 10_000,
  maxAttempts: 3,
  baseBackoffMs: 5_000,
  maxBackoffMs: 60_000,
}

test('shadow retries transient failures with bounded exponential backoff and provider hints', () => {
  const timeout = new InferenceGatewayError('timeout', { category: 'provider_timeout', retryable: true })
  assert.equal(classificationShadowRetryAt({ ...OPTIONS, error: timeout }), 15_000)
  assert.equal(classificationShadowRetryAt({ ...OPTIONS, error: timeout, attempt: 2 }), 20_000)

  const limited = new InferenceGatewayError('limited', {
    category: 'provider_rate_limited', retryable: true, retryAfterMs: 45_000,
  })
  assert.equal(classificationShadowRetryAt({ ...OPTIONS, error: limited }), 55_000)
})

test('shadow terminally fails non-retryable errors and the configured final attempt', () => {
  const invalid = new InferenceGatewayError('invalid', {
    category: 'invalid_structured_output', retryable: false,
  })
  assert.equal(classificationShadowRetryAt({ ...OPTIONS, error: invalid }), null)
  const unavailable = new InferenceGatewayError('down', { category: 'provider_unavailable', retryable: true })
  assert.equal(classificationShadowRetryAt({ ...OPTIONS, error: unavailable, attempt: 3 }), null)
})
