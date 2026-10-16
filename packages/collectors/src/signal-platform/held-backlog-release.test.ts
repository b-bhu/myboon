import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Signal } from './contracts'
import { createActiveSourceTriageIntake } from './active-triage'
import { HELD_BACKLOG_RELEASE_BUDGET_POLICY_VERSION, releaseHeldBacklog } from './held-backlog-release'
import { SqliteSignalPlatformStore } from './sqlite-platform-store'
import type { TriageCapacitySnapshot } from './triage-contracts'

const NOW = '2026-10-16T12:00:00.000Z'

function news(id: string, publishedAt: string): Extract<Signal, { sourceType: 'news' }> {
  return {
    schemaVersion: 'myboon.signal.v1', signalId: `sig-${id}`, sourceType: 'news', contentKind: 'article',
    content: { schemaVersion: 'myboon.signal_content.article.v1', materialChange: true },
    sourceId: `article:${id}`, observedAt: publishedAt, publishedAt,
    canonicalUrl: `https://example.com/${id}`, title: `Story ${id}`, visibleSummary: 'Something changed.',
    media: { imageUrl: null, attribution: null },
    sourceHints: { entities: ['Example'], assets: [], eventId: null, deadline: null },
    provenance: { provider: 'wire', upstreamSource: 'Wire', rawPayloadRef: `news:${id}` },
    idempotencyKey: `news:${id}`,
  }
}

function openCapacity(): TriageCapacitySnapshot {
  const bucket = { available: 100, reservedAvailable: 10, utilization: 0 }
  return {
    byPriority: { P0: { ...bucket }, P1: { ...bucket }, P2: { ...bucket }, P3: { ...bucket } },
    byDepth: { light: { ...bucket }, standard: { ...bucket }, deep: { ...bucket } },
  }
}

/** Recreate a pre-#339 hold: the live decision is a defer with the retired reason. */
async function seedHeld(store: SqliteSignalPlatformStore, signal: Signal): Promise<void> {
  const preview = await createActiveSourceTriageIntake({
    store, capacity: { snapshot: () => openCapacity() }, providerHealth: 'healthy', clock: () => signal.observedAt,
  }).preview(signal)
  store.appendSignal(signal)
  store.appendTriageDecision({
    ...preview, decisionId: `triage:held:${signal.signalId}`, outcome: 'defer', budget: null,
    reasons: [...preview.reasons, { code: 'unsupported_research_depth_defer', detail: 'legacy hold' }],
  })
}

test('held backlog: dry-run counts and writes nothing; apply closes >3d, releases the rest; rerun is a no-op', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'held-backlog-'))
  const store = new SqliteSignalPlatformStore(join(dir, 'news.sqlite'), 'news')
  try {
    await seedHeld(store, news('old', '2026-10-10T00:00:00.000Z'))
    await seedHeld(store, news('fresh', '2026-10-15T00:00:00.000Z'))
    // Not held: admitted normally, must never be touched.
    await createActiveSourceTriageIntake({ store, capacity: { snapshot: () => openCapacity() }, providerHealth: 'healthy', clock: () => NOW })
      .ingest(news('live', '2026-10-16T00:00:00.000Z'))

    const dry = await releaseHeldBacklog({ store, apply: false, now: NOW, providerHealth: 'healthy' })
    assert.deepEqual({ held: dry.held, toClose: dry.toClose, toRelease: dry.toRelease, closed: dry.closed, released: dry.released },
      { held: 2, toClose: 1, toRelease: 1, closed: 0, released: 0 })
    assert.equal(store.listTriageDecisionsBySignal('sig-old', 10).length, 1)

    const applied = await releaseHeldBacklog({ store, apply: true, now: NOW, providerHealth: 'healthy' })
    assert.deepEqual({ closed: applied.closed, released: applied.released, failures: applied.failures }, { closed: 1, released: 1, failures: [] })
    const old = store.listTriageDecisionsBySignal('sig-old', 10).find((d) => d.budgetPolicyVersion === HELD_BACKLOG_RELEASE_BUDGET_POLICY_VERSION)
    assert.equal(old?.outcome, 'archive')
    assert.ok(old?.reasons.some((r) => r.code === 'held_backlog_expired_closed'))
    const fresh = store.listTriageDecisionsBySignal('sig-fresh', 10).find((d) => d.budgetPolicyVersion === HELD_BACKLOG_RELEASE_BUDGET_POLICY_VERSION)
    assert.equal(fresh?.outcome, 'light')
    assert.ok(fresh?.reasons.some((r) => r.code === 'held_backlog_released'))
    assert.equal(store.listTriageDecisionsBySignal('sig-live', 10).length, 1)

    const rerun = await releaseHeldBacklog({ store, apply: true, now: NOW, providerHealth: 'healthy' })
    assert.deepEqual({ held: rerun.held, closed: rerun.closed, released: rerun.released }, { held: 0, closed: 0, released: 0 })
  } finally {
    store.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('held backlog dry-run works on a read-only store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'held-backlog-ro-'))
  const path = join(dir, 'news.sqlite')
  const writer = new SqliteSignalPlatformStore(path, 'news')
  await seedHeld(writer, news('old', '2026-10-01T00:00:00.000Z'))
  writer.close()
  const reader = new SqliteSignalPlatformStore(path, 'news', { readOnly: true })
  try {
    const report = await releaseHeldBacklog({ store: reader, apply: false, now: NOW, providerHealth: 'healthy' })
    assert.equal(report.toClose, 1)
  } finally {
    reader.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('live re-ingest of a stored v1 hold resumes the saved decision: no new decision, no id collision (#339 review)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'held-backlog-replay-'))
  const store = new SqliteSignalPlatformStore(join(dir, 'news.sqlite'), 'news')
  try {
    const signal = news('held', '2026-10-15T00:00:00.000Z')
    await seedHeld(store, signal)
    const result = await createActiveSourceTriageIntake({
      store, capacity: { snapshot: () => openCapacity() }, providerHealth: 'healthy', clock: () => NOW,
    }).ingest(signal)
    assert.equal(result.decision?.decisionId, `triage:held:${signal.signalId}`)
    assert.equal(result.decision?.outcome, 'defer')
    assert.equal(result.workInserted, false)
    assert.equal(store.listTriageDecisionsBySignal(signal.signalId, 10).length, 1)
  } finally {
    store.close(); rmSync(dir, { recursive: true, force: true })
  }
})
