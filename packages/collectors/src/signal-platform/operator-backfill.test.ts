import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Signal } from './contracts'
import { createActiveSourceTriageIntake } from './active-triage'
import {
  BACKFILL_OPERATION_SCHEMA_VERSION,
  decodeLegacySignalBackfillCursor,
  LegacySignalBackfillOperator,
  parseLegacySignalBackfillArgs,
  type LegacySignalBackfillCandidate,
  type LegacySignalBackfillReadPort,
} from './operator-backfill'
import { SqliteSignalPlatformStore } from './sqlite-platform-store'

const NOW = '2026-08-26T12:00:00.000Z'

test('backfill CLI parser is dry-run by default and validates bounded filters', () => {
  assert.deepEqual(parseLegacySignalBackfillArgs([
    '--source', 'news', '--legacy-id', 'legacy-1', '--since', '2026-08-25T00:00:00.000Z', '--batch', '10',
  ]), {
    apply: false, batchSize: 10,
    filters: { sourceType: 'news', legacyId: 'legacy-1', since: '2026-08-25T00:00:00.000Z' },
  })
  assert.equal(parseLegacySignalBackfillArgs(['--apply']).apply, true)
  assert.throws(() => parseLegacySignalBackfillArgs(['--batch', '501']), /batchSize/)
  assert.throws(() => parseLegacySignalBackfillArgs(['--source', 'x']), /Unsupported backfill source/)
})

function signal(id: string, observedAt = NOW): Extract<Signal, { sourceType: 'news' }> {
  return {
    schemaVersion: 'myboon.signal.v1', signalId: `sig-backfill-${id}`, sourceType: 'news',
    contentKind: 'article', content: { schemaVersion: 'myboon.signal_content.article.v1' },
    sourceId: `legacy:${id}`, observedAt, publishedAt: null,
    canonicalUrl: `https://example.com/${id}`, title: `Legacy ${id}`, visibleSummary: 'Historical context.',
    media: { imageUrl: null, attribution: null },
    sourceHints: { entities: [], assets: [], eventId: null, deadline: null },
    provenance: { provider: 'legacy_news', upstreamSource: null, rawPayloadRef: id },
    idempotencyKey: `legacy:${id}`,
  }
}

function reader(items: LegacySignalBackfillCandidate[]): LegacySignalBackfillReadPort {
  return {
    sourceType: 'news',
    async list(input) {
      return items.filter((item) => (!input.filters.legacyId || item.legacyId === input.filters.legacyId)
        && (!input.filters.since || item.observedAt >= input.filters.since)
        && (!input.filters.until || item.observedAt < input.filters.until)
        && (!input.filters.after || (
          item.observedAt.localeCompare(input.filters.after.observedAt)
          || item.sourceType.localeCompare(input.filters.after.sourceType)
          || item.legacyId.localeCompare(input.filters.after.legacyId)
        ) > 0))
        .sort((left, right) => left.observedAt.localeCompare(right.observedAt)
          || left.sourceType.localeCompare(right.sourceType)
          || left.legacyId.localeCompare(right.legacyId))
        .slice(0, input.limit)
    },
  }
}

