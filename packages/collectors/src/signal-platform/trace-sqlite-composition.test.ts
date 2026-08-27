import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { operatorSignal, operatorWork } from './operator-fixtures.test-support'
import { SqliteExecutionLedger } from './sqlite-execution-ledger'
import { SqliteSignalPlatformStore } from './sqlite-platform-store'
import { inspectSqliteTrace } from './trace-sqlite-composition'

test('trace composition finds Calendar/X while isolating a corrupt News database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-v3-trace-partial-'))
  const newsPath = join(dir, 'news.sqlite')
  const pipelinePath = join(dir, 'pipeline.sqlite')
  writeFileSync(newsPath, 'not a sqlite database')
  const calendar = new SqliteSignalPlatformStore(pipelinePath, 'market_calendar')
  const ledger = new SqliteExecutionLedger(pipelinePath)
  calendar.appendSignal(operatorSignal('market_calendar', 'calendar-composition'))
  calendar.admitResearchWork(operatorWork('market_calendar', 'calendar-composition'))
  calendar.close(); ledger.close()
  try {
    const result = await inspectSqliteTrace({
      newsPath, pipelinePath, query: { workId: 'work-calendar-composition' },
      now: '2026-08-26T13:00:00.000Z',
    })
    assert.equal(result.found, true)
    assert.equal(result.sourceType, 'market_calendar')
    assert.ok(result.unavailableSources.includes('news'))
    assert.equal(result.unavailableSources.includes('polymarket'), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
