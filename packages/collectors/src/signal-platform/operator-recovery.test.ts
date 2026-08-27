import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SqliteNewsStore } from '../news/sqlite-store'
import { backupNewsStore, verifyNewsBackup } from '../pipeline-store/backup'
import {
  operatorEvidence, operatorExecutionEvent, operatorPacket, operatorSignal, operatorWork,
} from './operator-fixtures.test-support'
import {
  CanonicalRecoveryOperator,
  parseRecoveryOperatorArgs,
  type RecoveryBackupPort,
  type VerifiedBackupReceipt,
} from './operator-recovery'
import { RECOVERY_AUDIT_TABLE, SqliteRecoveryStorePort } from './operator-recovery-sqlite'
import { SqliteExecutionLedger } from './sqlite-execution-ledger'
import { SqliteSignalPlatformStore } from './sqlite-platform-store'

const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => {
    prepare(sql: string): { get(...params: unknown[]): unknown }
    close(): void
  }
}

function fixture(): { dir: string; newsPath: string; polyPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'signal-recovery-'))
  return { dir, newsPath: join(dir, 'news.sqlite'), polyPath: join(dir, 'pipeline.sqlite') }
}

function receipt(sources: Array<'news' | 'polymarket'> = ['news']): VerifiedBackupReceipt {
  return {
    receiptId: 'verified-backup-1', verified: true,
    verifiedAt: '2026-08-26T12:59:00.000Z', sources,
  }
}

function seedRecoverable(
  store: SqliteSignalPlatformStore,
  source: 'news' | 'polymarket',
  id: string,
  status: 'expired' | 'dead_letter' | 'retry_wait',
  options: { deep?: boolean; evidence?: boolean; packet?: boolean; updatedAt?: string } = {},
): void {
  store.appendSignal(operatorSignal(source, id))
  store.admitResearchWork(operatorWork(source, id, {
    status,
    researchDepth: options.deep ? 'deep' : 'standard',
    deepReason: options.deep ? 'insufficient_primary_evidence' : null,
    retryTargetStatus: status === 'retry_wait' ? 'synthesis_pending' : null,
    failureCategory: 'provider_timeout',
    failureDetail: 'provider credential must never be copied into an audit event',
    attemptCount: 3,
    updatedAt: options.updatedAt ?? '2026-08-26T12:00:00.000Z',
  }))
  if (options.evidence || options.packet) store.appendEvidence(operatorEvidence(id))
  if (options.packet) store.appendResearchPacket(operatorPacket(source, id))
}

test('recovery is dry-run by default, bounded and filterable without schema writes', async () => {
  const temp = fixture()
  const canonical = new SqliteSignalPlatformStore(temp.newsPath, 'news')
  const recovery = new SqliteRecoveryStorePort(temp.newsPath, 'news')
  let backupCalls = 0
  const backup: RecoveryBackupPort = {
    async createVerifiedBackup() { backupCalls += 1; return receipt() },
  }
  try {
    seedRecoverable(canonical, 'news', 'old', 'expired', { updatedAt: '2026-08-26T11:00:00.000Z' })
    seedRecoverable(canonical, 'news', 'new', 'dead_letter', { deep: true, updatedAt: '2026-08-26T12:00:00.000Z' })
    const operator = new CanonicalRecoveryOperator([recovery], backup)
    const result = await operator.run({
      now: '2026-08-26T13:00:00.000Z', batchSize: 1,
      filters: { sourceType: 'news', stage: 'retrieval', failureCategory: 'provider_timeout' },
    })
    assert.equal(result.mode, 'dry_run')
    assert.equal(result.rows.length, 1)
    assert.equal(result.rows[0]?.workId, 'work-old')
    assert.equal(result.rows[0]?.outcome, 'would_recover')
    assert.equal(canonical.getResearchWork('work-old')?.status, 'expired')
    assert.equal(backupCalls, 0)
    const db = new DatabaseSync(temp.newsPath, { readOnly: true })
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(RECOVERY_AUDIT_TABLE)
    db.close()
    assert.equal(table, undefined)
  } finally {
    recovery.close(); canonical.close(); rmSync(temp.dir, { recursive: true, force: true })
  }
})

test('apply fails closed without verified backup and source coverage', async () => {
  const temp = fixture()
  const canonical = new SqliteSignalPlatformStore(temp.newsPath, 'news')
  const recovery = new SqliteRecoveryStorePort(temp.newsPath, 'news')
  try {
    seedRecoverable(canonical, 'news', 'gate', 'expired')
    const operator = new CanonicalRecoveryOperator([recovery])
    await assert.rejects(
      operator.run({ apply: true, now: '2026-08-26T13:00:00.000Z' }),
      /verified backup receipt or backup port/,
    )
    await assert.rejects(
      operator.run({ apply: true, now: '2026-08-26T13:00:00.000Z', backupReceipt: receipt([]) }),
      /missing sources: news/,
    )
    assert.equal(canonical.getResearchWork('work-gate')?.status, 'expired')
  } finally {
    recovery.close(); canonical.close(); rmSync(temp.dir, { recursive: true, force: true })
  }
})

