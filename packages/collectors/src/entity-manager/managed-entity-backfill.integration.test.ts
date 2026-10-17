import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Pool } from 'pg'
import {
  ARTICLE_ONLY_STATUS, BACKFILL_MARKER_KEY, BACKFILL_OPERATION_ID, backfillDatabaseHost, isLocalBackfillHost,
  parseCursor, runBackfill,
} from './managed-entity-backfill'

// #337 PR-B integration check against a disposable local database with ALL
// migrations (including 20261017120000) applied and no other data required.
// The test refuses to talk to anything that is not a unix socket or localhost.
const DATABASE_URL = process.env.MYBOON_BACKFILL_337_TEST_DATABASE_URL?.trim() ?? ''

const FIXTURE_OPERATION = 'progression-v2:' + 'ab'.repeat(32)

type PublicSeed = {
  id: string; slug: string; name: string; type: string; aliases: string[]
  summary: string; status: string; showInCarousel: boolean; metadata: Record<string, unknown>
}
type ManagedSeed = {
  id: string; identityKey: string; catalogEntityId: string | null; createdOperation: string
  name: string; slug: string; type: string; aliases: string[]
  summary: string; status: string; showInCarousel: boolean; metadata: Record<string, unknown>
}

type ManagedStateRow = {
  id: string; name: string; slug: string; summary: string | null; status: string; show_in_carousel: boolean
  metadata: Record<string, unknown>; catalog_entity_id: string | null; identity_key: string; created_operation: string
}
type SnapshotRow = { digest: string }
type CountRow = { count: string }

async function insertPublic(pool: Pool, seed: PublicSeed): Promise<void> {
  await pool.query(
    `INSERT INTO public.entities (id, slug, name, type, aliases, summary, status, show_in_carousel, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb)`,
    [seed.id, seed.slug, seed.name, seed.type, JSON.stringify(seed.aliases), seed.summary, seed.status, seed.showInCarousel, JSON.stringify(seed.metadata)],
  )
}

async function insertManaged(pool: Pool, seed: ManagedSeed): Promise<void> {
  await pool.query(
    `INSERT INTO managed_knowledge_private.entities
       (id, identity_key, catalog_entity_id, binding, created_operation, revision,
        name, slug, type, aliases, summary, status, show_in_carousel, metadata, updated_at)
     VALUES ($1, $2, $3, '{}'::jsonb, $4, 1,
             $5, $6, $7, $8::jsonb, $9, $10, $11, $12::jsonb, clock_timestamp())`,
    [seed.id, seed.identityKey, seed.catalogEntityId, seed.createdOperation,
      seed.name, seed.slug, seed.type, JSON.stringify(seed.aliases), seed.summary, seed.status, seed.showInCarousel, JSON.stringify(seed.metadata)],
  )
}

/** md5 over every managed entity and every lease row; stable ordering via string_agg. */
async function snapshotDigest(pool: Pool): Promise<string> {
  const result = await pool.query<SnapshotRow>(
    `SELECT md5(coalesce(string_agg(line, chr(10) ORDER BY line), '')) AS digest
     FROM (
       SELECT 'entity:' || (to_jsonb(m)::text) AS line FROM managed_knowledge_private.entities m
       UNION ALL
       SELECT 'lease:' || (to_jsonb(l)::text) AS line FROM managed_knowledge_private.leases l
     ) snapshot_lines`,
  )
  return result.rows[0]!.digest
}

async function readCursorFile(path: string): Promise<unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

async function readReportFile(path: string): Promise<unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

