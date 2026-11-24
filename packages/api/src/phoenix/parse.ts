/** Pure coercion and symbol helpers for Phoenix payloads (#831). */

/**
 * Differs from @myboon/shared/guards asRecord: arrays pass through as
 * records instead of mapping to null (#896).
 */
export function asRecordLoose(input: unknown): Record<string, unknown> | null {
  return input && typeof input === 'object' ? input as Record<string, unknown> : null
}

/**
 * Differs from @myboon/shared/guards asString: keeps whitespace-only
 * strings and rejects numbers instead of stringifying them (#896).
 */
export function asStringRaw(input: unknown): string | null {
  return typeof input === 'string' && input.length > 0 ? input : null
}

export function asNonEmptyString(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function asBoolean(input: unknown): boolean | null {
  return typeof input === 'boolean' ? input : null
}

export function parseNullableNumber(input: unknown): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null
  if (typeof input !== 'string') return null
  const parsed = Number.parseFloat(input)
  return Number.isFinite(parsed) ? parsed : null
}

export function parseFiniteJsonNumber(input: unknown): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null
  if (typeof input !== 'string') return null

  const trimmed = input.trim()
  if (!trimmed) return null

  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

export function parseNullableInt(input: unknown): number | null {
  const value = parseNullableNumber(input)
  return value === null ? null : Math.trunc(value)
}

export function stringifyNullable(input: unknown): string | null {
  if (typeof input === 'string') return input
  if (typeof input === 'number' && Number.isFinite(input)) return String(input)
  if (typeof input === 'bigint') return input.toString()
  return null
}

export function rawNumberOrString(input: unknown): number | string | null {
  if (typeof input === 'number' && Number.isFinite(input)) return input
  if (typeof input === 'string') return input
  return null
}

export function parseNonNegativeInteger(input: unknown): number | null {
  if (typeof input === 'number') {
    return Number.isSafeInteger(input) && input >= 0 ? input : null
  }

  if (typeof input !== 'string' || !/^\d+$/.test(input)) return null
  const parsed = Number.parseInt(input, 10)
  return Number.isSafeInteger(parsed) ? parsed : null
}

export function parsePositiveInteger(input: unknown): number | null {
  const parsed = parseNonNegativeInteger(input)
  return parsed !== null && parsed > 0 ? parsed : null
}

export function historyLimit(input: string | undefined, fallback = 50, max = 100): number {
  const parsed = input === undefined ? null : parsePositiveInteger(input)
  return parsed === null ? fallback : Math.min(parsed, max)
}

export function isNonNegativeInteger(input: unknown): boolean {
  return typeof input === 'number' && Number.isSafeInteger(input) && input >= 0
}

export function normalizeVenueSymbol(input: string | null | undefined): string | null {
  if (!input) return null
  const normalized = input.trim().toUpperCase().replace(/-PERP$/, '')
  return /^[A-Z0-9]{1,24}$/.test(normalized) ? normalized : null
}

export function appSymbolFromVenueSymbol(venueSymbol: string): string {
  return `${venueSymbol}-PERP`
}

export function normalizeMarketSymbol(input: string | null | undefined): string | null {
  const venueSymbol = normalizeVenueSymbol(input)
  return venueSymbol ? appSymbolFromVenueSymbol(venueSymbol) : null
}

export function safeJsonParse(input: string): unknown {
  try {
    return JSON.parse(input) as unknown
  } catch {
    return null
  }
}
