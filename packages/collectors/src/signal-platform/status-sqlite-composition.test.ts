import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SqliteExecutionLedger } from './sqlite-execution-ledger'
import { SqliteSignalPlatformStore } from './sqlite-platform-store'
import { readSqliteControlPlaneStatus } from './status-sqlite-composition'

test('SQLite status composition returns typed partial output when pipeline DB is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-v3-status-partial-'))
  const newsPath = join(dir, 'news.sqlite')
  const pipelinePath = join(dir, 'missing-pipeline.sqlite')
  const store = new SqliteSignalPlatformStore(newsPath, 'news')
  const ledger = new SqliteExecutionLedger(newsPath)
  store.close(); ledger.close()
  try {
    const status = await readSqliteControlPlaneStatus({
      newsPath, pipelinePath, now: '2026-08-26T13:00:00.000Z',
    })
    assert.equal(status.availability, 'partial')
    assert.equal(status.sources.news?.availability, 'available')
    assert.equal(status.sources.polymarket?.availability, 'unavailable')
    assert.equal(status.sources.market_calendar?.availability, 'unavailable')
    assert.equal(status.sources.x?.availability, 'unavailable')
    assert.equal(status.execution.availability, 'partial')
    assert.equal(status.execution.error?.code, 'EXECUTION_READER_PARTIAL')
    assert.equal(status.errors.some((error) => error.component === 'news'), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('SQLite status composition isolates corrupt News while pipeline sources remain queryable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-v3-status-corrupt-'))
  const newsPath = join(dir, 'news.sqlite')
  const pipelinePath = join(dir, 'pipeline.sqlite')
  writeFileSync(newsPath, 'not sqlite')
  const store = new SqliteSignalPlatformStore(pipelinePath, 'polymarket')
  const ledger = new SqliteExecutionLedger(pipelinePath)
  store.close(); ledger.close()
  try {
    const status = await readSqliteControlPlaneStatus({
      newsPath, pipelinePath, now: '2026-08-26T13:00:00.000Z',
    })
    assert.equal(status.availability, 'partial')
    assert.equal(status.sources.news?.availability, 'unavailable')
    assert.equal(status.sources.polymarket?.availability, 'available')
    assert.equal(status.sources.market_calendar?.availability, 'available')
    assert.equal(status.sources.x?.availability, 'available')
    assert.equal(status.execution.error?.code, 'EXECUTION_READER_PARTIAL')
    assert.equal(status.totals.sqliteBytes, status.sources.polymarket?.sqliteSize?.totalBytes)
    assert.equal(status.sources.polymarket?.sqliteStoreId, status.sources.market_calendar?.sqliteStoreId)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