test('managed entity backfill #337 PR-B seeds, imports, flags and stays idempotent on a disposable local database', {
  skip: DATABASE_URL === '',
  timeout: 120_000,
}, async () => {
  const host = backfillDatabaseHost(DATABASE_URL)
  // A remote URL is a hard refusal, not a skip: the fixture is only defined
  // for a disposable local database seeded directly as the connected role.
  if (!isLocalBackfillHost(host)) {
    throw new Error(`Refusing MYBOON_BACKFILL_337_TEST_DATABASE_URL: host "${host}" is neither a unix socket path nor localhost/127.0.0.1`)
  }
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4, application_name: 'myboon_entity_backfill_337_test' })
  const runDir = join(tmpdir(), `managed-entity-backfill-337-${randomUUID()}`)
  mkdirSync(runDir, { recursive: true })
  const reportPath = join(runDir, 'report.json')
  const cursorPath = join(runDir, 'cursor.json')

  const linkedAlphaPublic = randomUUID()
  const linkedBetaPublic = randomUUID()
  const solanaPublic = randomUUID()
  const featherPublic = randomUUID()
  const quillonPublic = randomUUID()
  const zephyrPublic = randomUUID()
  const zephyrAltPublic = randomUUID()
  const linkedAlphaManaged = randomUUID()
  const linkedBetaManaged = randomUUID()
  const solanaManaged = randomUUID()
  const featherManaged = randomUUID()

  const seededPublicIds = [linkedAlphaPublic, linkedBetaPublic, solanaPublic, featherPublic, quillonPublic, zephyrPublic, zephyrAltPublic]
  const seededManagedIds = [linkedAlphaManaged, linkedBetaManaged, solanaManaged, featherManaged]
  // The three clean public-only candidates the backfill inserts (their managed
  // id equals the catalogue id), plus the fixture ids, for best-effort cleanup.
  const backfillCreatedManagedIds = [quillonPublic, zephyrPublic, zephyrAltPublic]

  try {
    await pool.query(
      'INSERT INTO managed_knowledge_private.leases (operation_id, owner, epoch, expires_at) VALUES ($1, $2, 1, clock_timestamp())',
      [FIXTURE_OPERATION, 'backfill-337-integration-fixture'],
    )
    for (const seed of [
      { id: linkedAlphaPublic, slug: 'alpha-industries', name: 'Alpha Industries', type: 'company', aliases: ['Alpha Corp'], summary: 'Public alpha summary', status: 'active', showInCarousel: true, metadata: { images: ['alpha.png'], tags: ['industrial'] } },
      { id: linkedBetaPublic, slug: 'beta-systems', name: 'Beta Systems', type: 'company', aliases: [], summary: 'Public beta summary', status: 'active', showInCarousel: false, metadata: { tags: ['beta'] } },
      { id: solanaPublic, slug: 'solana-labs', name: 'Solana', type: 'cryptocurrency', aliases: [], summary: 'Public solana', status: 'active', showInCarousel: true, metadata: { tags: ['sol'] } },
      { id: featherPublic, slug: 'feather-coin', name: 'Feathercash', type: 'cryptocurrency', aliases: [], summary: 'Public feathercash', status: 'active', showInCarousel: false, metadata: {} },
      { id: quillonPublic, slug: 'quillon-labs', name: 'Quillon Technologies', type: 'company', aliases: [], summary: 'Public quillon', status: 'active', showInCarousel: true, metadata: { tags: ['quillon'] } },
      { id: zephyrPublic, slug: 'zephyr', name: 'Zephyr', type: 'cryptocurrency', aliases: [], summary: 'Public zephyr', status: 'active', showInCarousel: false, metadata: {} },
      { id: zephyrAltPublic, slug: 'zephyr-zep', name: 'Zephyr (ZEP)', type: 'cryptocurrency', aliases: [], summary: 'Public zephyr alt', status: 'active', showInCarousel: false, metadata: {} },
    ] satisfies PublicSeed[]) {
      await insertPublic(pool, seed)
    }
    for (const seed of [
      // Linked rows seeded like #368 leaves them: identity equal to the
      // catalogue, but summary/carousel/metadata drifted from it.
      { id: linkedAlphaManaged, identityKey: `catalog:${linkedAlphaPublic}`, catalogEntityId: linkedAlphaPublic, createdOperation: FIXTURE_OPERATION, name: 'Alpha Industries', slug: 'alpha-industries', type: 'company', aliases: ['Alpha Corp'], summary: 'Stale alpha summary', status: 'active', showInCarousel: false, metadata: { stale: true } },
      { id: linkedBetaManaged, identityKey: `catalog:${linkedBetaPublic}`, catalogEntityId: linkedBetaPublic, createdOperation: FIXTURE_OPERATION, name: 'Beta Systems', slug: 'beta-systems', type: 'company', aliases: [], summary: 'Stale beta summary', status: 'active', showInCarousel: true, metadata: { stale: true } },
      // Article-only rows: a name-key collider ('Solana') and a slug collider
      // ('feather-coin'), both still active, both created by the fixture lease.
      { id: solanaManaged, identityKey: `article:${solanaManaged}`, catalogEntityId: null, createdOperation: FIXTURE_OPERATION, name: 'Solana', slug: 'solana-token', type: 'cryptocurrency', aliases: [], summary: 'Managed solana', status: 'active', showInCarousel: false, metadata: {} },
      { id: featherManaged, identityKey: `article:${featherManaged}`, catalogEntityId: null, createdOperation: FIXTURE_OPERATION, name: 'Feathercoin', slug: 'feather-coin', type: 'cryptocurrency', aliases: [], summary: 'Managed feathercoin', status: 'active', showInCarousel: false, metadata: {} },
    ] satisfies ManagedSeed[]) {
      await insertManaged(pool, seed)
    }

    // 1. Dry run: counts as expected, nothing written, snapshot identical.
    const digestBeforeDry = await snapshotDigest(pool)
    const dryReport = await runBackfill({ pool, write: false, reportPath, cursorPath, batchSize: 2, pauseMs: 0 })
    assert.equal(dryReport.mode, 'dry_run')
    assert.equal(dryReport.status, 'complete')
    assert.deepEqual(dryReport.counts, {
      publicEntities: 7, managedEntities: 4, linkedManaged: 2, articleOnlyManaged: 2,
      publicOnlyCandidates: 5, collisionsSkipped: 2, sharedUpdated: 2, publicOnlyInserted: 2 + 1, articleOnlyFlagged: 2, batchesWritten: 0,
    })
    assert.equal(dryReport.collisions.length, 2)
    assert.deepEqual(
      dryReport.collisions.map((collision) => [collision.publicEntityId, collision.matches[0]!.kind, collision.matches[0]!.key]).sort(),
      [[solanaPublic, 'name_key', 'solana'], [featherPublic, 'slug', 'feather-coin']].sort(),
    )
    assert.equal(dryReport.nameKeyParityMismatches.length, 0)
    assert.deepEqual(dryReport.publicNameKeyDuplicates, [{ key: 'zephyr', publicEntityIds: [zephyrPublic, zephyrAltPublic].sort() }])
    assert.deepEqual(dryReport.warnings, [])
    assert.equal(dryReport.cursor, null)
    assert.equal(dryReport.error, null)
    assert.equal(await snapshotDigest(pool), digestBeforeDry)
    // The dry run accepted a cursor path but must never have written it.
    assert.throws(() => readFileSync(cursorPath), /ENOENT/)

    // 2. Write with maxBatches 1: one shared batch commits, then partial stop.
    const partialReport = await runBackfill({ pool, write: true, reportPath, cursorPath, batchSize: 2, pauseMs: 0, maxBatches: 1 })
    assert.equal(partialReport.status, 'partial')
    assert.deepEqual(partialReport.counts, {
      publicEntities: 7, managedEntities: 4, linkedManaged: 2, articleOnlyManaged: 2,
      publicOnlyCandidates: 5, collisionsSkipped: 2, sharedUpdated: 2, publicOnlyInserted: 0, articleOnlyFlagged: 0, batchesWritten: 1,
    })
    assert.equal(partialReport.cursor?.phase, 'shared')
    assert.equal(partialReport.cursor?.lastId, [linkedAlphaManaged, linkedBetaManaged].sort()[1])
    const persistedCursor = parseCursor(await readCursorFile(cursorPath))
    assert.equal(persistedCursor.phase, 'shared')
    assert.equal(persistedCursor.lastId, partialReport.cursor!.lastId)
    const persistedPartial = await readReportFile(reportPath) as { status: string }
    assert.equal(persistedPartial.status, 'partial')

    // 3. Resume: completes; linked rows carry the public overlay columns, clean
    // candidates are inserted with trigger-filled columns, colliders stay out,
    // article-only rows move to review with the marker.
    const resumeReport = await runBackfill({ pool, write: true, reportPath, cursorPath, batchSize: 2, pauseMs: 0 })
    assert.equal(resumeReport.status, 'complete')
    assert.equal(resumeReport.counts.sharedUpdated, 0)
    assert.equal(resumeReport.counts.publicOnlyInserted, 3)
    assert.equal(resumeReport.counts.articleOnlyFlagged, 2)
    // Resume from the partial run: shared was fully done (2 ids, 1 committed
    // batch at batchSize 2), so the resume walk is public_only 3 ids = 2
    // batches plus article_only 2 ids = 1 batch.
    assert.equal(resumeReport.counts.batchesWritten, 3)
    assert.equal(resumeReport.collisions.length, 2)
    assert.equal(resumeReport.cursor?.phase, 'done')
    assert.equal(parseCursor(await readCursorFile(cursorPath)).phase, 'done')

    const linkedStates = await pool.query<ManagedStateRow>(
      'SELECT * FROM managed_knowledge_private.entities WHERE id = ANY($1::uuid[]) ORDER BY id', [seededManagedIds],
    )
    assert.equal(linkedStates.rows.length, 4)
    const stateById = new Map(linkedStates.rows.map((row) => [row.id, row]))
    assert.equal(stateById.get(linkedAlphaManaged)!.summary, 'Public alpha summary')
    assert.equal(stateById.get(linkedAlphaManaged)!.show_in_carousel, true)
    assert.deepEqual(stateById.get(linkedAlphaManaged)!.metadata, { images: ['alpha.png'], tags: ['industrial'] })
    assert.equal(stateById.get(linkedBetaManaged)!.summary, 'Public beta summary')
    assert.equal(stateById.get(linkedBetaManaged)!.show_in_carousel, false)
    assert.deepEqual(stateById.get(linkedBetaManaged)!.metadata, { tags: ['beta'] })
    // Identity columns of linked rows are never touched by the backfill.
    assert.equal(stateById.get(linkedAlphaManaged)!.name, 'Alpha Industries')

    const insertedStates = await pool.query<ManagedStateRow>(
      `SELECT * FROM managed_knowledge_private.entities WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[quillonPublic, zephyrPublic, zephyrAltPublic]],
    )
    assert.equal(insertedStates.rows.length, 3)
    const insertedByPublicId = new Map(insertedStates.rows.map((row) => [row.id, row]))
    const quillon = insertedByPublicId.get(quillonPublic)!
    assert.equal(quillon.catalog_entity_id, quillonPublic)
    assert.equal(quillon.identity_key, `catalog:${quillonPublic}`)
    assert.equal(quillon.name, 'Quillon Technologies')
    assert.equal(quillon.slug, 'quillon-labs')
    assert.equal(quillon.summary, 'Public quillon')
    assert.equal(quillon.show_in_carousel, true)
    assert.equal(quillon.status, 'active')
    assert.equal(quillon.created_operation, BACKFILL_OPERATION_ID)
    const zephyrInserted = insertedByPublicId.get(zephyrPublic)!
    assert.equal(zephyrInserted.identity_key, `catalog:${zephyrPublic}`)
    assert.equal(zephyrInserted.name, 'Zephyr')
    assert.equal(zephyrInserted.created_operation, BACKFILL_OPERATION_ID)

    const notInserted = await pool.query<CountRow>(
      'SELECT count(*) FROM managed_knowledge_private.entities WHERE id = ANY($1::uuid[])', [[solanaPublic, featherPublic]],
    )
    assert.equal(notInserted.rows[0]!.count, '0')
    assert.equal(stateById.get(solanaManaged)!.status, ARTICLE_ONLY_STATUS)
    assert.deepEqual(stateById.get(solanaManaged)!.metadata[BACKFILL_MARKER_KEY], { article_only_review: true, previous_status: 'active' })
    assert.equal(stateById.get(featherManaged)!.status, ARTICLE_ONLY_STATUS)
    assert.deepEqual(stateById.get(featherManaged)!.metadata[BACKFILL_MARKER_KEY], { article_only_review: true, previous_status: 'active' })

    // 4. Second write from the done cursor: a no-op run with identical state.
    const digestBeforeIdempotent = await snapshotDigest(pool)
    const idempotentReport = await runBackfill({ pool, write: true, reportPath, cursorPath, batchSize: 2, pauseMs: 0 })
    assert.equal(idempotentReport.status, 'complete')
    assert.deepEqual(idempotentReport.counts, {
      publicEntities: 7, managedEntities: 7, linkedManaged: 5, articleOnlyManaged: 2,
      publicOnlyCandidates: 2, collisionsSkipped: 2, sharedUpdated: 0, publicOnlyInserted: 0, articleOnlyFlagged: 0, batchesWritten: 0,
    })
    assert.equal(idempotentReport.error, null)
    assert.equal(await snapshotDigest(pool), digestBeforeIdempotent)

    // 5. A reviewed row re-activated afterwards is never re-flagged: with the
    // cursor deleted the phases run again, but the marker blocks the update.
    await pool.query('UPDATE managed_knowledge_private.entities SET status = $2 WHERE id = $1', [solanaManaged, 'active'])
    rmSync(cursorPath, { force: true })
    const reactivatedReport = await runBackfill({ pool, write: true, reportPath, cursorPath, batchSize: 2, pauseMs: 0 })
    assert.equal(reactivatedReport.status, 'complete')
    assert.equal(reactivatedReport.counts.articleOnlyFlagged, 0)
    const finalStates = await pool.query<ManagedStateRow>(
      'SELECT * FROM managed_knowledge_private.entities WHERE id = ANY($1::uuid[]) ORDER BY id', [[solanaManaged, featherManaged]],
    )
    assert.equal(finalStates.rows.find((row) => row.id === solanaManaged)!.status, 'active')
    assert.equal(finalStates.rows.find((row) => row.id === featherManaged)!.status, ARTICLE_ONLY_STATUS)
  } finally {
    // Best-effort cleanup of exactly what this test created; the DB is disposable.
    for (const attempt of [
      () => pool.query('DELETE FROM managed_knowledge_private.entities WHERE id = ANY($1::uuid[])', [[...seededManagedIds, ...backfillCreatedManagedIds]]),
      () => pool.query('DELETE FROM public.entities WHERE id = ANY($1::uuid[])', [seededPublicIds]),
      () => pool.query('DELETE FROM managed_knowledge_private.leases WHERE operation_id = ANY($1::text[])', [[FIXTURE_OPERATION, BACKFILL_OPERATION_ID]]),
    ]) {
      try {
        await attempt()
      } catch {
        // Disposable database: leave the evidence rather than mask the failure.
      }
    }
    rmSync(runDir, { recursive: true, force: true })
    await pool.end().catch(() => {})
  }
})