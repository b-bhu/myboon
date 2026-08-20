import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import {
  fetchPublicDocument,
  type ResolveHost,
  type SafePublicDocument,
} from './safe-public-http'

const execFileAsync = promisify(execFile)

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_CHARS = 40_000
const DEFAULT_MIN_CONTENT_CHARS = 120

type ExecFileImpl = (
  command: string,
  args: string[],
  options: { timeout: number, maxBuffer: number, env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string, stderr: string }>

type FetchDocumentImpl = (url: string) => Promise<SafePublicDocument>

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
  /** False when no complete public redirect chain was vetted. */
  fallbackAllowed: boolean
  /** Native agent-browser containment applied to Hermes browser fallback. */
  allowedFallbackDomains: string[]
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
  fetchDocumentImpl?: FetchDocumentImpl
}

interface AgentBrowserJsonEnvelope {
  success?: unknown
  data?: {
    content?: unknown
    source?: unknown
    truncated?: unknown
    lifecycle?: { launched?: unknown }
  }
  error?: unknown
}

/**
 * Fetches and validates every external redirect hop itself, then gives the
 * already-retrieved bytes to agent-browser through a one-use loopback server.
 * agent-browser never receives the untrusted external URL, so it cannot follow
 * an unchecked redirect to a private service.
 */
export class AgentBrowserReader {
  private readonly command: string
  private readonly timeoutMs: number
  private readonly maxOutputChars: number
  private readonly minContentChars: number
  private readonly execFileImpl: ExecFileImpl
  private readonly fetchDocumentImpl: FetchDocumentImpl

  constructor(options: AgentBrowserReaderOptions = {}) {
    this.command = options.command
      ?? process.env.AGENT_BROWSER_COMMAND
      ?? require.resolve('agent-browser/bin/agent-browser.js')
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS)
    this.maxOutputChars = positiveInteger(options.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS)
    this.minContentChars = positiveInteger(options.minContentChars, DEFAULT_MIN_CONTENT_CHARS)
    this.execFileImpl = options.execFileImpl ?? (execFileAsync as unknown as ExecFileImpl)
    this.fetchDocumentImpl = options.fetchDocumentImpl ?? ((url) => fetchPublicDocument(url, {
      timeoutMs: this.timeoutMs,
      resolveHost: options.resolveHost,
    }))
  }

  async read(rawUrl: string): Promise<AgentBrowserReadResult> {
    const startedAt = Date.now()
    let document: SafePublicDocument
    try {
      document = await this.fetchDocumentImpl(rawUrl)
    } catch (error) {
      return failedResult(startedAt, safeError(error), null, false)
    }

    const fallbackDomains = [...new Set(document.visitedHosts)]
    try {
      const stdout = await withLoopbackDocument(document, async (loopbackUrl) => {
        const result = await this.execFileImpl(this.command, [
          '--json',
          '--content-boundaries',
          '--max-output',
          String(this.maxOutputChars),
          'read',
          loopbackUrl,
          '--timeout',
          String(this.timeoutMs),
        ], {
          timeout: this.timeoutMs + 2_000,
          maxBuffer: Math.max(1_000_000, this.maxOutputChars * 2),
          env: {
            ...process.env,
            NO_PROXY: '127.0.0.1,localhost',
            no_proxy: '127.0.0.1,localhost',
          },
        })
        return result.stdout
      })

      const parsed = JSON.parse(stdout) as AgentBrowserJsonEnvelope
      const data = parsed.data
      const content = typeof data?.content === 'string' ? data.content.trim() : ''
      const browserLaunched = typeof data?.lifecycle?.launched === 'boolean'
        ? data.lifecycle.launched
        : null
      if (parsed.success !== true) {
        return failedResult(startedAt, envelopeError(parsed) ?? 'agent-browser read failed', browserLaunched, true, fallbackDomains)
      }
      if (browserLaunched !== false) {
        return failedResult(startedAt, 'agent-browser explicit URL read did not confirm HTTP-only execution', browserLaunched, true, fallbackDomains)
      }
      if (content.length < this.minContentChars) {
        return failedResult(
          startedAt,
          `agent-browser returned insufficient article content (${content.length} chars)`,
          false,
          true,
          fallbackDomains,
        )
      }

      return {
        status: 'succeeded',
        content,
        finalUrl: document.finalUrl,
        contentType: document.contentType,
        source: stringOrNull(data?.source),
        httpStatus: document.status,
        truncated: data?.truncated === true,
        browserLaunched: false,
        fallbackAllowed: true,
        allowedFallbackDomains: fallbackDomains,
        durationMs: Date.now() - startedAt,
        error: null,
      }
    } catch (error) {
      const status = isTimeoutError(error) ? 'timed_out' : 'failed'
      return {
        ...failedResult(startedAt, safeError(error), null, true, fallbackDomains),
        status,
      }
    }
  }

  /**
   * Keeps the direct-read kill switch fail-safe: browser fallback is allowed
   * only after the same redirect-by-redirect public fetch has vetted the URL.
   */
  async vetForBrowserFallback(rawUrl: string): Promise<AgentBrowserReadResult> {
    const startedAt = Date.now()
    try {
      const document = await this.fetchDocumentImpl(rawUrl)
      return {
        ...failedResult(
          startedAt,
          'Direct article conversion is disabled; using contained browser fallback',
          null,
          true,
          [...new Set(document.visitedHosts)],
        ),
        finalUrl: document.finalUrl,
        contentType: document.contentType,
        httpStatus: document.status,
      }
    } catch (error) {
      return failedResult(startedAt, safeError(error), null, false)
    }
  }
}

async function withLoopbackDocument<T>(document: SafePublicDocument, run: (url: string) => Promise<T>): Promise<T> {
  const token = randomUUID()
  const path = `/document/${token}`
  const server = createServer((request, response) => {
    if ((request.method !== 'GET' && request.method !== 'HEAD') || request.url !== path) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, {
      'content-type': document.contentType ?? 'application/octet-stream',
      'content-length': document.body.length,
      'cache-control': 'no-store',
    })
    if (request.method === 'HEAD') response.end()
    else response.end(document.body)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeServer(server)
    throw new Error('Could not bind loopback document server')
  }
  try {
    return await run(`http://127.0.0.1:${address.port}${path}`)
  } finally {
    await closeServer(server)
  }
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

function failedResult(
  startedAt: number,
  error: string,
  browserLaunched: boolean | null = null,
  fallbackAllowed = true,
  allowedFallbackDomains: string[] = [],
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
    allowedFallbackDomains,
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
