import { execFile } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_CHARS = 40_000
const DEFAULT_MIN_CONTENT_CHARS = 120

type ExecFileImpl = (
  command: string,
  args: string[],
  options: { timeout: number, maxBuffer: number, env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string, stderr: string }>

type ResolveHost = (hostname: string) => Promise<string[]>

export type AgentBrowserReadStatus = 'succeeded' | 'failed' | 'timed_out'

export interface AgentBrowserReadResult {
  status: AgentBrowserReadStatus
  content: string
  finalUrl: string | null
  contentType: string | null
  source: string | null
  httpStatus: number | null
  truncated: boolean
  browserLaunched: boolean | null
  /** False for invalid/private destinations that must not reach browser fallback. */
  fallbackAllowed: boolean
  durationMs: number
  error: string | null
}

export interface AgentBrowserReaderOptions {
  command?: string
  timeoutMs?: number
  maxOutputChars?: number
  minContentChars?: number
  execFileImpl?: ExecFileImpl
  resolveHost?: ResolveHost
}

interface AgentBrowserJsonEnvelope {
  success?: unknown
  data?: {
    content?: unknown
    finalUrl?: unknown
    contentType?: unknown
    source?: unknown
    status?: unknown
    truncated?: unknown
    lifecycle?: { launched?: unknown }
  }
  error?: unknown
}

/**
 * Fetches a known public article URL through agent-browser's HTTP-only `read`
 * command. Explicit URL reads must never launch Chrome; any reported browser
 * launch is treated as a failure and handed to the Hermes browser fallback.
 */
export class AgentBrowserReader {
  private readonly command: string
  private readonly timeoutMs: number
  private readonly maxOutputChars: number
  private readonly minContentChars: number
  private readonly execFileImpl: ExecFileImpl
  private readonly resolveHost: ResolveHost

  constructor(options: AgentBrowserReaderOptions = {}) {
    this.command = options.command
      ?? process.env.AGENT_BROWSER_COMMAND
      ?? require.resolve('agent-browser/bin/agent-browser.js')
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS)
    this.maxOutputChars = positiveInteger(options.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS)
    this.minContentChars = positiveInteger(options.minContentChars, DEFAULT_MIN_CONTENT_CHARS)
    this.execFileImpl = options.execFileImpl ?? (execFileAsync as unknown as ExecFileImpl)
    this.resolveHost = options.resolveHost ?? resolvePublicAddresses
  }

  async read(rawUrl: string): Promise<AgentBrowserReadResult> {
    const startedAt = Date.now()
    let url: URL
    try {
      url = await validatePublicUrl(rawUrl, this.resolveHost)
    } catch (error) {
      return failedResult(startedAt, safeError(error), null, false)
    }

    try {
      const { stdout } = await this.execFileImpl(this.command, [
        '--json',
        '--content-boundaries',
        '--max-output',
        String(this.maxOutputChars),
        'read',
        url.toString(),
        '--timeout',
        String(this.timeoutMs),
      ], {
        timeout: this.timeoutMs + 2_000,
        maxBuffer: Math.max(1_000_000, this.maxOutputChars * 2),
        env: { ...process.env },
      })

      const parsed = JSON.parse(stdout) as AgentBrowserJsonEnvelope
      const data = parsed.data
      const content = typeof data?.content === 'string' ? data.content.trim() : ''
      const browserLaunched = typeof data?.lifecycle?.launched === 'boolean'
        ? data.lifecycle.launched
        : null
      if (parsed.success !== true) {
        return failedResult(startedAt, envelopeError(parsed) ?? 'agent-browser read failed')
      }
      if (browserLaunched !== false) {
        return failedResult(startedAt, 'agent-browser explicit URL read did not confirm HTTP-only execution', browserLaunched)
      }
      const finalUrl = stringOrNull(data?.finalUrl) ?? url.toString()
      try {
        await validatePublicUrl(finalUrl, this.resolveHost)
      } catch (error) {
        return failedResult(startedAt, `Unsafe final article URL: ${safeError(error)}`, false, false)
      }
      if (content.length < this.minContentChars) {
        return failedResult(startedAt, `agent-browser returned insufficient article content (${content.length} chars)`, false)
      }

      return {
        status: 'succeeded',
        content,
        finalUrl,
        contentType: stringOrNull(data?.contentType),
        source: stringOrNull(data?.source),
        httpStatus: typeof data?.status === 'number' ? data.status : null,
        truncated: data?.truncated === true,
        browserLaunched: false,
        fallbackAllowed: true,
        durationMs: Date.now() - startedAt,
        error: null,
      }
    } catch (error) {
      const status = isTimeoutError(error) ? 'timed_out' : 'failed'
      return {
        ...failedResult(startedAt, safeError(error)),
        status,
      }
    }
  }
}

async function validatePublicUrl(rawUrl: string, resolveHost: ResolveHost): Promise<URL> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('Article URL is invalid')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Article URL must use http or https')
  }
  if (url.username || url.password) throw new Error('Article URL must not include credentials')
  const hostname = url.hostname.toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('Article URL host is not public')
  }

  const addresses = isIP(hostname) ? [hostname] : await resolveHost(hostname)
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
    throw new Error('Article URL resolved to a non-public address')
  }
  return url
}

async function resolvePublicAddresses(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

function isPublicAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) {
    const [a, b] = address.split('.').map(Number)
    return !(a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224)
  }
  if (version === 6) {
    const normalized = address.toLowerCase()
    if (normalized === '::' || normalized === '::1') return false
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false
    if (/^fe[89ab]/.test(normalized)) return false
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
    return mapped ? isPublicAddress(mapped) : true
  }
  return false
}

function failedResult(
  startedAt: number,
  error: string,
  browserLaunched: boolean | null = null,
  fallbackAllowed = true,
): AgentBrowserReadResult {
  return {
    status: 'failed',
    content: '',
    finalUrl: null,
    contentType: null,
    source: null,
    httpStatus: null,
    truncated: false,
    browserLaunched,
    fallbackAllowed,
    durationMs: Date.now() - startedAt,
    error,
  }
}

function envelopeError(value: AgentBrowserJsonEnvelope): string | null {
  if (typeof value.error === 'string') return value.error.slice(0, 500)
  if (value.error && typeof value.error === 'object' && 'message' in value.error) {
    return String((value.error as { message: unknown }).message).slice(0, 500)
  }
  return null
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/https?:\/\/[^\s"']+/gi, '[article-url]').slice(0, 500)
}

function isTimeoutError(error: unknown): boolean {
  const value = error as { killed?: unknown, signal?: unknown, code?: unknown }
  return value?.killed === true || value?.signal === 'SIGTERM' || value?.code === 'ETIMEDOUT'
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.trunc(Number(value)) : fallback
}
