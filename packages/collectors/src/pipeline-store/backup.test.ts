import assert from 'node:assert/strict'
import { closeSync, mkdtempSync, openSync, rmSync, statSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  backupPipelineStore,
  pruneOldBackups,
  restorePipelineStore,
  verifyPipelineBackup,
} from './backup'
import { SqlitePipelineStore } from './sqlite-store'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Seeds a fresh SQLite pipeline store at `path` with real rows through the
 * public store API, then closes it so the file is fully flushed (checkpointed
 * out of WAL) before a backup or corruption test touches it directly. */
async function seedStore(path: string): Promise<{ watchlistCount: number; candidateCount: number; runCount: number }> {
  const store = new SqlitePipelineStore(path)
  try {
    await store.upsertWatchlist([
      {
        source: 'polymarket',
        area: 'crypto',
        tagSlug: 'crypto-tag',
        tagLabel: 'Crypto',
        marketId: 'market-1',
        slug: 'slug-1',
        title: 'Title 1',
        eventSlug: null,
        eventTitle: null,
        endDate: null,
        isManualPin: false,
        rankInArea: 1,
        watchScore: 0.5,
        scoreBreakdown: { volume: 0.5 },
        selectionReason: 'high volume',
        latestObservedAt: '2026-07-01T00:00:00.000Z',
        latestYesPrice: 0.6,
        latestVolume: 1000,
        latestVolume24h: 500,
        latestLiquidity: 200,
      },
      {
        source: 'polymarket',
        area: 'crypto',
        tagSlug: 'crypto-tag',
        tagLabel: 'Crypto',
        marketId: 'market-2',
        slug: 'slug-2',
        title: 'Title 2',
        eventSlug: null,
        eventTitle: null,
        endDate: null,
        isManualPin: false,
        rankInArea: 2,
        watchScore: 0.3,
        scoreBreakdown: { volume: 0.3 },
        selectionReason: 'moderate volume',
        latestObservedAt: '2026-07-01T00:00:00.000Z',
        latestYesPrice: 0.4,
        latestVolume: 400,
        latestVolume24h: 100,
        latestLiquidity: 50,
      },
    ])

    await store.insertCandidates([
      {
        source: 'polymarket',
        area: 'crypto',
        candidateType: 'market_shift',
        marketId: 'market-1',
        slug: 'slug-1',
        title: 'Title 1',
        tagSlug: 'crypto-tag',
        tagLabel: 'Crypto',
        observedAt: '2026-07-01T00:00:00.000Z',
        whatChanged: 'Price moved',
        whyFlagged: 'Volume spike',
        score: 0.5,
        scoreBreakdown: { volume: 0.5 },
        metrics: { volume24h: 1000 },
        evidenceRefs: ['ref-1'],
        dedupeKey: 'dedupe-1',
      },
      {
        source: 'polymarket',
        area: 'crypto',
        candidateType: 'market_shift',
        marketId: 'market-2',
        slug: 'slug-2',
        title: 'Title 2',
        tagSlug: 'crypto-tag',
        tagLabel: 'Crypto',
        observedAt: '2026-07-01T00:00:00.000Z',
        whatChanged: 'Price moved',
        whyFlagged: 'Volume spike',
        score: 0.3,
        scoreBreakdown: { volume: 0.3 },
        metrics: { volume24h: 400 },
        evidenceRefs: ['ref-2'],
        dedupeKey: 'dedupe-2',
      },
      {
        source: 'polymarket',
        area: 'crypto',
        candidateType: 'market_shift',
        marketId: 'market-3',
        slug: 'slug-3',
        title: 'Title 3',
        tagSlug: 'crypto-tag',
        tagLabel: 'Crypto',
        observedAt: '2026-07-01T00:00:00.000Z',
        whatChanged: 'Price moved',
        whyFlagged: 'Volume spike',
        score: 0.1,
        scoreBreakdown: { volume: 0.1 },
        metrics: { volume24h: 100 },
        evidenceRefs: ['ref-3'],
        dedupeKey: 'dedupe-3',
      },
    ])

    await store.startRun({
      source: 'polymarket',
      sourceArea: 'crypto',
      stage: 'collector',
      startedAt: '2026-07-01T00:00:00.000Z',
    })

    return { watchlistCount: 2, candidateCount: 3, runCount: 1 }
  } finally {
    store.close()
  }
}

/** Overwrites bytes in the middle of a file with garbage, in place. Used to
 * simulate disk-level corruption of an otherwise-valid SQLite file. */
