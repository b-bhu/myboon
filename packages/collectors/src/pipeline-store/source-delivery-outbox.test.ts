import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { adaptLivePolymarketSignal } from '../signal-platform/adapters/polymarket-live'
import { ImmutableRecordConflictError } from '../signal-platform/platform-store'
import { sourceDeliveryDigest } from '../signal-platform/source-delivery-outbox'
import { backupPipelineStore, restorePipelineStore } from './backup'
import { SqlitePipelineStore } from './sqlite-store'
import type { PipelineWatchlistUpsertInput } from './store'

const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void }
}

function watchlist(yesPrice: number, observedAt: string): PipelineWatchlistUpsertInput {
  return {
    source: 'polymarket',
    area: 'markets',
    tagSlug: 'crypto',
    tagLabel: 'Crypto',
    marketId: 'market-1',
    slug: 'market-one',
    title: 'Market one?',
    eventSlug: null,
    eventTitle: null,
    endDate: null,
    isManualPin: false,
    rankInArea: 1,
    watchScore: 60,
    scoreBreakdown: { volume: 60 },
    selectionReason: 'test fixture',
    latestObservedAt: observedAt,
    latestYesPrice: yesPrice,
    latestVolume: 1000,
    latestVolume24h: 100,
    latestLiquidity: 200,
    status: 'active',
  }
}

function signal() {
  return adaptLivePolymarketSignal({
    observedAt: '2026-10-01T12:00:00.000Z',
    area: 'markets',
    market: {
      marketId: 'market-1',
      slug: 'market-one',
      title: 'Market one?',
      tagSlug: 'crypto',
      tagLabel: 'Crypto',
      endDate: null,
      sourceUpdatedAt: '2026-10-01T11:59:00.000Z',
    },
    observation: {
      candidateType: 'odds_moved',
      whatChanged: 'Odds moved from 50% to 56%.',
      whyFlagged: 'A material move crossed the configured threshold.',
      score: 60,
      scoreBreakdown: { oddsDelta: 0.06 },
      metrics: { previousPrice: 0.5, currentPrice: 0.56 },
      evidenceRefs: [],
    },
  })
}

test('legacy pipeline database migration preserves baseline and does not invent delivery obligations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-outbox-migration-'))
  const path = join(dir, 'pipeline.sqlite')
  const old = new DatabaseSync(path)
  old.exec(`
    CREATE TABLE pipeline_watchlist (
      id TEXT PRIMARY KEY,
      area TEXT NOT NULL,
      slug TEXT NOT NULL,
      latest_observed_at TEXT,
      latest_yes_price REAL,
      latest_volume REAL,
      latest_volume_24h REAL,
      watch_score REAL NOT NULL DEFAULT 0,
      UNIQUE (area, slug)
    );
    INSERT INTO pipeline_watchlist (
      id, area, slug, latest_observed_at, latest_yes_price, latest_volume, latest_volume_24h, watch_score
    ) VALUES (
      'legacy', 'markets', 'market-one', '2026-09-30T12:00:00.000Z', 0.5, 900, 90, 55
    );
  `)
  old.close()

  const store = new SqlitePipelineStore(path)
  try {
    assert.deepEqual(await store.getWatchlistSnapshots('markets', ['market-one']), [{
      slug: 'market-one',
      latestObservedAt: '2026-09-30T12:00:00.000Z',
      latestYesPrice: 0.5,
      latestVolume: 900,
      latestVolume24h: 90,
    }])
    assert.deepEqual(await store.listPendingSourceDeliveries(10), [])
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('market baseline and immutable delivery obligation commit or roll back together', async () => {
  const store = new SqlitePipelineStore(':memory:')
  try {
    const originalSignal = signal()
    const conflictingSignal = { ...originalSignal, title: 'conflicting material payload' }
    const prior = watchlist(0.5, '2026-10-01T11:58:00.000Z')
    const next = watchlist(0.56, '2026-10-01T12:00:00.000Z')

    await store.commitWatchlistAndSourceDeliveries(
      [prior],
      [{ signal: originalSignal, observedAt: originalSignal.observedAt }],
    )
    const [pending] = await store.listPendingSourceDeliveries(10)
    assert.ok(pending)
    assert.equal(pending.payloadDigest, sourceDeliveryDigest(originalSignal))

    await assert.rejects(
      store.commitWatchlistAndSourceDeliveries(
        [next],
        [{ signal: conflictingSignal, observedAt: conflictingSignal.observedAt }],
      ),
      ImmutableRecordConflictError,
    )

    const [snapshot] = await store.getWatchlistSnapshots('markets', ['market-one'])
    assert.equal(snapshot?.latestYesPrice, 0.5, 'the baseline update rolled back with the conflicting outbox write')
    const stillPending = await store.listPendingSourceDeliveries(10)
    assert.equal(stillPending.length, 1)
    assert.equal(stillPending[0]?.signal.title, originalSignal.title)
  } finally {
    store.close()
  }
})

test('pipeline backup and restore retain pending source delivery obligations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-outbox-backup-'))
  const sourcePath = join(dir, 'pipeline.sqlite')
  const backupDir = join(dir, 'backups')
  const targetPath = join(dir, 'restored', 'pipeline.sqlite')
  const sourceStore = new SqlitePipelineStore(sourcePath)
  const expected = signal()
  try {
    await sourceStore.commitWatchlistAndSourceDeliveries(
      [watchlist(0.5, '2026-10-01T11:58:00.000Z')],
      [{ signal: expected, observedAt: expected.observedAt }],
    )
    sourceStore.close()

    const backup = await backupPipelineStore({ sourcePath, backupDir })
    assert.equal(backup.tableCounts.pipeline_source_delivery_outbox, 1)
    await restorePipelineStore({ backupPath: backup.path, targetPath })

    const restored = new SqlitePipelineStore(targetPath)
    try {
      const [pending] = await restored.listPendingSourceDeliveries(10)
      assert.equal(pending?.signal.signalId, expected.signalId)
      assert.equal(pending?.payloadDigest, sourceDeliveryDigest(expected))
    } finally {
      restored.close()
    }
  } finally {
    try { sourceStore.close() } catch { /* already closed after backup preparation */ }
    rmSync(dir, { recursive: true, force: true })
  }
})
