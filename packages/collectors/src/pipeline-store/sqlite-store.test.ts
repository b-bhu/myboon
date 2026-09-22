import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SqliteEntityDraftInventory } from '../entity-maintenance/sqlite-draft-inventory'
import { SqlitePipelineStore } from './sqlite-store'
import { runPipelineStoreContract } from './store-contract'
import type { PipelineDraftUpsertInput } from './store'

runPipelineStoreContract('sqlite', () => new SqlitePipelineStore(':memory:'))

test('SQLite cleanup fence makes the zero-draft check atomic with remote merge work', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'myboon-entity-cleanup-fence-'))
  const path = join(directory, 'pipeline.sqlite')
  const store = new SqlitePipelineStore(path)
  const inventory = new SqliteEntityDraftInventory(path)
  const draft: PipelineDraftUpsertInput = {
    entityId: 'entity-fenced',
    entitySlug: 'entity-fenced',
    entityName: 'Entity Fenced',
    entityType: 'topic',
    bundleKey: 'bundle-fenced',
    sourceMemoryIds: ['memory-fenced'],
    sourceMemoryHash: 'hash-fenced',
    source: 'news',
    sourceArea: 'feed',
    action: 'draft_post',
    status: 'drafted',
    title: 'Fenced draft',
    reasoning: 'test',
    backend: 'test',
  }

  try {
    await inventory.withMutationFence('entity-fenced', async (count) => {
      assert.equal(count, 0)
      await assert.rejects(
        store.upsertDraftsByBundleKey([draft]),
        /temporarily fenced for catalogue cleanup/,
      )
    })

    const rows = await store.upsertDraftsByBundleKey([draft])
    assert.equal(rows.length, 1)
  } finally {
    inventory.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
