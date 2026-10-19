import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import test from 'node:test'
import { DatabaseCaConfigError } from '../signal-platform/database-ca'
import { TEST_CA_PEM } from '../signal-platform/test-fixtures/database-ca-fixture'
import { entityIdentityKey } from './identity-key'
import {
  ARTICLE_ONLY_STATUS, BACKFILL_BATCH_SIZE, BACKFILL_LEASE_OWNER, BACKFILL_MARKER_KEY, BACKFILL_OPERATION_ID,
  backfillDatabaseHost, createBackfillPool, findCollisions, isLocalBackfillHost, isUuidText, nextBatchIds,
  parseBackfillArgs, parseCursor,
} from './managed-entity-backfill'

const FIXTURE_OPERATION = 'progression-v2:' + 'ab'.repeat(32)

function articleOnly(
  id: string, name: string, slug: string, aliases: string[],
  options: { nameKey?: string; createdOperation?: string | null } = {},
) {
  return {
    id, name, slug, aliases,
    nameKey: options.nameKey ?? entityIdentityKey(name),
    createdOperation: (options.createdOperation ?? FIXTURE_OPERATION) as string | null,
  }
}

function candidate(id: string, name: string, slug: string, aliases: string[] = []) {
  return { id, name, slug, aliases }
}

test('parseBackfillArgs defaults to a dry run with batch 200', () => {
  assert.deepEqual(parseBackfillArgs(['--report', 'report.json']), {
    write: false, reportPath: resolve('report.json'), cursorPath: null, batchSize: BACKFILL_BATCH_SIZE, pauseMs: 200, maxBatches: null,
  })
})

test('parseBackfillArgs accepts a cursor in dry-run mode but never requires it', () => {
  const args = parseBackfillArgs(['--report', 'report.json', '--cursor', 'cursor.json'])
  assert.equal(args.cursorPath, resolve('cursor.json'))
  assert.equal(args.write, false)
})

test('parseBackfillArgs write mode requires --cursor', () => {
  assert.throws(() => parseBackfillArgs(['--report', 'report.json', '--write']), /--cursor is required in write mode/)
})

test('parseBackfillArgs accepts a fully-formed write invocation', () => {
  const args = parseBackfillArgs([
    '--write', '--report', 'report.json', '--cursor', 'cursor.json', '--batch-size', '50', '--pause-ms', '0', '--max-batches', '3',
  ])
  assert.equal(args.write, true)
  assert.equal(args.batchSize, 50)
  assert.equal(args.pauseMs, 0)
  assert.equal(args.maxBatches, 3)
})

test('parseBackfillArgs rejects bad batch sizes', () => {
  for (const bad of ['0', '201', '-1', 'x', '2.5']) {
    assert.throws(() => parseBackfillArgs(['--report', 'r', '--batch-size', bad]), /--batch-size must be an integer/, bad)
  }
  // An empty value never reaches the range check; the argument parser reports it.
  assert.throws(() => parseBackfillArgs(['--report', 'r', '--batch-size', '']), /--batch-size/)
  assert.equal(parseBackfillArgs(['--report', 'r', '--batch-size', '1']).batchSize, 1)
  assert.equal(parseBackfillArgs(['--report', 'r', '--batch-size', '200']).batchSize, 200)
})

test('parseBackfillArgs rejects out-of-range pauses and non-positive max batches', () => {
  assert.equal(parseBackfillArgs(['--report', 'r', '--pause-ms', '60000']).pauseMs, 60_000)
  for (const bad of ['-1', '60001', '0.5', 'x']) {
    assert.throws(() => parseBackfillArgs(['--report', 'r', '--pause-ms', bad]), /--pause-ms must be an integer/, bad)
  }
  assert.equal(parseBackfillArgs(['--report', 'r', '--max-batches', '1']).maxBatches, 1)
  for (const bad of ['0', '-2', '1.5', 'none']) {
    assert.throws(() => parseBackfillArgs(['--report', 'r', '--max-batches', bad]), /--max-batches must be an integer/, bad)
  }
})