function corruptFileInPlace(path: string): void {
  const size = statSync(path).size
  const fd = openSync(path, 'r+')
  try {
    // Scramble a range in the middle of the file - past the first page (where
    // the SQLite header lives) so this corrupts page content/structure, not
    // just the magic header, proving integrity_check catches structural
    // corruption and not merely "this isn't a SQLite file at all."
    const start = Math.max(100, Math.floor(size / 2) - 512)
    const length = Math.min(1024, size - start)
    assert.ok(length > 0, 'test file must be large enough to corrupt meaningfully')
    const garbage = Buffer.alloc(length, 0xff)
    writeSync(fd, garbage, 0, length, start)

    // Belt-and-braces: also stomp the header magic ("SQLite format 3\0") so
    // corruption is unambiguous even if the mid-file page happens to be
    // unused free space that integrity_check wouldn't scan.
    const headerGarbage = Buffer.alloc(16, 0xee)
    writeSync(fd, headerGarbage, 0, 16, 0)
  } finally {
    closeSync(fd)
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('backupPipelineStore: backup of a store with real data has tableCounts matching the source', async () => {
  const dir = makeTmpDir('pipeline-backup-src-')
  const backupDir = join(dir, 'backups')
  try {
    const sourcePath = join(dir, 'pipeline.sqlite')
    const seeded = await seedStore(sourcePath)

    const result = await backupPipelineStore({ sourcePath, backupDir, now: '2026-07-28T12:00:00.000Z' })

    assert.equal(result.tableCounts.pipeline_watchlist, seeded.watchlistCount)
    assert.equal(result.tableCounts.pipeline_candidates, seeded.candidateCount)
    assert.equal(result.tableCounts.pipeline_runs, seeded.runCount)
    assert.equal(result.tableCounts.pipeline_research, 0)
    assert.equal(result.tableCounts.pipeline_editor_decisions, 0)
    assert.equal(result.tableCounts.pipeline_editor_drafts, 0)
    assert.ok(result.sizeBytes > 0, 'backup file should be non-empty')
    assert.ok(result.path.includes('pipeline-2026-07-28T12-00-00-000Z.sqlite'))
    assert.equal(result.createdAt, '2026-07-28T12:00:00.000Z')

    const fileStat = statSync(result.path)
    assert.equal(fileStat.size, result.sizeBytes)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyPipelineBackup: returns ok:true and integrity "ok" on a good backup', async () => {
  const dir = makeTmpDir('pipeline-backup-verify-good-')
  try {
    const sourcePath = join(dir, 'pipeline.sqlite')
    await seedStore(sourcePath)
    const backupDir = join(dir, 'backups')

    const backupResult = await backupPipelineStore({ sourcePath, backupDir })
    const verification = await verifyPipelineBackup(backupResult.path)

    assert.equal(verification.integrity, 'ok')
    assert.equal(verification.ok, true)
    assert.deepEqual(verification.mismatches, [])
    assert.equal(verification.tableCounts.pipeline_candidates, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyPipelineBackup: DETECTS corruption (the most important test - a verifier that cannot detect corruption is theatre)', async () => {
  const dir = makeTmpDir('pipeline-backup-corrupt-')
  try {
    const sourcePath = join(dir, 'pipeline.sqlite')
    await seedStore(sourcePath)
    const backupDir = join(dir, 'backups')

    const backupResult = await backupPipelineStore({ sourcePath, backupDir })

    // Sanity check: the backup is good BEFORE we corrupt it.
    const beforeCorruption = await verifyPipelineBackup(backupResult.path)
    assert.equal(beforeCorruption.ok, true, 'precondition: backup must be valid before corruption')

    corruptFileInPlace(backupResult.path)

    const afterCorruption = await verifyPipelineBackup(backupResult.path)
    assert.equal(afterCorruption.ok, false, 'verify must detect the corruption')
    assert.notEqual(afterCorruption.integrity, 'ok')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyPipelineBackup: reports mismatches when expected counts differ', async () => {
  const dir = makeTmpDir('pipeline-backup-mismatch-')
  try {
    const sourcePath = join(dir, 'pipeline.sqlite')
    await seedStore(sourcePath)
    const backupDir = join(dir, 'backups')

    const backupResult = await backupPipelineStore({ sourcePath, backupDir })
    const wrongExpectation = {
      ...backupResult.tableCounts,
      pipeline_candidates: backupResult.tableCounts.pipeline_candidates + 5,
      pipeline_watchlist: 0,
    }

    const verification = await verifyPipelineBackup(backupResult.path, wrongExpectation)

    assert.equal(verification.ok, false)
    assert.ok(verification.mismatches.some((m) => m.startsWith('pipeline_candidates:')))
    assert.ok(verification.mismatches.some((m) => m.startsWith('pipeline_watchlist:')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('restorePipelineStore: round-trip reproduces the seeded data at a fresh path', async () => {
  const dir = makeTmpDir('pipeline-backup-restore-')
  try {
    const sourcePath = join(dir, 'pipeline.sqlite')
    await seedStore(sourcePath)
    const backupDir = join(dir, 'backups')

    const backupResult = await backupPipelineStore({ sourcePath, backupDir })

    const targetPath = join(dir, 'restored', 'pipeline.sqlite')
    const restoreResult = await restorePipelineStore({ backupPath: backupResult.path, targetPath })

    assert.equal(restoreResult.verified, true)
    assert.equal(restoreResult.tableCounts.pipeline_candidates, 3)
    assert.equal(restoreResult.tableCounts.pipeline_watchlist, 2)

    const restoredStore = new SqlitePipelineStore(targetPath)
    try {
      const candidates = await restoredStore.findCandidatesForBacklog({
        source: 'polymarket',
        area: 'crypto',
        statuses: ['pending_research'],
        limit: 10,
      })
      assert.equal(candidates.length, 3)
      const bySlug = new Map(candidates.map((c) => [c.slug, c]))
      assert.equal(bySlug.get('slug-1')?.title, 'Title 1')
      assert.equal(bySlug.get('slug-1')?.dedupeKey, 'dedupe-1')
      assert.equal(bySlug.get('slug-2')?.score, 0.3)
      assert.equal(bySlug.get('slug-3')?.whatChanged, 'Price moved')

      const watchlist = await restoredStore.getWatchlistSnapshots('crypto', ['slug-1', 'slug-2'])
      assert.equal(watchlist.length, 2)
      const wlBySlug = new Map(watchlist.map((w) => [w.slug, w]))
      assert.equal(wlBySlug.get('slug-1')?.latestYesPrice, 0.6)
      assert.equal(wlBySlug.get('slug-2')?.latestVolume, 400)
    } finally {
      restoredStore.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('restorePipelineStore: refuses to overwrite an existing target without force, succeeds with force', async () => {
  const dir = makeTmpDir('pipeline-backup-force-')
  try {
    const sourcePath = join(dir, 'pipeline.sqlite')
    await seedStore(sourcePath)
    const backupDir = join(dir, 'backups')
    const backupResult = await backupPipelineStore({ sourcePath, backupDir })

    const targetPath = join(dir, 'existing', 'pipeline.sqlite')
    // Create a pre-existing target file (a different, smaller store).
    const preexisting = new SqlitePipelineStore(targetPath)
    preexisting.close()

    await assert.rejects(
      () => restorePipelineStore({ backupPath: backupResult.path, targetPath }),
      /Refusing to overwrite existing target/
    )

    const forced = await restorePipelineStore({ backupPath: backupResult.path, targetPath, force: true })
    assert.equal(forced.verified, true)
    assert.equal(forced.tableCounts.pipeline_candidates, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('restorePipelineStore: refuses a corrupt backup even with force', async () => {
  const dir = makeTmpDir('pipeline-backup-corrupt-restore-')
  try {
    const sourcePath = join(dir, 'pipeline.sqlite')
    await seedStore(sourcePath)
    const backupDir = join(dir, 'backups')
    const backupResult = await backupPipelineStore({ sourcePath, backupDir })

    corruptFileInPlace(backupResult.path)

    const targetPath = join(dir, 'restored', 'pipeline.sqlite')
    await assert.rejects(
      () => restorePipelineStore({ backupPath: backupResult.path, targetPath, force: true }),
      /Refusing to restore from a backup that fails verification/
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pruneOldBackups: keeps the newest N and deletes the rest, sorted by filename timestamp', async () => {
  const dir = makeTmpDir('pipeline-backup-prune-')
  try {
    const sourcePath = join(dir, 'pipeline.sqlite')
    await seedStore(sourcePath)
    const backupDir = join(dir, 'backups')

    const timestamps = [
      '2026-07-01T00:00:00.000Z',
      '2026-07-02T00:00:00.000Z',
      '2026-07-03T00:00:00.000Z',
      '2026-07-04T00:00:00.000Z',
      '2026-07-05T00:00:00.000Z',
    ]
    const created: string[] = []
    for (const now of timestamps) {
      const result = await backupPipelineStore({ sourcePath, backupDir, now })
      created.push(result.path)
    }

    const deleted = await pruneOldBackups({ backupDir, keep: 2 })

    // Oldest 3 of 5 should be deleted; newest 2 survive.
    assert.equal(deleted.length, 3)
    assert.ok(deleted.includes(created[0]))
    assert.ok(deleted.includes(created[1]))
    assert.ok(deleted.includes(created[2]))
    assert.ok(!deleted.includes(created[3]))
    assert.ok(!deleted.includes(created[4]))

    for (const path of deleted) {
      assert.throws(() => statSync(path))
    }
    assert.doesNotThrow(() => statSync(created[3]))
    assert.doesNotThrow(() => statSync(created[4]))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pruneOldBackups: defaults to keeping 7 backups when keep is not specified', async () => {
  const dir = makeTmpDir('pipeline-backup-prune-default-')
  try {
    const sourcePath = join(dir, 'pipeline.sqlite')
    await seedStore(sourcePath)
    const backupDir = join(dir, 'backups')

    for (let i = 1; i <= 9; i += 1) {
      const day = String(i).padStart(2, '0')
      await backupPipelineStore({ sourcePath, backupDir, now: `2026-07-${day}T00:00:00.000Z` })
    }

    const deleted = await pruneOldBackups({ backupDir })
    assert.equal(deleted.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
