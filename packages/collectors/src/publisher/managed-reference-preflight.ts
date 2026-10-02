/**
 * Pure, read-time validation for managed references before a consumer uses them.
 * This is deliberately not wired into publisher execution: it cannot close the
 * read/write race. Publication still needs an atomic status/revision recheck at
 * its commit boundary once the Stage 4 SQL writer exists.
 */
export type ManagedReferenceStatus = 'active' | 'retracted'

export interface ManagedReferenceExpectation {
  /** Exact source identity as retained by the original draft / Story. */
  id: string
  revision: number
}

export interface ManagedReferenceLookup<T> {
  /** False for failed, partial, or truncated responses; never infer completeness. */
  complete: boolean
  items: readonly ManagedReferenceRevision<T>[]
}

export interface ManagedReferenceRevision<T> {
  id: string
  revision: number
  status: ManagedReferenceStatus
  /** All required citation/evidence fields were hydrated for this revision. */
  hydration: 'complete' | 'incomplete'
  value: T
}

export type ManagedReferencePreflight<T> =
  | { kind: 'ready'; references: readonly ManagedReferenceRevision<T>[] }
  | { kind: 'pause'; reason: ManagedReferencePauseReason; referenceId?: string }

export type ManagedReferencePauseReason =
  | 'invalid_expectation'
  | 'duplicate_expected_id'
  | 'lookup_incomplete'
  | 'duplicate_lookup_id'
  | 'missing_reference'
  | 'stale_revision'
  | 'retracted_reference'
  | 'incomplete_hydration'

/**
 * Validate exact source references against one complete authoritative snapshot.
 * The output keeps expectation order and exact IDs; it never substitutes a
 * newer revision or filters out an unavailable source item.
 */
export function preflightManagedReferences<T>(
  expected: readonly ManagedReferenceExpectation[],
  lookup: ManagedReferenceLookup<T>,
): ManagedReferencePreflight<T> {
  const expectedIds = new Set<string>()
  for (const reference of expected) {
    if (!reference || typeof reference.id !== 'string' || reference.id.length === 0 ||
      !Number.isSafeInteger(reference.revision) || reference.revision <= 0) {
      return { kind: 'pause', reason: 'invalid_expectation' }
    }
    if (expectedIds.has(reference.id)) {
      return { kind: 'pause', reason: 'duplicate_expected_id', referenceId: reference.id }
    }
    expectedIds.add(reference.id)
  }

  if (!lookup || lookup.complete !== true || !Array.isArray(lookup.items)) {
    return { kind: 'pause', reason: 'lookup_incomplete' }
  }

  const byId = new Map<string, ManagedReferenceRevision<T>>()
  for (const item of lookup.items) {
    if (!item || typeof item.id !== 'string' || item.id.length === 0 || byId.has(item.id)) {
      return { kind: 'pause', reason: 'duplicate_lookup_id', referenceId: item?.id }
    }
    byId.set(item.id, item)
  }

  const references: ManagedReferenceRevision<T>[] = []
  for (const reference of expected) {
    const current = byId.get(reference.id)
    if (!current) return { kind: 'pause', reason: 'missing_reference', referenceId: reference.id }
    if (!Number.isSafeInteger(current.revision) || current.revision !== reference.revision) {
      return { kind: 'pause', reason: 'stale_revision', referenceId: reference.id }
    }
    if (current.status !== 'active') {
      return { kind: 'pause', reason: 'retracted_reference', referenceId: reference.id }
    }
    if (current.hydration !== 'complete' || current.value === null || current.value === undefined) {
      return { kind: 'pause', reason: 'incomplete_hydration', referenceId: reference.id }
    }
    references.push(current)
  }
  return { kind: 'ready', references }
}
