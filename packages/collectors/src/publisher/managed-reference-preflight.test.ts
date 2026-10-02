import test from 'node:test'
import assert from 'node:assert/strict'
import { preflightManagedReferences, type ManagedReferenceLookup, type ManagedReferenceRevision } from './managed-reference-preflight'

interface StorySource { storyId: string; text: string }
const originalStory = { storyId: 'story-7', text: 'Keep identity intact' }
const exact = [{ id: 'memory-a', revision: 3 }]
const active = (
  id = 'memory-a',
  revision = 3,
  value: StorySource = originalStory,
): ManagedReferenceRevision<StorySource> => ({
  id, revision, status: 'active', hydration: 'complete', value,
})
const lookup = (items: ManagedReferenceRevision<StorySource>[], complete = true): ManagedReferenceLookup<StorySource> => ({ complete, items })

test('pauses when an exact source ID is missing', () => {
  assert.deepEqual(preflightManagedReferences(exact, lookup([])), {
    kind: 'pause', reason: 'missing_reference', referenceId: 'memory-a',
  })
})

test('pauses rather than substituting a newer revision', () => {
  assert.deepEqual(preflightManagedReferences(exact, lookup([active('memory-a', 4)])), {
    kind: 'pause', reason: 'stale_revision', referenceId: 'memory-a',
  })
})

test('pauses for a revision without complete evidence hydration', () => {
  assert.deepEqual(preflightManagedReferences(exact, lookup([{
    ...active(), hydration: 'incomplete',
  }])), { kind: 'pause', reason: 'incomplete_hydration', referenceId: 'memory-a' })
})

test('returns all exact matching active references in source order without rewriting identity', () => {
  const expected = [{ id: 'memory-b', revision: 2 }, { id: 'memory-a', revision: 3 }]
  const storyA = { storyId: 'story-7', text: 'A' }
  const storyB = { storyId: 'story-9', text: 'B' }
  const result = preflightManagedReferences(expected, lookup([
    active('memory-a', 3, storyA), active('memory-b', 2, storyB),
  ]))
  assert.equal(result.kind, 'ready')
  if (result.kind !== 'ready') return
  assert.deepEqual(result.references.map(({ id, revision }) => ({ id, revision })), expected)
  assert.equal(result.references[0]?.value, storyB)
  assert.equal(result.references[0]?.value.storyId, 'story-9')
  assert.equal(result.references[1]?.value, storyA)
  assert.equal(result.references[1]?.value.storyId, 'story-7')
})

test('fails closed when lookup coverage is partial or truncated', () => {
  assert.deepEqual(preflightManagedReferences(exact, lookup([active()], false)), {
    kind: 'pause', reason: 'lookup_incomplete',
  })
})

test('fails closed on retraction and duplicate lookup rows', () => {
  assert.deepEqual(preflightManagedReferences(exact, lookup([{
    ...active(), status: 'retracted',
  }])), { kind: 'pause', reason: 'retracted_reference', referenceId: 'memory-a' })
  assert.deepEqual(preflightManagedReferences(exact, lookup([active(), active()])), {
    kind: 'pause', reason: 'duplicate_lookup_id', referenceId: 'memory-a',
  })
})
