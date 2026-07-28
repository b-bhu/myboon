import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { normalizeExtraction } from './normalization'
import type { EntityMemoryExtraction, ExtractionProvider, ResearchPacket } from './types'

const execFileAsync = promisify(execFile)

export interface HermesEntityExtractionOptions {
  command?: string
  timeoutMs?: number
  toolsets?: string
  ignoreRules?: boolean
}

function extractJson<T>(text: string): T | null {
  const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  try {
    return JSON.parse(cleaned) as T
  } catch {
    // Continue into fragment extraction.
  }

  const start = cleaned.search(/[{[]/)
  if (start === -1) return null
  const opener = cleaned[start]
  const closer = opener === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escape = false
  for (let index = start; index < cleaned.length; index += 1) {
    const ch = cleaned[index]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\' && inString) {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === opener) depth += 1
    if (ch === closer) depth -= 1
    if (depth === 0) {
      try {
        return JSON.parse(cleaned.slice(start, index + 1)) as T
      } catch {
        return null
      }
    }
  }
  return null
}

function compactString(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value
}

function compactForPrompt(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return compactString(value, depth <= 1 ? 2_000 : 800)
  if (typeof value !== 'object' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, depth <= 1 ? 10 : 6).map((item) => compactForPrompt(item, depth + 1))
  if (depth >= 5) return '[truncated]'

  const output: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value).slice(0, 30)) {
    output[key] = compactForPrompt(nested, depth + 1)
  }
  return output
}

function packetForPrompt(packet: ResearchPacket): ResearchPacket {
  return {
    ...packet,
    summary: compactString(packet.summary, 1_500),
    body: compactString(packet.body, 4_000),
    evidence: compactForPrompt(packet.evidence) as unknown[],
    context: compactForPrompt(packet.context) as Record<string, unknown>,
  }
}

function sanitizeHermesError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(String(error).slice(0, 800))
  const anyError = error as Error & { code?: unknown, signal?: unknown, stderr?: unknown }
  const stderr = typeof anyError.stderr === 'string' ? anyError.stderr.replace(/\s+/g, ' ').slice(0, 800) : ''
  const detail = [
    typeof anyError.code === 'string' || typeof anyError.code === 'number' ? `code=${anyError.code}` : '',
    typeof anyError.signal === 'string' ? `signal=${anyError.signal}` : '',
    stderr ? `stderr=${stderr}` : '',
  ].filter(Boolean).join(' ')
  return new Error(`Hermes entity extraction failed${detail ? ` (${detail})` : ''}`)
}

function buildPrompt(packet: ResearchPacket): string {
  const compactPacket = packetForPrompt(packet)
  return [
    'You are the myboon Entity Extraction Agent.',
    '',
    'Assign the research packet to durable primary entities and create memory entries for their research record.',
    'Do not write to a database. Do not make editor, publisher, or feed decisions.',
    'Do not judge evidence quality, importance, causality, sentiment, or whether the item is publishable.',
    'Do not use verdict language such as weak, strong, reject, accept, blocked, noise, likely, plausibly, no signal, or needs more research.',
    'If the packet contains diagnostics or missing data, preserve them as factual context only.',
    'Do not extract every named object. Pick only the durable primary entity/entities this memory should live under.',
    'Source objects are not entities by default: Polymarket markets, article URLs, headlines, Reddit threads, and source pages belong in memory context/evidence.',
    'Only propose a new entity when the packet is clearly about a durable real-world/project/asset/person/organization/topic and the memory cannot fit an existing primary entity.',
    'For example, an Ethereum market signal or Ethereum Foundation layoff article usually belongs under Ethereum; Ethereum Foundation can be a mention unless the packet is primarily about the foundation as a durable entity.',
    'For every memory, write summary as a concise, neutral, standalone one- or two-line description of the concrete event, signal, or change.',
    'Write the summary for a reader who cannot see the research packet. Name the subject and state what happened without source/pipeline framing such as "research packet observed" or "the source reported".',
    'Do not add editorial interpretation, recommendations, importance claims, or facts that are not present in the packet. Keep research detail in body, evidence, metrics, and context.',
    '',
    'Return strict JSON only with this shape:',
    JSON.stringify({
      primaryEntities: [{
        name: 'Ethereum',
        type: 'asset',
        slug: 'ethereum',
        aliases: ['ETH', 'Ethereum'],
        summary: 'One sentence durable description of the entity.',
        createIfMissing: true,
        createReason: 'Why this is a durable primary entity, not a source object.',
        metadata: { symbol: 'ETH' },
      }],
      memories: [{
        entitySlug: 'ethereum',
        memoryType: 'market_signal',
        title: 'ETH $3,000 Polymarket market research packet',
        summary: 'Polymarket odds for Ethereum reaching $3,000 by Dec. 31, 2026 moved from 18.5% to 29%.',
        body: 'Optional neutral detail about sources checked and source-native observations.',
        eventAt: packet.eventAt ?? packet.observedAt,
        confidence: 0.7,
        evidence: [{ url: 'https://example.com', title: 'Source title' }],
        mentions: ['Ethereum Foundation', 'Polymarket'],
        metrics: { current_yes: 0.29, previous_yes: 0.185 },
        context: { source_market_title: 'Will Ethereum reach $3,000 by December 31, 2026?' },
        observedAt: packet.observedAt,
      }],
    }, null, 2),
    '',
    'Allowed memoryType values: research_note, market_signal, news_event, social_signal, timeline_event, metric_change.',
    '',
    'Research packet:',
    JSON.stringify(compactPacket, null, 2),
  ].join('\n')
}

export class HermesEntityExtractionProvider implements ExtractionProvider {
  private readonly command: string
  private readonly timeoutMs: number
  private readonly toolsets: string
  private readonly ignoreRules: boolean

  constructor(options: HermesEntityExtractionOptions = {}) {
    this.command = options.command ?? 'hermes'
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.toolsets = options.toolsets ?? ''
    this.ignoreRules = options.ignoreRules ?? true
  }

  async extract(packet: ResearchPacket): Promise<EntityMemoryExtraction> {
    const prompt = buildPrompt(packet)
    const args = this.ignoreRules ? ['--ignore-rules'] : []
    args.push(...(this.toolsets ? ['-t', this.toolsets, '-z', prompt] : ['-z', prompt]))
    try {
      const { stdout } = await execFileAsync(this.command, args, {
        timeout: this.timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env },
      })
      const parsed = extractJson<unknown>(stdout)
      return normalizeExtraction(parsed, packet)
    } catch (error) {
      throw sanitizeHermesError(error)
    }
  }
}

export const __testing = {
  buildPrompt,
  extractJson,
  packetForPrompt,
}
