/**
 * The one canonical set of object/string/number guards (issue #896).
 *
 * Every package imports these instead of re-declaring private copies. A
 * private copy is only replaced by these when it behaves the same on every
 * input pinned in guards.test.ts; a copy that differs keeps its own local
 * function, renamed to say how it differs (and listed in PR #896):
 *
 * - `api/src/phoenix/parse.ts`: `asRecordLoose` (arrays pass) + `asStringRaw`
 *   (whitespace-only strings pass, numbers rejected),
 * - `api/src/wallet-summary/venues/phoenix.ts`: `asStringTrimmed` (returns the
 *   trimmed value),
 * - `analyst/src/deciders.ts`: `asRecordOrThrow` (throws with a message),
 * - `analyst/src/ollama-quota.ts`: `asRecordOrEmpty` (falls back to `{}`),
 * - `shared/src/wallet-summary/phoenix.ts`: `toNumber` is record-aware
 *   ({ui}/{value+decimals} amounts) and stays named as-is: the hybrid-expo
 *   app imports it via @myboon/shared/wallet-summary.
 */

/**
 * Type guard: true only for non-null, non-array objects (plain records as
 * well as class instances like Date). Functions, primitives, null, undefined
 * and arrays are all false.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Coerce to a record or null: same rule as isRecord, returning the value
 * itself (same reference) when it can be read as a record.
 */
export function asRecord(input: unknown): Record<string, unknown> | null {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

/**
 * Coerce to a string or null:
 * - non-blank strings pass verbatim (blank after trim -> null, never
 *   trimmed itself),
 * - finite numbers pass as String(number),
 * - everything else (null, undefined, booleans, arrays, records, NaN,
 *   +-Infinity, functions) is null.
 */
export function asString(input: unknown): string | null {
  if (typeof input === 'number' && Number.isFinite(input)) return String(input);
  return typeof input === 'string' && input.trim().length > 0 ? input : null;
}

/**
 * Coerce to a finite number or null:
 * - finite numbers pass unchanged (NaN and +-Infinity -> null),
 * - strings are parsed with Number.parseFloat ('', blank, non-numeric,
 *   'NaN', 'Infinity' -> null; leading whitespace and a trailing tail like
 *   '12abc' obey the parseFloat prefix rule),
 * - everything else, including records, is null.
 */
export function toNumber(input: unknown): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  if (typeof input !== 'string') return null;
  const parsed = Number.parseFloat(input);
  return Number.isFinite(parsed) ? parsed : null;
}
