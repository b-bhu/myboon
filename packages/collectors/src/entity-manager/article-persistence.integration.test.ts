import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { IsolatedEntityPostgres } from './isolated-postgres.test-support'
import { ArticlePersistenceProcessor, retainPrimaryDuplicateTarget } from './article-persistence'
import { managedFixture, ACME_ID, MANAGED_TEST_NOW } from './managed-v4.test-support'
import { assessResearchReadiness } from '../signal-platform/research-readiness'
import { validateResearchPacket } from '../signal-platform/validation'
import type { ArticleChoiceDecision, ArticleEntityProposal, ArticleResearchPacketV1 } from '../signal-platform/contracts'

const SECOND_ID = '33333333-3333-3333-3333-333333333333'
const LEGACY_ID = '22222222-2222-2222-2222-222222222222'
const choice = (key: string): ArticleChoiceDecision => ({ choice: key, probabilities: { [key]: .9, alternative: .1 }, confidence: .9, decisionId: `fixture:${key}`, decisionVersion: 'fixture.v1' })
function membership(id = ACME_ID, role: 'primary' | 'related' = 'primary'): ArticleEntityProposal {
  return { entityId: id, name: id === ACME_ID ? 'Acme' : 'Bitcoin', type: 'organization', aliases: [], summary: null, scope: {},
    role, placementDisposition: 'selected', placement: choice(role === 'primary' ? id : 'related'),
    creationProposal: null, creationDecision: null, relationship: null, relationshipDecision: null,
    priorItemDecision: null, priorItemId: null, priorItemSource: null, duplicateTarget: null }
}
function article(suffix: string, memberships = [membership()]) {
  const fixture = managedFixture(suffix)
  const old = fixture.canonicalPacket
  const packet: ArticleResearchPacketV1 = { schemaVersion: 'myboon.research_packet.article.v1', packetKind: 'article',
    packetId: old.packetId, workId: old.workId, signalId: old.signalId, sourceType: old.sourceType, observedAt: old.observedAt,
    sourceSignal: { ...old.sourceSignal, canonicalUrl: old.sourceSignal.canonicalUrl!, sourceId: fixture.handoffContext.signal.sourceId },
    article: { title: 'Acme announces a new development', timelineSummary: 'Acme announced a new development on 3 October.', body: 'Captured article detail.',
      eventAt: MANAGED_TEST_NOW, sourceUrl: old.sourceSignal.canonicalUrl!, capturedText: fixture.handoffContext.persistedEvidence[0].text,
      capturedAt: MANAGED_TEST_NOW, contentHash: createHash('sha256').update('<p>'+fixture.handoffContext.persistedEvidence[0].text+'</p>').digest('hex'), truncated: false },
    memberships, novelty: choice('new_information'), limitations: [], openQuestions: [], completion: 'complete',
    budgetUsed: old.budgetUsed, execution: old.execution, researchContractVersion: old.researchContractVersion, createdAt: old.createdAt }
  return { fixture, packet }
}

