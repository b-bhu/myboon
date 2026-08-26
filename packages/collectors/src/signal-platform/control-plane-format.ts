import type { SignalPlatformControlPlaneStatus } from './control-plane'

const SENSITIVE_KEY = /(?:^|_)(?:api_?key|authorization|cookie|credential|password|secret|token|dsn)(?:$|_)/i
const SENSITIVE_VALUE = /(?:bearer\s+[a-z0-9._~+\/-]+|(?:api_?key|password|secret|token)\s*[=:]\s*[^\s,;]+)/ig
const CREDENTIAL_URL = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/ig
const COMMON_SECRET = /\b(?:sk-[a-z0-9_-]{12,}|ghp_[a-z0-9]{12,}|xox[baprs]-[a-z0-9-]{12,}|AKIA[A-Z0-9]{16})\b/ig

/** Credential-free JSON intended for terminals, runbooks, and status collectors. */
export function formatControlPlaneStatusJson<T extends SignalPlatformControlPlaneStatus>(
  status: T,
  options: { pretty?: boolean } = {},
): string {
  return JSON.stringify(redact(status), null, options.pretty === false ? undefined : 2)
}

export function redactControlPlaneValue(value: unknown): unknown {
  return redact(value)
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (typeof value === 'string') return redactString(value)
  if (!value || typeof value !== 'object') return value
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) continue
    result[key] = redact(item)
  }
  return result
}

function redactString(value: string): string {
  return value
    .replace(CREDENTIAL_URL, '$1[REDACTED]@')
    .replace(SENSITIVE_VALUE, '[REDACTED]')
    .replace(COMMON_SECRET, '[REDACTED]')
}
