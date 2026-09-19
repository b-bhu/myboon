import { HermesService } from '../hermes'
import { positiveInteger } from '../pipeline-store/cli-env'
import { XDeskStore } from './store'
import type { XDeskStoredCandidate } from './types'

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_BATCH_SIZE = 3
const DEFAULT_RETRY_DELAY_MS = 10 * 60_000
const DEFAULT_MAX_ATTEMPTS = 5
const DISCORD_MESSAGE_LIMIT = 1_900

interface HermesSender {
  send(request: { target: string, message: string, timeoutMs: number }): Promise<unknown>
}

export interface XDeskNotifier {
  send(candidates: XDeskStoredCandidate[]): Promise<void>
}

export interface XDeskNotificationConfig {
  target: string | null
  timeoutMs: number
  batchSize: number
  retryDelayMs: number
  maxAttempts: number
}

export interface XDeskNotificationResult {
  attempted: number
  sent: number
  failed: number
  error: string | null
}

function bounded(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}

export function firstEvidenceUrl(evidence: unknown[]): string | null {
  let found: string | null = null
  const visit = (value: unknown): void => {
    if (found) return
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
      found = value
      return
    }
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach(visit)
  }
  visit(evidence)
  return found
}

const SOURCE_LABELS = new Map<string, string>([
  ['bloomberg.com', 'Bloomberg'],
  ['coindesk.com', 'CoinDesk'],
  ['cointelegraph.com', 'Cointelegraph'],
  ['cointribune.com', 'Cointribune'],
  ['cryptobriefing.com', 'Crypto Briefing'],
  ['decrypt.co', 'Decrypt'],
  ['lookonchain.com', 'Lookonchain'],
  ['reuters.com', 'Reuters'],
  ['theblock.co', 'The Block'],
  ['twitter.com', 'X'],
  ['x.com', 'X'],
  ['youtube.com', 'YouTube'],
])

export function sourceLabelFromUrl(value: string | null): string {
  if (!value) return 'News feed'
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, '')
    for (const [domain, label] of SOURCE_LABELS) {
      if (hostname === domain || hostname.endsWith(`.${domain}`)) return label
    }
    const parts = hostname.split('.')
    const generic = parts.length > 1 ? parts[parts.length - 2] : parts[0]
    if (!generic) return 'News feed'
    return generic
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
  } catch {
    return 'News feed'
  }
}

function codeSafe(value: string): string {
  return value.replace(/```/g, 'ˋˋˋ')
}

export function formatXDeskDiscordMessage(candidates: XDeskStoredCandidate[]): string {
  if (candidates.length === 0) throw new Error('X Desk Discord message needs at least one candidate')
  const heading = `🟢 **X Desk found ${candidates.length} potential X post${candidates.length === 1 ? '' : 's'}**`
  const footer = '_Review only — nothing was posted automatically._'
  const blocks = candidates.map((candidate, index) => {
    const entity = bounded(candidate.entityName ?? candidate.entitySlug ?? candidate.entityId, 100)
    const confidence = candidate.confidence === null ? 'n/a' : `${Math.round(candidate.confidence * 100)}%`
    const post = codeSafe(bounded(candidate.postText ?? '', 280))
    const source = sourceLabelFromUrl(firstEvidenceUrl(candidate.memory.evidence))
    return [
      `**${index + 1}. ${entity}** · confidence ${confidence}`,
      '```',
      post,
      '```',
      `source- ${source}`,
      `Ref: ${candidate.id}`,
    ].join('\n')
  })
  let message = [heading, '', ...blocks.flatMap((block) => [block, '']), footer].join('\n')
  if (message.length <= DISCORD_MESSAGE_LIMIT) return message

  // Preserve every draft and its plain source label within Discord's cap.
  message = [heading, '', ...candidates.flatMap((candidate, index) => {
    const entity = bounded(candidate.entityName ?? candidate.entitySlug ?? candidate.entityId, 60)
    const confidence = candidate.confidence === null ? 'n/a' : `${Math.round(candidate.confidence * 100)}%`
    const source = sourceLabelFromUrl(firstEvidenceUrl(candidate.memory.evidence))
    return [
      [
        `**${index + 1}. ${entity}** · confidence ${confidence}`,
        '```',
        codeSafe(candidate.postText ?? ''),
        '```',
        `source- ${source}`,
        `Ref: ${candidate.id}`,
      ].join('\n'),
      '',
    ]
  }), footer].join('\n')
  if (message.length > DISCORD_MESSAGE_LIMIT) throw new Error('X Desk Discord message exceeds the safe delivery limit')
  return message
}

export function xDeskNotificationConfig(env: NodeJS.ProcessEnv = process.env): XDeskNotificationConfig {
  return {
    target: env.X_DESK_NOTIFY_TARGET?.trim() || null,
    timeoutMs: positiveInteger(env.X_DESK_NOTIFY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    batchSize: Math.min(positiveInteger(env.X_DESK_NOTIFY_BATCH_SIZE, DEFAULT_BATCH_SIZE), 3),
    retryDelayMs: positiveInteger(env.X_DESK_NOTIFY_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS),
    maxAttempts: positiveInteger(env.X_DESK_NOTIFY_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS),
  }
}

export class HermesXDeskNotifier implements XDeskNotifier {
  private readonly service: HermesSender

  constructor(
    private readonly target: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    service?: HermesSender,
  ) {
    this.service = service ?? new HermesService({
      command: process.env.X_DESK_HERMES_SEND_COMMAND ?? 'hermes',
    })
  }

  async send(candidates: XDeskStoredCandidate[]): Promise<void> {
    await this.service.send({
      target: this.target,
      message: formatXDeskDiscordMessage(candidates),
      timeoutMs: this.timeoutMs,
    })
  }
}

function safeError(error: unknown): string {
  const value = error as { killed?: unknown, signal?: unknown, code?: unknown, stderr?: unknown }
  const details = [
    value?.killed === true ? 'timed out' : null,
    typeof value?.signal === 'string' ? `signal ${value.signal}` : null,
    typeof value?.code === 'string' || typeof value?.code === 'number' ? `code ${value.code}` : null,
    typeof value?.stderr === 'string' && value.stderr.trim() ? value.stderr.trim() : null,
  ].filter(Boolean)
  if (details.length > 0) return `Hermes notification failed: ${details.join('; ')}`.slice(0, 1_000)
  return `Hermes notification failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1_000)
}

export async function deliverXDeskNotifications(options: {
  store: XDeskStore
  notifier: XDeskNotifier
  config: XDeskNotificationConfig
  now?: string
}): Promise<XDeskNotificationResult> {
  const observedAt = options.now ?? new Date().toISOString()
  const { target } = options.config
  if (!target) return { attempted: 0, sent: 0, failed: 0, error: null }
  const candidates = options.store.fetchNotificationWork(
    target,
    options.config.batchSize,
    observedAt,
    options.config.maxAttempts,
  )
  if (candidates.length === 0) return { attempted: 0, sent: 0, failed: 0, error: null }

  try {
    await options.notifier.send(candidates)
    options.store.recordNotificationsSent(candidates.map((candidate) => candidate.id), target, observedAt)
    return { attempted: candidates.length, sent: candidates.length, failed: 0, error: null }
  } catch (error) {
    const message = safeError(error)
    options.store.recordNotificationFailure(
      candidates.map((candidate) => candidate.id),
      target,
      message,
      new Date(Date.parse(observedAt) + options.config.retryDelayMs).toISOString(),
      options.config.maxAttempts,
      observedAt,
    )
    return { attempted: candidates.length, sent: 0, failed: candidates.length, error: message }
  }
}