test('article migration and deterministic persistence preserve shared membership, legacy history, chronology and replay', {
  skip: process.env.ENTITY_V4_RUN_POSTGRES_TESTS !== '1', timeout: 180_000,
}, async (t) => {
  const database = new IsolatedEntityPostgres()
  let writer: ReturnType<IsolatedEntityPostgres['writer']> | undefined
  try {
    await database.start(); await database.migrate({ nonSuperuserAdmin: true })
    await database.admin.query(`ALTER TABLE public.entity_memories ADD COLUMN entity_id uuid, ADD COLUMN source_ref_id text,
      ADD COLUMN title text, ADD COLUMN summary text, ADD COLUMN body text, ADD COLUMN event_at timestamptz,
      ADD COLUMN observed_at timestamptz, ADD COLUMN updated_at timestamptz;
      UPDATE public.entity_memories SET entity_id='${ACME_ID}', title='Previous Acme announcement', summary='Earlier progress.',
        event_at='2026-10-01T12:00:00Z', observed_at='2026-10-01T12:00:00Z', updated_at='2026-10-01T12:00:00Z';
      INSERT INTO public.entities(id,slug,name,type,aliases) VALUES('${SECOND_ID}','bitcoin','Bitcoin','asset','["BTC"]');`)
    const before = (await database.admin.query('select * from public.entity_memories order by id')).rows
    const deployer = database.pool('fixture_deployer')
    const client = await deployer.connect()
    try {
      await client.query('BEGIN')
      const migration = readFileSync(resolve(__dirname, '../../../../supabase/migrations/20261004103000_entity_manager_article_private_knowledge.sql'), 'utf8')
      const starts = [0, migration.indexOf('CREATE FUNCTION managed_knowledge_private.article_context'), migration.indexOf('CREATE FUNCTION managed_knowledge_private.article_writer'), migration.indexOf('REVOKE ALL ON managed_knowledge_private.article_items'), migration.length]
      for (let i = 0; i < starts.length - 1; i++) {
        const chunk = migration.slice(starts[i], starts[i + 1])
        try { await client.query(chunk) } catch (error) {
          const position = Number((error as {position?: string}).position ?? 0)
          console.error({ migrationChunk: i, position, near: chunk.slice(Math.max(0, position - 150), position + 150) })
          throw error
        }
      }
      await client.query(readFileSync(resolve(__dirname, '../../../../supabase/migrations/20261006112717_article_entity_candidate_resolution.sql'), 'utf8'))
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release(); await deployer.end() }
    writer = database.writer()
    const processor = new ArticlePersistenceProcessor(writer)
    const persist = async (input: ReturnType<typeof article>) => {
      // Related exact matches are retained as contextual packet history before
      // the immutable source checkpoint is written. The SQL writer must see
      // the same normalized packet as the later progression plan.
      const packet = retainPrimaryDuplicateTarget(input.packet)
      validateResearchPacket(packet)
      const readiness = assessResearchReadiness({ work: input.fixture.work, signal: input.fixture.handoffContext.signal,
        packet, persistedEvidence: [], assessedAt: MANAGED_TEST_NOW })
      assert.equal(readiness.outcome, 'ready_for_entity'); assert.ok(!('evidenceIds' in readiness)); assert.ok(!('coverage' in readiness))
      await writer!.saveResearchSource(packet, { ...input.fixture.handoffContext, readiness })
      return processor.persist({ packet, source: 'news', owner: 'article-test', signal: new AbortController().signal })
    }
    let itemId = ''
    await t.test('one immutable article belongs to two entities and links to a real legacy development', async () => {
      const primary = membership()
      Object.assign(primary, { relationship: 'direct_continuation', relationshipDecision: choice('direct_continuation'),
        priorItemDecision: choice(LEGACY_ID), priorItemId: LEGACY_ID, priorItemSource: 'legacy' })
      const input = article('article-new', [primary, membership(SECOND_ID, 'related')])
      assert.equal(await persist(input), 'written')
      const rows = (await database.admin.query('select item_id,title,timeline_summary,captured_text,content_hash,captured_text_hash,event_at from managed_knowledge_private.article_items')).rows
      assert.equal(rows.length, 1); itemId = rows[0].item_id
      assert.equal(rows[0].timeline_summary, input.packet.article.timelineSummary)
      assert.equal(rows[0].captured_text, input.packet.article.capturedText)
      assert.equal(rows[0].content_hash, input.packet.article.contentHash)
      assert.equal(rows[0].captured_text_hash, createHash('sha256').update(input.packet.article.capturedText).digest('hex'))
      assert.notEqual(rows[0].captured_text_hash, rows[0].content_hash)
      assert.equal(rows[0].event_at.toISOString(), MANAGED_TEST_NOW)
      assert.equal((await database.admin.query('select * from managed_knowledge_private.memberships where item_id=$1', [itemId])).rows.length, 2)
      assert.equal((await database.admin.query('select target_origin,target_item_id from managed_knowledge_private.article_relationships')).rows[0].target_item_id, LEGACY_ID)
      assert.equal((await database.admin.query('select count(*)::int count from managed_knowledge_private.evidence')).rows[0].count, 0)
      assert.equal(await persist(input), 'written')
      assert.equal((await database.admin.query('select count(*)::int count from managed_knowledge_private.items')).rows[0].count, 1)
    })
    await t.test('managed duplicate attaches source without rewriting or cloning prose', async () => {
      const primary = membership()
      Object.assign(primary, { relationship: 'duplicate', relationshipDecision: choice('duplicate'), priorItemDecision: choice(itemId),
        priorItemId: itemId, priorItemSource: 'managed', duplicateTarget: { itemId, source: 'managed', entityId: ACME_ID } })
      const input = article('article-duplicate', [primary, membership(SECOND_ID, 'related')]); input.packet.novelty = choice('already_known')
      assert.equal(await persist(input), 'reused')
      assert.equal((await database.admin.query('select count(*)::int count from managed_knowledge_private.items')).rows[0].count, 1)
      assert.equal((await database.admin.query('select count(*)::int count from managed_knowledge_private.article_source_attachments')).rows[0].count, 2)
    })
    await t.test('primary duplicate reuses one item while related history remains contextual and replay is idempotent', async () => {
      const relatedPrior = article('article-related-prior', [membership(SECOND_ID)])
      assert.equal(await persist(relatedPrior), 'written')
      const relatedItemRows = (await database.admin.query(
        'select item_id from managed_knowledge_private.article_items where item_id <> $1', [itemId],
      )).rows
      assert.equal(relatedItemRows.length, 1)
      const relatedItemId = relatedItemRows[0].item_id as string
      const proseBefore = (await database.admin.query(
        'select item_id,title,timeline_summary,body,captured_text,content_hash,captured_text_hash from managed_knowledge_private.article_items order by item_id',
      )).rows
      const membershipsBefore = (await database.admin.query(
        'select item_id,entity_id,role from managed_knowledge_private.memberships order by item_id,entity_id',
      )).rows

      const primary = membership()
      Object.assign(primary, { relationship: 'duplicate', relationshipDecision: choice('duplicate'), priorItemDecision: choice(itemId),
        priorItemId: itemId, priorItemSource: 'managed', duplicateTarget: { itemId, source: 'managed', entityId: ACME_ID } })
      const related = membership(SECOND_ID, 'related')
      Object.assign(related, { relationship: 'duplicate', relationshipDecision: choice('duplicate'), priorItemDecision: choice(relatedItemId),
        priorItemId: relatedItemId, priorItemSource: 'managed', duplicateTarget: { itemId: relatedItemId, source: 'managed', entityId: SECOND_ID } })
      const input = article('article-distinct-related-prior', [primary, related]); input.packet.novelty = choice('already_known')
      const normalized = retainPrimaryDuplicateTarget(input.packet)
      assert.equal(normalized.memberships[0]!.duplicateTarget?.itemId, itemId)
      assert.equal(normalized.memberships[1]!.duplicateTarget, null)
      assert.deepEqual(normalized.memberships[1]!.contextualDuplicateTarget, { itemId: relatedItemId, source: 'managed', entityId: SECOND_ID })
      assert.equal(await persist(input), 'reused')

      const attachmentRows = (await database.admin.query(
        'select target_origin,target_item_id,entity_id from managed_knowledge_private.article_source_attachments where work_id=$1 order by entity_id',
        [input.packet.workId],
      )).rows
      assert.equal(attachmentRows.length, 2)
      assert.ok(attachmentRows.every((row) => row.target_origin === 'managed' && row.target_item_id === itemId))
      assert.deepEqual((await database.admin.query(
        'select item_id,entity_id,role from managed_knowledge_private.memberships order by item_id,entity_id',
      )).rows, membershipsBefore)
      assert.deepEqual((await database.admin.query(
        'select item_id,entity_id,role from managed_knowledge_private.memberships where item_id=$1', [relatedItemId],
      )).rows, [{ item_id: relatedItemId, entity_id: SECOND_ID, role: 'primary' }])
      assert.deepEqual((await database.admin.query(
        'select item_id,title,timeline_summary,body,captured_text,content_hash,captured_text_hash from managed_knowledge_private.article_items order by item_id',
      )).rows, proseBefore)
      assert.equal((await database.admin.query(
        'select count(*)::int count from managed_knowledge_private.receipts where work_id=$1', [input.packet.workId],
      )).rows[0].count, 1)

      // Receipt-first replay reports the terminal operation as written even
      // when the original effect was a reuse.
      assert.equal(await persist(input), 'written')
      assert.equal((await database.admin.query(
        'select count(*)::int count from managed_knowledge_private.receipts where work_id=$1', [input.packet.workId],
      )).rows[0].count, 1)
      assert.equal((await database.admin.query(
        'select count(*)::int count from managed_knowledge_private.article_source_attachments where work_id=$1', [input.packet.workId],
      )).rows[0].count, 2)
      assert.deepEqual((await database.admin.query(
        'select item_id,title,timeline_summary,body,captured_text,content_hash,captured_text_hash from managed_knowledge_private.article_items order by item_id',
      )).rows, proseBefore)
    })
    await t.test('source-grounded new identity is persisted privately and reused by later articles', async () => {
      const proposal = { name: 'Novel Research Narrative', type: 'story', aliases: ['Novel Narrative'], summary: 'A new source-grounded narrative.', scope: { category: 'research' } }
      const proposed = { ...membership(), entityId: null, name: proposal.name, aliases: proposal.aliases, placementDisposition: 'no_match' as const,
        placement: choice('no_match'), creationProposal: proposal, creationDecision: choice('accept') }
      assert.equal(await persist(article('article-created', [proposed])), 'written')
      assert.equal(await persist(article('article-created-next', [proposed])), 'written')
      assert.equal((await database.admin.query("select count(*)::int count from managed_knowledge_private.entities where binding->>'name'=$1", [proposal.name])).rows[0].count, 1)
      assert.equal((await database.admin.query('select count(*)::int count from public.entities')).rows[0].count, 2)
    })
    await t.test('named context returns legacy and managed chronology; readers cannot write', async () => {
      const context = await writer!.articleContext({ entityIds: [ACME_ID], historyMode: 'recent', limit: 5 })
      assert.equal(context.articleItems.length, 2); assert.equal(context.articleItems[0].origin, 'managed')
      assert.equal(context.articleItems[1].itemId, LEGACY_ID)
      const reader = database.pool('v4_reader_fixture')
      const api = database.pool('v4_api_fixture')
      try {
        await reader.query('select managed_knowledge_private.article_context_v1($1::jsonb)', [{ entityIds: [ACME_ID], labels: [], sourceRefs: [], itemIds: [], limit: 5, historyMode: 'recent' }])
        await assert.rejects(reader.query("select managed_knowledge_private.article_writer_v1('source','{}'::jsonb)"), (e: unknown) => (e as { code: string }).code === '42501')
        await assert.rejects(api.query('select * from managed_knowledge_private.article_items'), (e: unknown) => (e as { code: string }).code === '42501')
      } finally { await reader.end(); await api.end() }
      assert.deepEqual((await database.admin.query('select * from public.entity_memories order by id')).rows, before)
    })
    await t.test('exact identities survive more than 32 broad matches and creation ignores irrelevant candidate overflow', async () => {
      await database.admin.query(`INSERT INTO public.entities(id,slug,name,type,aliases,summary)
        SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'noise-'||n,'Background '||n,'topic','[]','Bitcoin and general finance news'
        FROM generate_series(1,40) n`)
      const ranked = await writer!.articleContext({ labels: ['Bitcoin', 'finance'], historyMode: 'targeted', limit: 32 })
      assert.equal(ranked.entities[0].id, SECOND_ID)
      assert.equal(ranked.candidateTruncated, true)
      const exact = await writer!.articleContext({ labels: ['BTC'], identityOnly: true, historyMode: 'targeted', limit: 32 })
      assert.deepEqual(exact.entities.map(e => e.id), [SECOND_ID])
      assert.equal(exact.candidateTruncated, false)
      const rankedPrivate = await writer!.articleContext({ labels: ['Novel Research Narrative', 'finance'], historyMode: 'targeted', limit: 32 })
      assert.equal(rankedPrivate.entities[0].name, 'Novel Research Narrative')
      assert.equal(rankedPrivate.candidateTruncated, true)
      const exactPrivate = await writer!.articleContext({ labels: ['novel narrative'], identityOnly: true, historyMode: 'targeted', limit: 32 })
      assert.deepEqual(exactPrivate.entities.map(e => e.name), ['Novel Research Narrative'])
      assert.equal(exactPrivate.candidateTruncated, false)
      const proposal = { name: 'Finance Chronicle New Story', type: 'story', aliases: [], summary: 'A distinct finance development.', scope: {} }
      const prepared = { ...membership(), entityId: null, name: proposal.name, placementDisposition: 'no_match' as const,
        placement: choice('no_match'), creationProposal: proposal, creationDecision: choice('accept') }
      assert.equal(await persist(article('creation-with-broad-noise', [prepared])), 'written')
      assert.equal((await database.admin.query("select count(*)::int count from managed_knowledge_private.entities where binding->>'name'=$1", [proposal.name])).rows[0].count, 1)
      // The replacement retains function ownership, its restricted grants and
      // the deployer's original inability to assume the data owner.
      const privileges = await database.admin.query("select pg_has_role('fixture_deployer','myboon_knowledge_owner','SET') can_set,has_schema_privilege('myboon_knowledge_owner','managed_knowledge_private','CREATE') can_create")
      assert.deepEqual(privileges.rows[0], { can_set: false, can_create: false })
    })
  } finally { await writer?.close(); await database.close() }
})