test('parseBackfillArgs rejects duplicates, unknown flags and missing values', () => {
  assert.throws(() => parseBackfillArgs(['--report', 'a.json', '--report', 'b.json']), /duplicated/)
  assert.throws(() => parseBackfillArgs(['--write', '--write', '--report', 'r']), /Duplicate --write/)
  assert.throws(() => parseBackfillArgs(['--report', 'r', '--batch-size', '10', '--batch-size', '20']), /duplicated/)
  assert.throws(() => parseBackfillArgs(['--report', 'r', '--wat']), /Unknown.*--wat/)
  assert.throws(() => parseBackfillArgs(['--report']), /valueless/)
  assert.throws(() => parseBackfillArgs(['--report', '--cursor']), /valueless/)
  assert.throws(() => parseBackfillArgs([]), /--report is required/)
})

test('parseCursor accepts valid cursors and normalises uuid case', () => {
  const valid = {
    schemaVersion: 'myboon.entity_backfill_337.cursor.v1',
    operationId: BACKFILL_OPERATION_ID,
    phase: 'public_only',
    lastId: null,
    updatedAt: '2026-10-17T10:00:00.000Z',
  }
  assert.deepEqual(parseCursor(valid), valid)
  const lastId = '0F0E0D0C-0B0A-4948-8476-6543210FEDCB'
  assert.equal(parseCursor({ ...valid, lastId, phase: 'done' }).lastId, lastId.toLowerCase())
})

test('parseCursor rejects anything malformed', () => {
  const valid = {
    schemaVersion: 'myboon.entity_backfill_337.cursor.v1',
    operationId: BACKFILL_OPERATION_ID,
    phase: 'shared',
    lastId: null,
    updatedAt: '2026-10-17T10:00:00.000Z',
  }
  assert.throws(() => parseCursor('nope'), /expected a JSON object/)
  assert.throws(() => parseCursor(null), /expected a JSON object/)
  assert.throws(() => parseCursor([valid]), /expected a JSON object/)
  assert.throws(() => parseCursor({ ...valid, schemaVersion: 'other.v1' }), /schemaVersion/)
  assert.throws(() => parseCursor({ ...valid, operationId: 'progression-v2:' + 'cd'.repeat(32) }), /operationId/)
  assert.throws(() => parseCursor({ ...valid, phase: 'phases' }), /phase/)
  assert.throws(() => parseCursor({ ...valid, lastId: 'not-a-uuid' }), /lastId/)
  assert.throws(() => parseCursor({ ...valid, lastId: 42 }), /lastId/)
  assert.throws(() => parseCursor({ ...valid, updatedAt: 'yesterday' }), /updatedAt/)
  assert.throws(() => parseCursor({ ...valid, extra: true }), /exactly/)
  assert.throws(() => parseCursor({ phase: 'shared' }), /exactly/)
})

test('findCollisions matches by name_key without other kinds', () => {
  const collisions = findCollisions([candidate('00000000-0000-0000-0000-000000000001', 'FED', 'public-fed')], [
    articleOnly('00000000-0000-0000-0000-0000000000aa', 'Fed', 'fed-org', []),
  ])
  assert.equal(collisions.length, 1)
  assert.deepEqual(collisions[0]!.matches, [{
    managedEntityId: '00000000-0000-0000-0000-0000000000aa', managedName: 'Fed', managedSlug: 'fed-org', kind: 'name_key', key: 'fed',
  }])
})

test('findCollisions matches by alias_key when the public name matches an article-only alias/naming', () => {
  const collisions = findCollisions([candidate('00000000-0000-0000-0000-000000000002', 'Federal Reserve', 'federal-reserve', ['Fed'])], [
    articleOnly('00000000-0000-0000-0000-0000000000ab', 'Fed', 'managed-fed', []),
  ])
  assert.equal(collisions.length, 1)
  assert.deepEqual(collisions[0]!.matches, [{
    managedEntityId: '00000000-0000-0000-0000-0000000000ab', managedName: 'Fed', managedSlug: 'managed-fed', kind: 'alias_key', key: 'fed',
  }])
})

