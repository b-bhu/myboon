import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { SharedResearchRuntimeStatus } from './run-shared-research'
import {
  AtomicResearchRuntimeStatusFile,
  ResearchRuntimeDrainTimeoutError,
  awaitDrainWithin,
  readResearchRuntimeStatusSnapshot,
} from './research-runtime-lifecycle'

const CAPTURED = '2026-08-26T12:00:00.000Z'

test('atomic runtime status reports missing, current, then stale without leaking configuration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'research-runtime-status-'))
  const path = join(dir, 'status.json')
  try {
    assert.deepEqual(await readResearchRuntimeStatusSnapshot({ path, staleAfterMs: 1_000 }), {
      availability: 'missing', snapshot: null,
    })
    const writer = new AtomicResearchRuntimeStatusFile(path, 123)
    await writer.write({
      capturedAt: CAPTURED, lifecycleState: 'running', runtime: status(),
      recovery: { lastRunAt: CAPTURED, recoveredBySource: { news: ['work-1'] } },
    })
    const current = await readResearchRuntimeStatusSnapshot({
      path, now: () => Date.parse(CAPTURED) + 999, staleAfterMs: 1_000,
    })
    assert.equal(current.availability, 'current')
    assert.equal(current.snapshot?.runtime.providerObservation.durationMs, 42)
    assert.equal(current.snapshot?.runtime.circuitNextProbes[0]?.nextProbeAt, '2026-08-26T12:01:00.000Z')
    assert.equal(JSON.stringify(current).includes('prompt contents'), false)
    assert.equal(readdirSync(dir).some((entry) => entry.endsWith('.tmp')), false)
    assert.equal((await readResearchRuntimeStatusSnapshot({
      path, now: () => Date.parse(CAPTURED) + 1_001, staleAfterMs: 1_000,
    })).availability, 'stale')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('serialized writes cannot let an older temporary snapshot replace the final lifecycle state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'research-runtime-order-'))
  const path = join(dir, 'status.json')
  try {
    const writer = new AtomicResearchRuntimeStatusFile(path, 456)
    await Promise.all([
      writer.write({ capturedAt: CAPTURED, lifecycleState: 'draining', runtime: status(), recovery: emptyRecovery() }),
      writer.write({ capturedAt: '2026-08-26T12:00:01.000Z', lifecycleState: 'stopped', runtime: status(), recovery: emptyRecovery() }),
    ])
    const result = await readResearchRuntimeStatusSnapshot({
      path, now: () => Date.parse('2026-08-26T12:00:01.000Z'), staleAfterMs: 1_000,
    })
    assert.equal(result.snapshot?.lifecycleState, 'stopped')
    assert.equal(result.snapshot?.capturedAt, '2026-08-26T12:00:01.000Z')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('drain grace fails visibly instead of reporting an active call stopped', async () => {
  await assert.rejects(
    awaitDrainWithin(new Promise<void>(() => undefined), 5),
    ResearchRuntimeDrainTimeoutError,
  )
})

function emptyRecovery() {
  return { lastRunAt: null, recoveredBySource: {} }
}

function status(): SharedResearchRuntimeStatus {
  return {
    schemaVersion: 'myboon.shared_research_runtime_status.v1', mode: 'active', sources: ['news'],
    supportedDepths: ['light'],
    priorityPools: [{ name: 'urgent', priorities: ['P0', 'P1'] }, { name: 'background', priorities: ['P2', 'P3'] }],
    standardSearch: { schemaVersion: 'myboon.standard_search_status.v1', enabled: false, connectorId: null, policyVersion: null },
    gateway: {
      schemaVersion: 'myboon.inference_gateway_status.v1', hermesProfileConfigured: false,
      investigate: { enabled: false, fallbackEnabled: false }, routes: [],
    },
    circuits: { schemaVersion: 'myboon.inference_circuit_status.v1', capturedAt: CAPTURED, workloads: [] },
    circuitNextProbes: [{
      workload: 'research.synthesis', provider: 'provider', model: 'model', nextProbeAt: '2026-08-26T12:01:00.000Z',
    }],
    providerObservation: {
      lastCompletedAt: CAPTURED, lastSucceededAt: CAPTURED, workload: 'research.synthesis',
      provider: 'provider', model: 'model', succeeded: true, durationMs: 42,
      providerCalls: 1, repairCalls: 0, failureCategory: null,
    },
    deepEnabled: false,
  }
}
