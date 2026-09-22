import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  resolveMaintenanceRunPlan,
  runMaintenanceDaemon,
  maintenanceMode,
} from './run-entity-catalog-maintenance'

test('maintenance mode defaults safe and accepts explicit apply', () => {
  assert.equal(maintenanceMode(undefined), 'dry_run')
  assert.equal(maintenanceMode('apply'), 'apply')
  assert.throws(() => maintenanceMode('automatic'), /must be dry_run or apply/)
})

test('auto mode requires a completed full-catalog baseline', () => {
  const plan = resolveMaintenanceRunPlan({
    requestedScope: 'auto',
    hasFullCatalogBaseline: false,
    // A completed incremental run must never count as the first baseline.
    latestCompletedStartedAt: '2026-09-20T00:00:00.000Z',
    intervalMs: 86_400_000,
    nowMs: Date.parse('2026-09-21T00:00:00.000Z'),
  })

  assert.deepEqual(plan, { scope: 'full_catalog' })
})

test('auto mode uses the latest completed watermark only after the full baseline', () => {
  const plan = resolveMaintenanceRunPlan({
    requestedScope: 'auto',
    hasFullCatalogBaseline: true,
    latestCompletedStartedAt: '2026-09-20T12:00:00.000Z',
    intervalMs: 86_400_000,
    nowMs: Date.parse('2026-09-21T00:00:00.000Z'),
  })

  assert.deepEqual(plan, {
    scope: 'incremental',
    changedSince: '2026-09-20T11:55:00.000Z',
  })
})

test('shutdown stops future ticks, aborts the active run, and drains it before exit', async () => {
  const signals = new EventEmitter()
  const state: {
    intervalRun?: () => Promise<void>
    activeSignal?: AbortSignal
  } = {}
  let intervalStopped = false
  let releaseActive!: () => void
  let markActiveStarted!: () => void
  const activeStarted = new Promise<void>((resolve) => { markActiveStarted = resolve })
  const activeReleased = new Promise<void>((resolve) => { releaseActive = resolve })

  const daemon = runMaintenanceDaemon({
    intervalMs: 86_400_000,
    runOnceOnly: false,
    signals,
    runInitial: async () => {},
    runScheduled: async (signal) => {
      state.activeSignal = signal
      markActiveStarted()
      await activeReleased
    },
    intervalFactory(options) {
      state.intervalRun = options.run
      return {
        stop() { intervalStopped = true },
        isRunning() { return false },
      }
    },
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.ok(state.intervalRun)
  const scheduled = state.intervalRun()
  await activeStarted

  signals.emit('SIGTERM')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(intervalStopped, true)
  assert.equal(state.activeSignal?.aborted, true)

  let daemonFinished = false
  void daemon.then(() => { daemonFinished = true })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(daemonFinished, false)

  releaseActive()
  await scheduled
  await daemon
  assert.equal(daemonFinished, true)
})
