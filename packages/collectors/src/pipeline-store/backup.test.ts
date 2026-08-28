import assert from 'node:assert/strict'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  backupNewsStore,
  backupPipelineStore,
  pruneOldBackups,
  restoreNewsStore,
  restorePipelineStore,
  verifyNewsBackup,
  verifyPipelineBackup,
} from './backup'
import { SqlitePipelineStore } from './sqlite-store'
import { SqliteNewsStore } from '../news/sqlite-store'
import { SqliteResearchShadowStore } from '../signal-platform/sqlite-research-shadow-store'
import { SqliteEntityShadowObservationStore } from '../entity-manager/sqlite-shadow-observation-store'
import { SqliteDeepResearchExecutionRegistry } from '../deep-research/sqlite-execution-registry'

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
    assert.equal(result.manifest.store, 'pipeline')
    assert.equal(result.manifest.backup.fileName, 'pipeline-2026-07-28T12-00-00-000Z.sqlite')
    assert.match(result.manifest.backup.sha256, /^[a-f0-9]{64}$/)
    assert.equal(result.manifest.backup.sizeBytes, result.sizeBytes)
    assert.equal(result.manifest.integrity, 'ok')
    assert.deepEqual(result.manifest.tableCounts, result.tableCounts)
    assert.equal(JSON.stringify(result.manifest).includes(dir), false, 'manifest must redact the source directory')
    assert.equal(existsSync(result.manifestPath), true)

    const fileStat = statSync(result.path)
    assert.equal(fileStat.size, result.sizeBytes)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('backupNewsStore: creates and verifies an independent news.sqlite backup', async () => {
  const dir = makeTmpDir('news-backup-src-')
  try {
    const sourcePath = join(dir, 'news.sqlite')
    const store = new SqliteNewsStore(sourcePath)
    store.close()

    const result = await backupNewsStore({
      sourcePath,
      backupDir: join(dir, 'backups'),
      now: '2026-08-18T12:00:00.000Z',
    })
    const verification = await verifyNewsBackup(result.path, result.sourceTableCounts)

    assert.match(result.path, /news-2026-08-18T12-00-00-000Z\.sqlite$/)
    assert.deepEqual(result.tableCounts, {
      news_source_runs: 0,
      news_candidate_observations: 0,
      news_research_results: 0,
    })
    assert.equal(verification.ok, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('backupNewsStore: inventories additive Feed V3 shadow and deep registry tables when present', async () => {
  const dir = makeTmpDir('news-feed-v3-backup-src-')
  try {
    const sourcePath = join(dir, 'news.sqlite')
    const news = new SqliteNewsStore(sourcePath)
    news.close()
    const researchShadow = new SqliteResearchShadowStore(sourcePath)
    const entityShadow = new SqliteEntityShadowObservationStore(sourcePath)
    const deepRegistry = new SqliteDeepResearchExecutionRegistry(sourcePath)
    researchShadow.close()
    entityShadow.close()
    deepRegistry.close()

    const result = await backupNewsStore({ sourcePath, backupDir: join(dir, 'backups') })
    assert.equal(result.tableCounts.signal_platform_research_shadow_results, 0)
    assert.equal(result.tableCounts.entity_manager_shadow_observations, 0)
    assert.equal(result.tableCounts.deep_research_active_executions, 0)
    assert.deepEqual(result.tableCounts, result.sourceTableCounts)
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

test('restoreNewsStore: verifies and restores news.sqlite independently', async () => {
  const dir = makeTmpDir('news-backup-restore-')
  try {
    const sourcePath = join(dir, 'news.sqlite')
    const store = new SqliteNewsStore(sourcePath)
    store.close()
    const backup = await backupNewsStore({ sourcePath, backupDir: join(dir, 'backups') })
    const targetPath = join(dir, 'restored', 'news.sqlite')

    const restored = await restoreNewsStore({ backupPath: backup.path, targetPath })
    assert.equal(restored.targetPath, targetPath)
    assert.equal(restored.verified, true)
    assert.deepEqual(restored.tableCounts, backup.tableCounts)
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

test('restorePipelineStore: requires the companion manifest and refuses manifest/backup digest mismatch', async () => {
  const dir = makeTmpDir('pipeline-backup-manifest-restore-')
  try {
    const sourcePath = join(dir, 'pipeline.sqlite')
    await seedStore(sourcePath)
    const first = await backupPipelineStore({
      sourcePath, backupDir: join(dir, 'backups'), now: '2026-08-27T10:00:00.000Z',
    })
    unlinkSync(first.manifestPath)
    await assert.rejects(
      () => restorePipelineStore({ backupPath: first.path, targetPath: join(dir, 'missing-manifest.sqlite') }),
      /manifest/i,
    )

    const second = await backupPipelineStore({
      sourcePath, backupDir: join(dir, 'backups'), now: '2026-08-27T10:01:00.000Z',
    })
    const manifest = JSON.parse(readFileSync(second.manifestPath, 'utf8')) as { backup: { sha256: string } }
    manifest.backup.sha256 = '0'.repeat(64)
    writeFileSync(second.manifestPath, `${JSON.stringify(manifest)}\n`)
    await assert.rejects(
      () => restorePipelineStore({ backupPath: second.path, targetPath: join(dir, 'digest-mismatch.sqlite') }),
      /sha256/i,
    )

    const third = await backupPipelineStore({
      sourcePath, backupDir: join(dir, 'backups'), now: '2026-08-27T10:02:00.000Z',
    })
    const timestampManifest = JSON.parse(readFileSync(third.manifestPath, 'utf8')) as { createdAt: string }
    timestampManifest.createdAt = '2026-08-27T10:03:00.000Z'
    writeFileSync(third.manifestPath, `${JSON.stringify(timestampManifest)}\n`)
    await assert.rejects(
      () => restorePipelineStore({ backupPath: third.path, targetPath: join(dir, 'created-at-mismatch.sqlite') }),
      /createdAt/i,
    )

    const fourth = await backupPipelineStore({
      sourcePath, backupDir: join(dir, 'backups'), now: '2026-08-27T10:04:00.000Z',
    })
    const extendedManifest = JSON.parse(readFileSync(fourth.manifestPath, 'utf8')) as Record<string, unknown>
    extendedManifest.unreviewed = true
    writeFileSync(fourth.manifestPath, `${JSON.stringify(extendedManifest)}\n`)
    await assert.rejects(
      () => restorePipelineStore({ backupPath: fourth.path, targetPath: join(dir, 'unknown-field.sqlite') }),
      /unknown/i,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('backupPipelineStore: timestamp collisions never replace an existing backup or manifest', async () => {
  const dir = makeTmpDir('pipeline-backup-no-replace-')
  try {
    const sourcePath = join(dir, 'pipeline.sqlite')
    await seedStore(sourcePath)
    const options = { sourcePath, backupDir: join(dir, 'backups'), now: '2026-08-27T11:00:00.000Z' }
    const first = await backupPipelineStore(options)
    const originalBackup = readFileSync(first.path)
    const originalManifest = readFileSync(first.manifestPath)
    await assert.rejects(() => backupPipelineStore(options), /Refusing to replace existing backup output/)
    assert.deepEqual(readFileSync(first.path), originalBackup)
    assert.deepEqual(readFileSync(first.manifestPath), originalManifest)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('restorePipelineStore: refuses targets with WAL/SHM sidecars even with force', async () => {
  const dir = makeTmpDir('pipeline-restore-sidecar-')
  try {
    const sourcePath = join(dir, 'source.sqlite')
    await seedStore(sourcePath)
    const backupResult = await backupPipelineStore({ sourcePath, backupDir: join(dir, 'backups') })
    const targetPath = join(dir, 'target.sqlite')
    writeFileSync(`${targetPath}-wal`, 'stale-sidecar')
    await assert.rejects(
      () => restorePipelineStore({ backupPath: backupResult.path, targetPath, force: true }),
      /sidecars exist/,
    )
    assert.equal(existsSync(targetPath), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('pruneOldBackups: dry-run reports exact bounded paths and apply deletes backup/manifest pairs', async () => {
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

    const preview = await pruneOldBackups({ backupDir, keep: 2, limit: 2, now: '2026-08-27T12:00:00.000Z' })

    assert.equal(preview.mode, 'dry_run')
    assert.deepEqual(preview.candidateBackupPaths, [created[0], created[1]])
    assert.equal(preview.candidateDeletePaths.length, 4)
    assert.equal(preview.deletedPaths.length, 0)
    assert.equal(preview.limited, true)
    assert.equal(existsSync(created[0]), true, 'dry-run must not delete')

    const applied = await pruneOldBackups({ backupDir, keep: 2, limit: 2, apply: true })
    assert.deepEqual(applied.candidateBackupPaths, [created[0], created[1]])
    assert.deepEqual(applied.deletedPaths, applied.candidateDeletePaths)
    assert.equal(existsSync(created[0]), false)
    assert.equal(existsSync(`${created[0]}.manifest.json`), false)
    assert.equal(existsSync(created[2]), true, 'the limit bounds each apply')
    assert.doesNotThrow(() => statSync(created[3]))
    assert.doesNotThrow(() => statSync(created[4]))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pruneOldBackups: defaults to keeping 7 backups and remains dry-run', async () => {
  const dir = makeTmpDir('pipeline-backup-prune-default-')
  try {
    const sourcePath = join(dir, 'pipeline.sqlite')
    await seedStore(sourcePath)
    const backupDir = join(dir, 'backups')

    for (let i = 1; i <= 9; i += 1) {
      const day = String(i).padStart(2, '0')
      await backupPipelineStore({ sourcePath, backupDir, now: `2026-07-${day}T00:00:00.000Z` })
    }

    const audit = await pruneOldBackups({ backupDir })
    assert.equal(audit.candidateBackupPaths.length, 2)
    assert.equal(audit.deletedPaths.length, 0)
    assert.equal(existsSync(audit.candidateBackupPaths[0]!), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verification catches a backup that silently lost rows (source-vs-backup, review finding)', async () => {
  const dir = makeTmpDir('backup-tamper-')
  try {
    const sourcePath = join(dir, 'source.sqlite')
    await seedStore(sourcePath)

    const backup = await backupPipelineStore({ sourcePath, backupDir: join(dir, 'backups') })
    assert.deepEqual(backup.tableCounts, backup.sourceTableCounts, 'untampered backup matches its source')

    // Simulate a backup that dropped rows mid-copy: delete one watchlist row
    // from the BACKUP file only. Verification against the SOURCE counts must
    // now fail - the old self-comparison could never catch this.
    const { createRequire } = await import('node:module')
    const { DatabaseSync } = createRequire(__filename)('node:sqlite') as {
      DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void }
    }
    const tampered = new DatabaseSync(backup.path)
    tampered.exec('DELETE FROM pipeline_watchlist WHERE rowid = (SELECT rowid FROM pipeline_watchlist LIMIT 1)')
    tampered.close()

    const verification = await verifyPipelineBackup(backup.path, backup.sourceTableCounts)
    assert.equal(verification.ok, false)
    assert.ok(verification.mismatches.some((m) => m.includes('pipeline_watchlist')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
