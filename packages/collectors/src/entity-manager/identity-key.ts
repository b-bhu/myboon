/**
 * One shared, pure entity identity key used by every TS entity-creation guard.
 * Creation guards compare keys so a key collision means "do not create a
 * second identity" (hold instead). Keys never authorize attaching by
 * themselves — grounding still decides.
 */

export function entityIdentityKey(value: string): string {
  const normalized = value.normalize('NFKC').trim()
  // Drop ONE trailing parenthetical qualifier only when a non-empty base
  // remains before it; '(BTC)' has no base and must keep its own identity.
  const based = normalized.replace(/\s*\([^()]*\)$/, (match,offset) => offset > 0 ? '' : match)
  return based.toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, '')
}

/** Identity keys of all values; empty keys are dropped. */
export function entityIdentityKeys(values: readonly string[]): Set<string> {
  const keys = new Set<string>()
  for (const value of values) {
    const key = entityIdentityKey(value)
    if (key) keys.add(key)
  }
  return keys
}

/**
 * Labels for exact DB identity lookups, where the database compares
 * lower(btrim(label)) exactly: each value is immediately followed by its base
 * name when it ends in a trailing parenthetical, so 'Bitcoin (BTC)' also
 * looks up 'Bitcoin'. No other variants.
 */
export function entityIdentityLookupLabels(values: readonly string[]): string[] {
  const labels = new Set<string>()
  for (const value of values) {
    const normalized = value.normalize('NFKC').replace(/\s+/g, ' ').trim()
    if (!normalized) continue
    labels.add(normalized)
    const base = trailingParentheticalBase(normalized)
    if (base) labels.add(base)
  }
  return [...labels]
}

/** Base before the trailing parenthetical, or '' when nothing remains ('(BTC)' has no base). */
function trailingParentheticalBase(value: string): string {
  return value.match(/^(.+)\s*\([^()]*\)$/)?.[1]?.trim() ?? ''
}