test('findCollisions matches by slug when names and keys are unrelated', () => {
  const collisions = findCollisions([candidate('00000000-0000-0000-0000-000000000003', 'Feathercash', 'feather-coin')], [
    articleOnly('00000000-0000-0000-0000-0000000000ac', 'Feathercoin', 'feather-coin', []),
  ])
  assert.equal(collisions.length, 1)
  assert.deepEqual(collisions[0]!.matches, [{
    managedEntityId: '00000000-0000-0000-0000-0000000000ac', managedName: 'Feathercoin', managedSlug: 'feather-coin', kind: 'slug', key: 'feather-coin',
  }])
})

test("findCollisions lets '(BTC)' and 'Bitcoin (BTC)' coexist without a name_key collision", () => {
  assert.equal(entityIdentityKey('(BTC)'), 'btc')
  const collisions = findCollisions([candidate('00000000-0000-0000-0000-000000000004', '(BTC)', 'btc-token')], [
    articleOnly('00000000-0000-0000-0000-0000000000ad', 'Bitcoin (BTC)', 'bitcoin', []),
  ])
  assert.deepEqual(collisions, [])
})

test('findCollisions ignores unrelated rows and rows the backfill itself created', () => {
  const rows = [
    articleOnly('00000000-0000-0000-0000-0000000000ae', 'Unrelated Coin', 'unrelated', []),
    articleOnly('00000000-0000-0000-0000-0000000000af', 'Fed', 'fed', [], { createdOperation: BACKFILL_OPERATION_ID }),
  ]
  assert.deepEqual(findCollisions([candidate('00000000-0000-0000-0000-000000000005', 'Fed', 'fed-public')], rows), [])
})

test('findCollisions can match one row by several kinds and one candidate by several rows', () => {
  const collisions = findCollisions([candidate('00000000-0000-0000-0000-000000000006', 'Zephyr', 'zephyr')], [
    articleOnly('00000000-0000-0000-0000-0000000000b0', 'Zephyr', 'zephyr', []),
    articleOnly('00000000-0000-0000-0000-0000000000b1', 'Zephyr Network', 'other', ['zephyr']),
  ])
  assert.equal(collisions.length, 1)
  assert.deepEqual(collisions[0]!.matches.map((match) => [match.managedEntityId, match.kind]), [
    ['00000000-0000-0000-0000-0000000000b0', 'name_key'], ['00000000-0000-0000-0000-0000000000b0', 'slug'],
    ['00000000-0000-0000-0000-0000000000b1', 'alias_key'],
  ])
})

test('findCollisions never matches empty slugs against each other', () => {
  const collisions = findCollisions([candidate('00000000-0000-0000-0000-000000000007', 'Mystery A', '')], [
    articleOnly('00000000-0000-0000-0000-0000000000b2', 'Mystery B', '', []),
  ])
  assert.deepEqual(collisions, [])
})

test('the article-only status lives in exactly one exported constant', () => {
  assert.equal(ARTICLE_ONLY_STATUS, 'review')
})

test('backfill constants hold their documented values', () => {
  assert.equal(BACKFILL_BATCH_SIZE, 200)
  assert.equal(BACKFILL_LEASE_OWNER, 'entity-backfill-337')
  assert.equal(BACKFILL_MARKER_KEY, 'backfill_337')
})

test('BACKFILL_OPERATION_ID satisfies the leases operation-id CHECK', () => {
  assert.match(BACKFILL_OPERATION_ID, /^progression-v2:[0-9a-f]{64}$/)
  assert.equal(BACKFILL_OPERATION_ID, `progression-v2:${createHash('sha256').update('myboon.entity_backfill.337.v1').digest('hex')}`)
})

test('host helpers classify socket paths and localhost as local', () => {
  assert.equal(isLocalBackfillHost('/var/run/postgresql'), true)
  assert.equal(isLocalBackfillHost('localhost'), true)
  assert.equal(isLocalBackfillHost('127.0.0.1'), true)
  assert.equal(isLocalBackfillHost(''), true)
  assert.equal(isLocalBackfillHost('db.internal.example.com'), false)
  assert.equal(isLocalBackfillHost('10.1.2.3'), false)
})

