import assert from 'node:assert/strict'
import test from 'node:test'
import { EntityService, ManualEntityConflictError } from './entity-service'
import { InMemoryEntityMemoryStore } from './test-helpers'
import type { ManualEntityCommand } from './types'

function command(requestId: string): ManualEntityCommand {
  return {
    requestId,
    actor: { kind: 'codex', name: 'Codex' },
    entity: {
      name: 'US and Iran',
      type: 'geopolitical_topic',
      aliases: ['US–Iran'],
      summary: 'An evolving geopolitical relationship.',
      showInCarousel: true,
    },
    memories: [{
      memoryType: 'timeline_event',
      title: 'Negotiations resumed',
      summary: 'Officials resumed negotiations after a pause.',
      eventAt: '2026-06-01T00:00:00.000Z',
      observedAt: '2026-07-14T10:00:00.000Z',
      sourceLabel: 'Research desk',
      sourceUrl: 'https://example.com/event',
    }],
  }
}

test('previews and applies a new Entity through the shared service', async () => {
  const store = new InMemoryEntityMemoryStore()
  const service = new EntityService(store)
  const preview = await service.previewManual(command('manual-new-001'))

  assert.equal(preview.entity.action, 'create')
  assert.equal(preview.entity.showInCarousel, true)
  assert.equal(preview.memories[0]?.action, 'create')

  const result = await service.applyManual(preview.command, preview.planHash)
  assert.equal(result.memoriesWritten, 1)
  assert.equal(result.auditMarkerWritten, true)
  assert.equal(result.entity.show_in_carousel, true)
  assert.equal(store.entities.length, 1)
  // Timeline memories only - no entity_memories source_marker row. Replay
  // idempotency is tracked in the dedicated manual_command_log mechanism
  // instead (see EntityService.applyManual / findAppliedCommand).
  assert.equal(store.memories.length, 1)
  assert.equal(store.memories.every((memory) => memory.memory_type !== 'source_marker'), true)
  assert.equal(store.manualCommandLog.length, 1)
  assert.equal(store.manualCommandLog[0].requestId, 'manual-new-001')
  assert.equal(store.manualCommandLog[0].entityId, result.entity.id)

  const replay = await service.applyManual(preview.command, preview.planHash)
  assert.equal(replay.replayed, true)
  assert.equal(replay.memoriesWritten, 0)
  assert.equal(store.entities.length, 1)
  assert.equal(store.memories.length, 1)
  assert.equal(store.manualCommandLog.length, 1)
})

test('reuses and updates an existing Entity instead of creating a duplicate', async () => {
  const store = new InMemoryEntityMemoryStore()
  store.entities.push({
    id: 'entity-existing',
    slug: 'us-and-iran',
    name: 'US–Iran',
    type: 'topic',
    aliases: ['US–Iran'],
    summary: null,
    status: 'active',
    show_in_carousel: false,
    metadata: {},
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  })
  const service = new EntityService(store)
  const preview = await service.previewManual(command('manual-existing-001'))

  assert.equal(preview.entity.action, 'update')
  assert.equal(preview.entity.existingEntityId, 'entity-existing')
  assert.ok(preview.entity.changes.includes('showInCarousel'))

  const result = await service.applyManual(preview.command, preview.planHash)
  assert.equal(result.entity.id, 'entity-existing')
  assert.equal(result.entity.name, 'US and Iran')
  assert.equal(result.entity.show_in_carousel, true)
  assert.equal(store.entities.length, 1)
})

test('requires a fresh preview when the Entity state changes', async () => {
  const store = new InMemoryEntityMemoryStore()
  const service = new EntityService(store)
  const preview = await service.previewManual(command('manual-stale-001'))
  store.entities.push({
    id: 'entity-raced',
    slug: 'us-and-iran',
    name: 'US–Iran',
    type: 'topic',
    aliases: ['US–Iran'],
    summary: null,
    status: 'active',
    show_in_carousel: false,
    metadata: {},
    updated_at: '2026-07-14T11:00:00.000Z',
  })

  await assert.rejects(
    () => service.applyManual(preview.command, preview.planHash),
    ManualEntityConflictError,
  )
})

test('rejects replay of a requestId whose logged command_hash does not match (manual_command_log)', async () => {
  const store = new InMemoryEntityMemoryStore()
  const service = new EntityService(store)
  const preview = await service.previewManual(command('manual-conflict-001'))
  await service.applyManual(preview.command, preview.planHash)
  assert.equal(store.manualCommandLog.length, 1)

  const differentCommand = command('manual-conflict-001')
  differentCommand.entity.name = 'A different name entirely'
  const differentPreview = await service.previewManual(differentCommand)

  await assert.rejects(
    () => service.applyManual(differentPreview.command, differentPreview.planHash),
    ManualEntityConflictError,
  )
})