test('legacy backfill is bounded, filtered, dry-run by default, and performs no writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'backfill-dry-'))
  const store = new SqliteSignalPlatformStore(join(dir, 'news.sqlite'), 'news')
  try {
    const intake = createActiveSourceTriageIntake({
      store, mode: 'observe', providerHealth: 'unavailable', clock: () => NOW,
      capacity: { snapshot: () => {
        const bucket = { available: 100, reservedAvailable: 10, utilization: 0 }
        return {
          byPriority: { P0: { ...bucket }, P1: { ...bucket }, P2: { ...bucket }, P3: { ...bucket } },
          byDepth: { light: { ...bucket }, standard: { ...bucket }, deep: { ...bucket } },
        }
      } },
    })
    const items = ['a', 'b', 'c'].map((id, index) => {
      const observedAt = `2026-08-26T${String(index + 8).padStart(2, '0')}:00:00.000Z`
      return { sourceType: 'news' as const, legacyId: id, observedAt, signal: signal(id, observedAt) }
    })
    const operator = new LegacySignalBackfillOperator({
      readers: [reader(items)], intakes: [{ sourceType: 'news', intake }],
    })
    const report = await operator.run({ now: NOW, batchSize: 1, filters: { since: '2026-08-26T08:30:00.000Z' } })
    assert.equal(report.schemaVersion, BACKFILL_OPERATION_SCHEMA_VERSION)
    assert.equal(report.mode, 'dry_run')
    assert.equal(report.matchedCount, 1)
    assert.equal(report.truncated, true)
    assert.ok(report.nextCursor)
    assert.equal(report.rows[0]?.legacyId, 'b')
    assert.equal(report.rows[0]?.triageOutcome, 'defer')
    assert.equal(store.getSignal(signal('b').signalId), null)
  } finally {
    store.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('composite continuation advances same-timestamp batches and replays each page idempotently', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'backfill-cursor-'))
  const store = new SqliteSignalPlatformStore(join(dir, 'news.sqlite'), 'news')
  try {
    const bucket = { available: 100, reservedAvailable: 10, utilization: 0 }
    const intake = createActiveSourceTriageIntake({
      store, mode: 'observe', providerHealth: 'healthy', clock: () => NOW,
      capacity: { snapshot: () => ({
        byPriority: { P0: { ...bucket }, P1: { ...bucket }, P2: { ...bucket }, P3: { ...bucket } },
        byDepth: { light: { ...bucket }, standard: { ...bucket }, deep: { ...bucket } },
      }) },
    })
    const candidates = ['a', 'b', 'c'].map((id) => ({
      sourceType: 'news' as const, legacyId: id, observedAt: NOW, signal: signal(id),
    }))
    const operator = new LegacySignalBackfillOperator({
      readers: [reader(candidates)], intakes: [{ sourceType: 'news', intake }],
    })
    const backupReceipt = { receiptId: 'backup', verified: true as const, verifiedAt: NOW, sources: ['news' as const] }

    const first = await operator.run({ apply: true, now: NOW, batchSize: 1, backupReceipt })
    assert.equal(first.rows[0]?.legacyId, 'a')
    assert.ok(first.nextCursor)
    const afterFirst = decodeLegacySignalBackfillCursor(first.nextCursor!)
    assert.deepEqual(afterFirst, {
      schemaVersion: 'myboon.signal_backfill_cursor.v1', observedAt: NOW, sourceType: 'news', legacyId: 'a',
    })

    const secondCommand = { apply: true, now: NOW, batchSize: 1, backupReceipt, filters: { after: afterFirst } }
    const second = await operator.run(secondCommand)
    assert.equal(second.rows[0]?.legacyId, 'b')
    const replay = await operator.run(secondCommand)
    assert.equal(replay.operationId, second.operationId)
    assert.equal(replay.rows[0]?.outcome, 'duplicate')
    assert.equal(store.getSignal(signal('c').signalId), null)

    const third = await operator.run({
      apply: true, now: NOW, batchSize: 1, backupReceipt,
      filters: { after: decodeLegacySignalBackfillCursor(second.nextCursor!) },
    })
    assert.equal(third.rows[0]?.legacyId, 'c')
    assert.equal(third.nextCursor, null)
    assert.ok(store.getSignal(signal('a').signalId))
    assert.ok(store.getSignal(signal('b').signalId))
    assert.ok(store.getSignal(signal('c').signalId))
  } finally {
    store.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('apply is backup-gated, appends Signal+triage only, and repeated apply is idempotent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'backfill-apply-'))
  const store = new SqliteSignalPlatformStore(join(dir, 'news.sqlite'), 'news')
  try {
    const intake = createActiveSourceTriageIntake({
      store, mode: 'observe', providerHealth: 'unavailable', clock: () => NOW,
      capacity: { snapshot: () => {
        const bucket = { available: 0, reservedAvailable: 0, utilization: 1 }
        return {
          byPriority: { P0: { ...bucket }, P1: { ...bucket }, P2: { ...bucket }, P3: { ...bucket } },
          byDepth: { light: { ...bucket }, standard: { ...bucket }, deep: { ...bucket } },
        }
      } },
    })
    const candidate = { sourceType: 'news' as const, legacyId: 'one', observedAt: NOW, signal: signal('one') }
    const withoutBackup = new LegacySignalBackfillOperator({
      readers: [reader([candidate])], intakes: [{ sourceType: 'news', intake }],
    })
    await assert.rejects(() => withoutBackup.run({ apply: true, now: NOW }), /verified backup/)
    assert.equal(store.getSignal(candidate.signal.signalId), null)

    const operator = new LegacySignalBackfillOperator({
      readers: [reader([candidate])], intakes: [{ sourceType: 'news', intake }],
      backupPort: { createVerifiedBackup: async () => ({
        receiptId: 'backup-1', verified: true, verifiedAt: NOW, sources: ['news'],
      }) },
    })
    const first = await operator.run({ apply: true, now: NOW, operationId: 'backfill-one' })
    assert.equal(first.rows[0]?.outcome, 'inserted')
    assert.equal(first.rows[0]?.signalInserted, true)
    assert.equal(first.rows[0]?.decisionInserted, true)
    assert.equal(store.listTriageDecisionsBySignal(candidate.signal.signalId, 10).length, 1)
    assert.equal((await store.getSchedulerStatus({ now: NOW })).total, 0)

    const replay = await operator.run({ apply: true, now: NOW, operationId: 'backfill-one' })
    assert.equal(replay.rows[0]?.outcome, 'duplicate')
    assert.equal(replay.rows[0]?.signalInserted, false)
    assert.equal(replay.rows[0]?.decisionInserted, false)
    assert.equal(store.listTriageDecisionsBySignal(candidate.signal.signalId, 10).length, 1)
  } finally {
    store.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('failed apply rows are redacted and isolated', async () => {
  const candidate = { sourceType: 'news' as const, legacyId: 'secret', observedAt: NOW, signal: signal('secret') }
  const operator = new LegacySignalBackfillOperator({
    readers: [reader([candidate])],
    intakes: [{ sourceType: 'news', intake: {
      mode: 'observe', ingest: async () => { throw new Error('SUPABASE_SERVICE_ROLE_KEY=secret') },
    } }],
  })
  const report = await operator.run({
    apply: true, now: NOW,
    backupReceipt: { receiptId: 'backup', verified: true, verifiedAt: NOW, sources: ['news'] },
  })
  assert.equal(report.rows[0]?.errorCode, 'CANONICAL_BACKFILL_FAILED')
  assert.doesNotMatch(JSON.stringify(report), /SERVICE_ROLE|=secret/)
})