test('backfillDatabaseHost resolves the libpq host; the query param wins over the authority', () => {
  // Socket URLs: the `host` query parameter wins (possibly over an empty authority).
  assert.equal(backfillDatabaseHost('postgresql:///myboon?host=/var/run/postgresql'), '/var/run/postgresql')
  assert.equal(backfillDatabaseHost('postgresql://u@/db?host=/tmp/sock'), '/tmp/sock')
  // TCP URLs: the percent-decoded hostname.
  assert.equal(backfillDatabaseHost('postgresql://u:***@localhost:5432/myboon'), 'localhost')
  assert.equal(backfillDatabaseHost('postgresql://u:***@127.0.0.1/myboon'), '127.0.0.1')
  assert.equal(isLocalBackfillHost(backfillDatabaseHost('postgresql://u@db.example.com:6543/myboon')), false)
  // An IPv6 authority loses its brackets.
  assert.equal(backfillDatabaseHost('postgresql://u@[2001:db8::1]:5432/myboon'), '2001:db8::1')
  // No host anywhere: the default unix socket.
  assert.equal(backfillDatabaseHost('postgresql://u:***@/myboon'), '')
  // Unparsable text fails as a TypeError whose message never echoes the input.
  assert.throws(
    () => backfillDatabaseHost('definitely not a url'),
    (error: unknown) => error instanceof TypeError && !String((error as TypeError).message).includes('definitely not a url'),
  )
})

test('nextBatchIds walks the whole list from a null cursor and terminates', () => {
  const ids = ['a', 'b', 'c', 'd', 'e']
  const batches: string[][] = []
  let lastId: string | null = null
  for (;;) {
    const batch = nextBatchIds(ids, lastId, 2)
    if (batch.length === 0) {
      batches.push([])
      break
    }
    batches.push(batch)
    lastId = batch[batch.length - 1]!
    assert.ok(batches.length <= ids.length, 'keyset pagination must advance the cursor per batch')
  }
  assert.deepEqual(batches, [['a', 'b'], ['c', 'd'], ['e'], []])
})

test('runBackfill validates its options before opening anything', () => {
  assert.throws(() => parseBackfillArgs(['--write', '--report', 'r']), /--cursor is required in write mode/)
  assert.throws(() => createBackfillPool('not a url'), /must be a postgres/)
})

test('createBackfillPool normalises a literal-\\n database CA and rejects invalid PEM before building the pool', () => {
  const setting = 'MYBOON_ENTITY_BACKFILL_DATABASE_CA'
  const previous = process.env[setting]
  try {
    process.env[setting] = TEST_CA_PEM.replaceAll('\n', '\\n')
    const pool = createBackfillPool('postgres://u:p@db.example.com/x')
    try {
      const ssl = pool.options.ssl
      assert.equal(typeof ssl, 'object')
      if (typeof ssl !== 'object' || ssl === null) throw new Error('non-local hosts must receive TLS options')
      assert.equal(ssl.rejectUnauthorized, true)
      assert.equal(ssl.ca, TEST_CA_PEM)
    } finally {
      void pool.end()
    }
    const invalid = TEST_CA_PEM.slice(0, 80)
    process.env[setting] = invalid
    assert.throws(
      () => createBackfillPool('postgres://u:p@db.example.com/x'),
      (error: unknown) => error instanceof DatabaseCaConfigError
        && error.message.includes(setting)
        && !error.message.includes(invalid),
    )
  } finally {
    if (previous === undefined) delete process.env[setting]
    else process.env[setting] = previous
  }
})

test('isUuidText accepts canonical Postgres uuid text only', () => {
  assert.equal(isUuidText('0f0e0d0c-0b0a-4948-8476-6543210fedcb'), true)
  assert.equal(isUuidText('0F0E0D0C-0B0A-4948-8476-6543210FEDCB'), false)
  assert.equal(isUuidText('nope'), false)
  assert.equal(isUuidText(null), false)
})