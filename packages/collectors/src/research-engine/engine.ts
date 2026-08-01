import { HermesService, extractJson } from '../hermes'
import type {
  ResearchConclusion,
  ResearchEvidence,
  ResearchOutcome,
  ResearchTask,
  ResearchVerifiedFact,
} from './types'

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_TOOLSETS = ['browser', 'web']

export interface ResearchEngineOptions {
  hermes: HermesService
  /** hermes chat profile; default RESEARCH_ENGINE_HERMES_PROFILE when set. */
  profile?: string
  /** Toolsets the agent runs with. Default browser+web - the read-pages mode. */
  toolsets?: string[]
  timeoutMs?: number
}

interface RawConclusion {
  outcome?: unknown
  summary?: unknown
  what_changed?: unknown
  verified_facts?: unknown
  unverified_claims?: unknown
  checked?: unknown
  open_questions?: unknown
  evidence_links?: unknown
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function asEvidence(value: unknown): ResearchEvidence[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const url = asString(record.url).trim()
    if (!url) return []
    const note = asString(record.note).trim()
    return [{ url, title: asString(record.title, 'Source') , ...(note ? { note } : {}) }]
  })
}

function asVerifiedFacts(value: unknown): ResearchVerifiedFact[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const fact = asString(record.fact).trim()
    if (!fact) return []
    return [{ fact, evidence: asEvidence(record.evidence) }]
  })
}

function buildResearchPrompt(task: ResearchTask): string {
  const known = task.known && task.known.recentMemories.length > 0
    ? JSON.stringify({
      entities: task.known.entities.map((entity) => ({
        slug: entity.slug,
        name: entity.name,
        summary: entity.summary,
      })),
      timeline_newest_first: task.known.recentMemories.map((memory) => ({
        event_at: memory.eventAt,
        memory_type: memory.memoryType,
        title: memory.title,
        summary: memory.summary,
      })),
    }, null, 2)
    : 'Nothing - this subject is new to us.'

  return [
    'You are the myboon Research Engine.',
    'You have browser and web tools. Your job is to actually READ sources - open pages, verify claims - and answer ONE focused question.',
    'You are updating an entity\'s knowledge timeline, not writing a story and not collecting links.',
    '',
    'THE QUESTION',
    task.question,
    '',
    'WHAT TRIGGERED THIS',
    JSON.stringify({
      source: task.source,
      subject: task.subject,
      title: task.title,
      signal: task.signal,
      observed_at: task.observedAt,
    }, null, 2),
    '',
    'WHAT WE ALREADY KNOW - do not re-research these facts:',
    known,
    '',
    'SOURCE-NATIVE CONTEXT (already verified by the collector, do not re-research):',
    task.sourceContext ? JSON.stringify(task.sourceContext, null, 2) : 'None supplied.',
    '',
    'WHAT COUNTS AS AN ANSWER',
    task.answerSpec.instruction,
    '',
    'METHOD',
    '- Search for and OPEN primary or credible sources. A search-result snippet is not verification - read the page.',
    '- Every verified fact must cite at least one source you actually opened, by URL.',
    '- Keep verified facts and unverified claims strictly separate.',
    '- Stop when you can answer the question, or when you have checked the obvious places and found nothing. Your stop condition is knowledge, not search count.',
    '- It is a GOOD outcome to conclude nothing happened. Do not pad thin findings into an answer. If your outcome is nothing_found you MUST list what you checked.',
    '',
    'OUTPUT - return strict JSON only, no markdown fences:',
    JSON.stringify({
      outcome: 'answered | nothing_found | partial',
      summary: 'two or three sentences a human can act on',
      what_changed: 'the delta versus the timeline above, one or two sentences',
      verified_facts: [{ fact: 'concrete dated fact', evidence: [{ url: 'https://...', title: 'source title' }] }],
      unverified_claims: ['claims seen but not verified'],
      checked: ['places/queries actually checked - required for nothing_found'],
      open_questions: ['what would settle the remaining uncertainty'],
      evidence_links: [{ url: 'https://...', title: 'source title', note: 'why it matters' }],
    }, null, 2),
  ].join('\n')
}

function failed(task: ResearchTask, raw: string, durationMs: number, summary: string): ResearchConclusion {
  return {
    taskId: task.taskId,
    outcome: 'engine_failed',
    summary,
    whatChanged: '',
    verifiedFacts: [],
    unverifiedClaims: [],
    checked: [],
    openQuestions: [],
    evidenceLinks: [],
    raw,
    durationMs,
  }
}

export class ResearchEngine {
  private readonly hermes: HermesService
  private readonly profile?: string
  private readonly toolsets: string[]
  private readonly timeoutMs: number

  constructor(options: ResearchEngineOptions) {
    this.hermes = options.hermes
    this.profile = options.profile ?? process.env.RESEARCH_ENGINE_HERMES_PROFILE ?? undefined
    this.toolsets = options.toolsets ?? DEFAULT_TOOLSETS
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /**
   * Run one research task to a conclusion. Never throws for run-level
   * failures: process errors, timeouts and unparseable output all come back
   * as outcome 'engine_failed' so the caller can route them to its existing
   * retry lane. Guardrails applied to model output:
   *  - 'nothing_found' without a checked-list downgrades to 'partial'
   *    (an unaccounted nothing is not a conclusion),
   *  - 'answered' without verified facts downgrades to 'partial'
   *    (an answer with no evidence is a claim, not an answer).
   */
  async research(task: ResearchTask): Promise<ResearchConclusion> {
    const result = await this.hermes.chat({
      purpose: `research-engine.${task.source}.${task.answerSpec.kind}`,
      prompt: buildResearchPrompt(task),
      timeoutMs: this.timeoutMs,
      profile: this.profile,
      toolsets: this.toolsets,
    })

    if (result.status !== 'succeeded') {
      return failed(
        task,
        [result.stdout, result.stderr].filter(Boolean).join('\n---stderr---\n'),
        result.durationMs,
        `Research engine run ${result.status} (exit=${result.exitCode ?? 'none'}).`
      )
    }

    const parsed = extractJson<RawConclusion>(result.stdout)
    if (!parsed) {
      return failed(task, result.stdout, result.durationMs, 'Research engine returned no parseable JSON conclusion.')
    }

    const rawOutcome = asString(parsed.outcome)
    if (rawOutcome !== 'answered' && rawOutcome !== 'nothing_found' && rawOutcome !== 'partial') {
      return failed(task, result.stdout, result.durationMs, `Research engine returned unknown outcome '${rawOutcome.slice(0, 60)}'.`)
    }

    const verifiedFacts = asVerifiedFacts(parsed.verified_facts)
    const checked = asStringArray(parsed.checked)

    let outcome: ResearchOutcome = rawOutcome
    if (outcome === 'nothing_found' && checked.length === 0) outcome = 'partial'
    if (outcome === 'answered' && verifiedFacts.length === 0) outcome = 'partial'

    return {
      taskId: task.taskId,
      outcome,
      summary: asString(parsed.summary).trim(),
      whatChanged: asString(parsed.what_changed).trim(),
      verifiedFacts,
      unverifiedClaims: asStringArray(parsed.unverified_claims),
      checked,
      openQuestions: asStringArray(parsed.open_questions),
      evidenceLinks: asEvidence(parsed.evidence_links),
      raw: result.stdout,
      durationMs: result.durationMs,
    }
  }
}

export const __testing = {
  buildResearchPrompt,
}
