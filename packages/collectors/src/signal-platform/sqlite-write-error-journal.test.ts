import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  classifySqliteWriteFailure,
  FileSqliteWriteHealthJournal,
  sqliteStoreId,
} from './sqlite-write-error-journal'
import { SqliteSignalPlatformStore } from './sqlite-platform-store'

test('write-health journal reports current zero coverage and typed failures without raw error prose', () => {
  const directory = mkdtempSync(join(tmpdir(), 'write-health-'))
  try {
    const path = join(directory, 'journal.jsonl')
    const journal = new FileSqliteWriteHealthJournal(path, { heartbeatIntervalMs: 1_000 })
    const storeId = sqliteStoreId(join(directory, 'news.sqlite'))
    journal.observeSuccess({ sourceType: 'news', storeId, operation: 'append', observedAt: '2026-08-27T12:00:00.000Z' })
    assert.deepEqual(journal.readCoverage({
      sourceType: 'news', storeId, since: '2026-08-27T11:55:00.000Z', now: '2026-08-27T12:00:01.000Z', staleAfterMs: 60_000,
    }), { availability: 'available', value: 0, measuredCount: 1, reason: null })
    assert.equal(journal.observeFailure({
      sourceType: 'news', storeId, operation: 'commit', observedAt: '2026-08-27T12:00:02.000Z',
      error: Object.assign(new Error('database or disk is full secret=never-copy-this'), { code: 'SQLITE_FULL' }),
    }), true)
    const report = journal.readCoverage({
      sourceType: 'news', storeId, since: '2026-08-27T11:55:00.000Z', now: '2026-08-27T12:00:03.000Z', staleAfterMs: 60_000,
    })
    assert.equal(report.value, 1)
    assert.doesNotMatch(readFileSync(path, 'utf8'), /never-copy-this/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('write-health journal fails closed for missing/stale collectors and ignores non-SQLite errors', () => {
  const directory = mkdtempSync(join(tmpdir(), 'write-health-'))
  try {
    const path = join(directory, 'journal.jsonl')
    const reader = new FileSqliteWriteHealthJournal(path, { readOnly: true })
    assert.equal(reader.readCoverage({
      sourceType: 'news', storeId: sqliteStoreId(join(directory, 'news.sqlite')),
      since: '2026-08-27T11:00:00.000Z', now: '2026-08-27T12:00:00.000Z', staleAfterMs: 60_000,
    }).availability, 'unavailable')
    assert.equal(classifySqliteWriteFailure(new Error('validation failed')), null)
    assert.equal(classifySqliteWriteFailure(Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' })), 'busy')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('canonical store exposes current journal coverage through read-only observability', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'write-health-store-'))
  try {
    const databasePath = join(directory, 'news.sqlite')
    const journalPath = join(directory, 'journal.jsonl')
    const writer = new FileSqliteWriteHealthJournal(journalPath)
    const store = new SqliteSignalPlatformStore(databasePath, 'news', { writeHealthJournal: writer })
    store.close()
    const reader = new FileSqliteWriteHealthJournal(journalPath, { readOnly: true })
    const readOnly = new SqliteSignalPlatformStore(databasePath, 'news', {
      readOnly: true, writeHealthJournal: reader, writeHealthStaleAfterMs: 60_000,
    })
    const now = new Date().toISOString()
    const report = await readOnly.readWorkObservability({
      now, recentFailureSince: new Date(Date.parse(now) - 60_000).toISOString(), failureLimit: 10,
    })
    assert.deepEqual(report.sqliteWriteErrors, { availability: 'available', value: 0, measuredCount: 1, reason: null })
    readOnly.close()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('one physical pipeline heartbeat covers every logical adapter on that SQLite file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'write-health-pipeline-'))
  try {
    const databasePath = join(directory, 'pipeline.sqlite')
    const journalPath = join(directory, 'journal.jsonl')
    const writer = new FileSqliteWriteHealthJournal(journalPath)
    new SqliteSignalPlatformStore(databasePath, 'polymarket', { writeHealthJournal: writer }).close()
    const calendar = new SqliteSignalPlatformStore(databasePath, 'market_calendar', {
      readOnly: true, writeHealthJournal: new FileSqliteWriteHealthJournal(journalPath, { readOnly: true }),
    })
    const now = new Date().toISOString()
    const report = await calendar.readWorkObservability({
      now, recentFailureSince: new Date(Date.parse(now) - 60_000).toISOString(), failureLimit: 10,
    })
    assert.equal(report.sqliteWriteErrors.availability, 'available')
    calendar.close()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
