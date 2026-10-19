import { X509Certificate } from 'node:crypto'

export class DatabaseCaConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DatabaseCaConfigError'
  }
}

const PEM_CERTIFICATE_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g

/**
 * Normalises a database CA setting to a real PEM bundle, or null when unset.
 * Shell/env transports routinely flatten newlines to literal "\n" or "\r\n",
 * so those two-char sequences are unescaped first — a real PEM never contains
 * a backslash, making this safe. Bundles may carry comment or header lines
 * between certificates (OpenSSL accepts them), so only at least one complete
 * certificate block is required. Failures throw without echoing the value or
 * the underlying parse error.
 */
export function normalizeDatabaseCa(setting: string, raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null || raw.trim() === '') return null
  const text = raw.replaceAll('\\r\\n', '\n').replaceAll('\\n', '\n').trim()
  const blocks = text.match(PEM_CERTIFICATE_BLOCK)
  if (blocks === null) {
    throw new DatabaseCaConfigError(`${setting} must contain PEM certificate(s)`)
  }
  try {
    for (const block of blocks) new X509Certificate(block)
  } catch {
    throw new DatabaseCaConfigError(`${setting} must contain PEM certificate(s)`)
  }
  return text
}