import { createHash } from 'node:crypto'

export function stableContractId(prefix: string, ...parts: string[]): string {
  const digest = createHash('sha256')
    .update(parts.map((part) => `${part.length}:${part}`).join('|'))
    .digest('hex')
    .slice(0, 32)
  return `${prefix}_${digest}`
}

export function isPublicHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : []
}
