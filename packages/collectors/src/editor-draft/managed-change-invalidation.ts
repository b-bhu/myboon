import type { KnowledgeChangeV2 } from '../entity-manager/knowledge-reader-v2'

/** Local, pure projection only. Durable feed consumption and persistence are not wired. */
export interface ManagedEditorialSelection {
  itemId: string
  revisionId: string
  changeId: string
  status: 'selected' | 'review_needed' | 'stale'
  sent: boolean
}

export interface ManagedChangeInvalidationState {
  selections: ManagedEditorialSelection[]
  appliedChangeIds: string[]
}

export function applyManagedChanges(
  state: ManagedChangeInvalidationState,
  events: readonly KnowledgeChangeV2[],
): ManagedChangeInvalidationState {
  const applied = new Set(state.appliedChangeIds)
  const selections = new Map(state.selections.map((selection) => [selection.itemId, { ...selection }]))

  for (const event of events) {
    if (applied.has(event.changeId)) continue
    applied.add(event.changeId)
    const current = selections.get(event.itemId)
    if (!current || current.revisionId === event.revisionId) continue

    if (event.status === 'active') {
      // Same stable item with a new revision: retain editorial selection, require review.
      selections.set(event.itemId, { ...current, revisionId: event.revisionId, changeId: event.changeId, status: 'review_needed' })
    } else {
      // Correction/retraction/removal invalidates unsent selection; sent history is retained stale.
      selections.set(event.itemId, { ...current, revisionId: event.revisionId, changeId: event.changeId, status: 'stale' })
    }
  }

  return { selections: [...selections.values()], appliedChangeIds: [...applied] }
}