test('apply restores the correct pending stage, audits every row, preserves artifacts and is idempotent', async () => {
  const temp = fixture()
  const legacy = new SqliteNewsStore(temp.newsPath)
  legacy.close()
  const news = new SqliteSignalPlatformStore(temp.newsPath, 'news')
  const poly = new SqliteSignalPlatformStore(temp.polyPath, 'polymarket')
  const newsRecovery = new SqliteRecoveryStorePort(temp.newsPath, 'news')
  const polyRecovery = new SqliteRecoveryStorePort(temp.polyPath, 'polymarket')
  try {
    seedRecoverable(news, 'news', 'retrieve', 'expired')
    seedRecoverable(news, 'news', 'deep', 'dead_letter', { deep: true, evidence: true })
    seedRecoverable(news, 'news', 'synth', 'retry_wait', { evidence: true })
    seedRecoverable(news, 'news', 'entity', 'dead_letter', { packet: true })
    seedRecoverable(poly, 'polymarket', 'other', 'dead_letter')
    const ledger = new SqliteExecutionLedger(temp.newsPath)
    ledger.append(operatorExecutionEvent('news', 'retrieve', {
      packetId: null, status: 'failed', failureCategory: 'provider_timeout',
      failureDetail: 'immutable failure detail',
    }))
    ledger.close()
    const operator = new CanonicalRecoveryOperator([newsRecovery, polyRecovery])
    const result = await operator.run({
      apply: true, now: '2026-08-26T13:00:00.000Z', operationId: 'operator-run-1',
      filters: { sourceType: 'news' }, batchSize: 10, backupReceipt: receipt(['news']),
    })
    assert.deepEqual(
      Object.fromEntries(result.rows.map((row) => [row.workId, row.targetStatus])),
      {
        'work-deep': 'deep_pending', 'work-entity': 'entity_pending',
        'work-retrieve': 'research_pending', 'work-synth': 'synthesis_pending',
      },
    )
    for (const row of result.rows) {
      assert.equal(row.outcome, 'recovered')
      const work = news.getResearchWork(row.workId)
      assert.equal(work?.status, row.targetStatus)
      assert.equal(work?.attemptCount, 3)
      assert.equal(work?.failureCategory, null)
      assert.equal(work?.failureDetail, null)
      assert.equal(work?.retryTargetStatus, null)
      assert.equal(work?.leaseId, null)
    }
    assert.equal(news.listEvidenceByWork('work-entity', 10).length, 1)
    assert.equal(news.listResearchPacketsByWork('work-entity', 10).length, 1)
    const ledgerAfter = new SqliteExecutionLedger(temp.newsPath, { readOnly: true })
    assert.equal(ledgerAfter.listTrace('trace-retrieve').length, 1)
    ledgerAfter.close()
    assert.equal(newsRecovery.listRecoveryEvents('operator-run-1', 10).length, 4)
    assert.equal(poly.getResearchWork('work-other')?.status, 'dead_letter')

    const repeated = await operator.run({
      apply: true, now: '2026-08-26T13:01:00.000Z', operationId: 'operator-run-1',
      filters: { sourceType: 'news' }, batchSize: 10, backupReceipt: receipt(['news']),
    })
    assert.equal(repeated.matchedCount, 0)
    assert.equal(newsRecovery.listRecoveryEvents('operator-run-1', 10).length, 4)

    const backup = await backupNewsStore({
      sourcePath: temp.newsPath, backupDir: join(temp.dir, 'backups'), now: '2026-08-26T13:02:00.000Z',
    })
    const verified = await verifyNewsBackup(backup.path, backup.sourceTableCounts)
    assert.equal(verified.ok, true)
    assert.equal(verified.tableCounts[RECOVERY_AUDIT_TABLE], 4)
  } finally {
    newsRecovery.close(); polyRecovery.close(); news.close(); poly.close()
    rmSync(temp.dir, { recursive: true, force: true })
  }
})

test('recovery CLI parser defaults to dry-run and rejects unsafe or invalid bounds', () => {
  assert.deepEqual(parseRecoveryOperatorArgs(['--work-id', 'work-1']), {
    apply: false, batchSize: 25, filters: { workId: 'work-1' },
  })
  assert.equal(parseRecoveryOperatorArgs(['--apply', '--batch', '2']).apply, true)
  assert.throws(() => parseRecoveryOperatorArgs(['--batch', '501']), /between 1 and 500/)
  assert.throws(() => parseRecoveryOperatorArgs(['--failure-category', 'made_up']), /Unsupported failure category/)
  assert.throws(
    () => parseRecoveryOperatorArgs(['--since', '2026-08-27T00:00:00Z', '--until', '2026-08-26T00:00:00Z']),
    /since must not be after until/,
  )
})
