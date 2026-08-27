import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { InferenceTelemetry } from '../inference-gateway'
import {
  AtomicEntityRuntimeHealthFile,
  EntityRuntimeHealthTracker,
  readEntityRuntimeHealthSnapshot,
} from './entity-runtime-health'

const CAPTURED = '2026-08-26T12:00:00.000Z'

test('Entity runtime health is atomic, bounded, measured, and reports current/stale availability', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'entity-runtime-health-'))
  const path = join(directory, 'health.json')
  try {
    assert.deepEqual(await readEntityRuntimeHealthSnapshot({ path, staleAfterMs: 1_000 }), {
      availability: 'missing', snapshot: null,
    })
    const tracker = new EntityRuntimeHealthTracker()
    tracker.observe(telemetry(), CAPTURED)
    const writer = new AtomicEntityRuntimeHealthFile(path, 123)
    await writer.write(tracker.snapshot({
      capturedAt: CAPTURED,
      mode: 'active',
      lifecycleState: 'running',
      desiredState: 'running',
      controlStatus: 'ok',
      circuit: {
        schemaVersion: 'myboon.inference_circuit_status.v1',
        capturedAt: CAPTURED,
        workloads: [{
          workload: 'entity.extract', ready: false,
          targets: [{ provider: 'provider', model: 'model-v1', circuitOpen: true, retryAfterMs: 60_000 }],
        }],
      },
    }))

    const current = await readEntityRuntimeHealthSnapshot({
      path, now: () => Date.parse(CAPTURED) + 999, staleAfterMs: 1_000,
    })
    assert.equal(current.availability, 'current')
    assert.equal(current.snapshot?.route.succeeded, true)
    assert.equal(current.snapshot?.route.durationMs, 42)
    assert.equal(current.snapshot?.circuit.targets[0]?.nextProbeAt, '2026-08-26T12:01:00.000Z')
    const serialized = JSON.stringify(current)
    for (const forbidden of ['prompt contents', 'raw provider error', 'inputTokens', 'providerCalls', 'policyVersion']) {
      assert.equal(serialized.includes(forbidden), false)
    }
    assert.equal(readdirSync(directory).some((entry) => entry.endsWith('.tmp')), false)
    assert.equal((await readEntityRuntimeHealthSnapshot({
      path, now: () => Date.parse(CAPTURED) + 1_001, staleAfterMs: 1_000,
    })).availability, 'stale')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('serialized health writes preserve final stopped/draining state and invalid files fail closed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'entity-runtime-health-order-'))
  const path = join(directory, 'health.json')
  const tracker = new EntityRuntimeHealthTracker()
  try {
    const writer = new AtomicEntityRuntimeHealthFile(path, 456)
    await Promise.all([
      writer.write(tracker.snapshot({
        capturedAt: CAPTURED, mode: 'shadow', lifecycleState: 'draining',
        desiredState: 'draining', controlStatus: 'ok',
      })),
      writer.write(tracker.snapshot({
        capturedAt: '2026-08-26T12:00:01.000Z', mode: 'shadow', lifecycleState: 'stopped',
        desiredState: 'draining', controlStatus: 'ok',
      })),
    ])
    const stopped = await readEntityRuntimeHealthSnapshot({
      path, now: () => Date.parse('2026-08-26T12:00:01.000Z'), staleAfterMs: 1_000,
    })
    assert.equal(stopped.snapshot?.lifecycleState, 'stopped')
    writeFileSync(path, '{malformed', 'utf8')
    assert.deepEqual(await readEntityRuntimeHealthSnapshot({ path, staleAfterMs: 1_000 }), {
      availability: 'invalid', snapshot: null,
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Entity health drops credential-shaped route identities and ignores non-Entity telemetry', () => {
  const tracker = new EntityRuntimeHealthTracker()
  tracker.observe({ ...telemetry(), workload: 'research.synthesis' }, CAPTURED)
  tracker.observe({
    ...telemetry(),
    actualProvider: 'sk-live-super-secret',
    actualModel: 'authorization:Bearer-token',
  }, CAPTURED)
  const snapshot = tracker.snapshot({
    capturedAt: CAPTURED, mode: 'active', lifecycleState: 'running',
    desiredState: 'running', controlStatus: 'ok',
  })
  assert.equal(snapshot.route.provider, null)
  assert.equal(snapshot.route.model, null)
  assert.equal(JSON.stringify(snapshot).includes('super-secret'), false)
  assert.equal(JSON.stringify(snapshot).includes('Bearer-token'), false)
})

function telemetry(): InferenceTelemetry {
  return {
    workload: 'entity.extract', purpose: 'entity planning', mode: 'generateStructured',
    promptVersion: 'prompt-v1', policyVersion: 'policy-v1',
    configuredPrimaryProvider: 'provider', configuredPrimaryModel: 'model-v1',
    actualProvider: 'provider', actualModel: 'model-v1', fallbackInvoked: false, fallbackReason: null,
    schemaValid: true, providerCalls: 1, repairCalls: 0, inputTokens: 10, outputTokens: 5,
    toolCalls: 0, durationMs: 42, budgetExceeded: false, failureCategory: null,
    calls: [{
      mode: 'generateStructured', provider: 'provider', model: 'model-v1', durationMs: 42,
      status: 'succeeded', failureCategory: null, schemaValid: true, inputTokens: 10, outputTokens: 5,
    }],
  }
}
