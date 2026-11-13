/**
 * #612 Catch-up editor + publish proof of concept.
 *
 * One script: read a local entity-manager snapshot, ask the model whether each
 * touched entity is worth a Catch-up update now, draft those that are, run two
 * checks, and write JSON + markdown. No database connection, no table writes,
 * no new package, no cron. Does not touch the old editor-draft or publisher.
 *
 *   pnpm --filter @myboon/collectors catch-up-poc -- --snapshot packages/collectors/artifacts/catch-up-poc/snapshot.json
 *   pnpm --filter @myboon/collectors catch-up-poc -- --print-snapshot-sql --hours 24
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const DEFAULT_HOURS = 24
export const DEFAULT_LIMIT = 12
export const DEFAULT_MODEL = 'glm-5.3-flash'
export const DEFAULT_TIMEOUT_MS = 30_000
export const MAX_RECENT_ITEMS = 7

export const SNAPSHOT_SQL = `
with params as (
  select (now() - interval '24 hours') as since, now() as until
),
touched as (
  select
    i.main_entity_id as entity_id,
    max(i.created_at) as latest_item_created_at,
    count(*)::int as new_item_count,
    jsonb_agg(i.id order by i.created_at desc, i.id desc) as new_item_ids
  from atlas.entity_items i, params p
  where i.status = 'active' and i.created_at >= p.since
  group by i.main_entity_id
),
new_items as (
  select i.main_entity_id as entity_id, i.id, i.title, i.summary,
         i.occurred_at, i.created_at, i.signal_id, i.angle, i.note, i.image_url, i.status
  from atlas.entity_items i, params p
  where i.status = 'active' and i.created_at >= p.since
),
prior as (
  select t.entity_id,
         i.id, i.title, i.summary, i.occurred_at, i.created_at,
         i.signal_id, i.angle, i.note, i.image_url, i.status
  from touched t
  join lateral (
    select *
    from atlas.entity_items i
    where i.main_entity_id = t.entity_id and i.status = 'active'
      and i.created_at < (select since from params)
    order by coalesce(i.occurred_at, i.created_at) desc, i.id desc
    limit 7
  ) i on true
),
item_rows as (
  select * from prior
  union
  select * from new_items
),
origin_signal_ids as (
  select distinct ir.entity_id, x.signal_id
  from item_rows ir
  cross join lateral (
    select s.signal_id from atlas.item_signals s where s.item_id = ir.id and s.role = 'origin'
    union
    select ir.signal_id where ir.signal_id is not null
  ) x
  where x.signal_id is not null
)
select jsonb_build_object(
  'generated_at', (select until from params),
  'window', jsonb_build_object(
    'field', 'created_at',
    'since', (select since from params),
    'until', (select until from params)
  ),
  'notes', jsonb_build_array(
    'Touched entities are those with an active entity_items row added in the window (created_at).',
    'prior_items are the last 7 active items created BEFORE the window, ordered by coalesce(occurred_at, created_at) desc, id desc. Items added in the window are never prior context.',
    'new_items are every active item added in the window, included even when they fall outside the last 7.',
    'origin_signals come from item_signals.role = origin, plus item.signal_id when no link row exists.',
    'last_update is the newest prior item (what Atlas already holds for the entity), or null. atlas.stories is empty on prod, so Atlas has no editorial narrative yet. No public.* table is read.',
    'Parked entity_context is omitted in v1.'
  ),
  'entities', (
    select coalesce(jsonb_agg(entity_json order by latest_item_created_at desc), '[]'::jsonb)
    from (
      select t.latest_item_created_at,
        jsonb_build_object(
          'id', e.id,
          'slug', e.slug,
          'name', e.name,
          'type', e.type,
          'summary', e.summary,
          'latest_item_created_at', t.latest_item_created_at,
          'new_item_count', t.new_item_count,
          'new_item_ids', t.new_item_ids,
          'new_items', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', n.id, 'title', n.title, 'summary', n.summary,
              'occurred_at', n.occurred_at, 'created_at', n.created_at, 'signal_id', n.signal_id,
              'angle', n.angle, 'note', n.note, 'image_url', n.image_url, 'status', n.status
            ) order by n.created_at desc, n.id desc), '[]'::jsonb)
            from new_items n where n.entity_id = t.entity_id
          ),
          'prior_items', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'id', r.id, 'title', r.title, 'summary', r.summary,
              'occurred_at', r.occurred_at, 'created_at', r.created_at, 'signal_id', r.signal_id,
              'angle', r.angle, 'note', r.note, 'image_url', r.image_url, 'status', r.status
            ) order by coalesce(r.occurred_at, r.created_at) desc, r.id desc), '[]'::jsonb)
            from prior r where r.entity_id = t.entity_id
          ),
          'origin_signals', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'signal_id', s.signal_id, 'type', s.type, 'source', s.source,
              'text', s.text, 'excerpt', s.excerpt, 'numbers', s.numbers, 'link', s.link,
              'occurred_at', s.occurred_at, 'created_at', s.created_at
            ) order by s.signal_id), '[]'::jsonb)
            from origin_signal_ids o
            join atlas.signals s on s.signal_id = o.signal_id
            where o.entity_id = t.entity_id
          ),
          'last_update', (
            select jsonb_build_object(
              'id', r.id, 'title', r.title, 'summary', r.summary, 'note', r.note,
              'occurred_at', r.occurred_at, 'created_at', r.created_at
            )
            from prior r
            where r.entity_id = t.entity_id
            order by coalesce(r.occurred_at, r.created_at) desc, r.id desc
            limit 1
          )
        ) as entity_json
      from touched t
      join atlas.entities e on e.id = t.entity_id
    ) q
  )
) as snapshot;
`.trim()

export const SYSTEM_PROMPT = `You are the Catch-up editor for MyBoon.

Write for a curious market reader. Make the signal clear, concrete, and easy to follow. Do not write like a database summary, and do not mention pipelines, memory lanes, bundles, snapshots, or source ids in the reader-facing copy.

Your job is one question: is this worth putting in front of the user now?

Choose exactly one action:
- write: a reader should see a Catch-up update now. A brand-new item on an entity with no earlier items can still be write.
- hold: it may matter, but the evidence is still too thin or incomplete. Wait for more.
- skip: the last update already covers this, or it is not worth the reader's attention.

Do not use watch, needs_more_research, or merge.

For write, draft a short Catch-up update with:
- title: a short, plain-English headline
- what_happened: what changed
- how_we_got_here: the recent path that led here
- what_to_watch: what is still open, without telling the reader what to do
- claims: every factual claim in the draft, each linked to a source item id or origin signal id from the supplied bundle

Aim for about 90-140 words across the three parts. Use concrete numbers only when they appear in the supplied items or their linked origin signals. Do not invent facts or numbers. Do not promise an edge. Do not give trading, investment, or any other advice. Do not overstate causality.

If a last update is supplied, it is the newest earlier item Atlas already holds for this entity. Compare the new items with it and the earlier items before choosing write. If they already cover the new items, choose skip.

Return strict JSON only, no markdown outside a JSON object:

{
  "decision": "write | hold | skip",
  "reason": "one-line reason",
  "title": "headline or null",
  "what_happened": "text or null",
  "how_we_got_here": "text or null",
  "what_to_watch": "text or null",
  "claims": [
    { "text": "claim", "source_item_id": "item uuid or null", "source_signal_id": "signal id or null" }
  ]
}

For hold and skip, set title, the three parts, and claims to null or [].
`

export type DecisionAction = 'write' | 'hold' | 'skip'
export const DECISIONS = ['write', 'hold', 'skip'] as const

export type CatchUpItem = {
  id: string
  title: string
  summary: string | null
  occurred_at: string | null
  created_at: string
  signal_id: string | null
  angle?: string | null
  note?: string | null
  image_url?: string | null
  status?: string | null
}

export type CatchUpSignal = {
  signal_id: string
  type?: string | null
  source?: string | null
  text: string | null
  excerpt: string | null
  numbers: unknown
  link?: string | null
  occurred_at?: string | null
  created_at?: string | null
}

export type LastUpdate = {
  id: string
  title: string | null
  summary: string | null
  note?: string | null
  occurred_at: string | null
  created_at: string
}

export type CatchUpEntity = {
  id: string
  slug: string
  name: string
  type: string
  summary: string | null
  latest_item_created_at: string
  new_item_count?: number
  new_item_ids?: string[]
  new_items: CatchUpItem[]
  prior_items: CatchUpItem[]
  origin_signals: CatchUpSignal[]
  last_update: LastUpdate | null
}

export type CatchUpSnapshot = {
  generated_at: string
  window: { field: string; since: string; until: string }
  notes?: string[]
  entities: CatchUpEntity[]
}

export type Claim = {
  text: string
  source_item_id?: string | null
  source_signal_id?: string | null
}

export type CatchUpDraft = {
  title: string
  what_happened: string
  how_we_got_here: string
  what_to_watch: string
  claims: Claim[]
}

export type ParsedDecision =
  | { decision: 'hold' | 'skip'; reason: string }
  | { decision: 'write'; reason: string; draft: CatchUpDraft }

export type CheckFailure = { check: 'claims' | 'numbers'; detail: string }

export type DraftCheckResult = {
  status: 'passed' | 'failed'
  failures: CheckFailure[]
}

export type LastUpdateRef = { id: string; title: string | null; date: string | null }

export type EntityResult =
  | {
      entity_id: string
      slug: string
      name: string
      status: 'ok'
      action: 'hold' | 'skip'
      reason: string
      last_update: LastUpdateRef | null
    }
  | {
      entity_id: string
      slug: string
      name: string
      status: 'ok'
      action: 'write'
      reason: string
      draft: CatchUpDraft
      word_count: number
      check_status: 'passed' | 'failed'
      check_failures: CheckFailure[]
      last_update: LastUpdateRef | null
    }
  | {
      entity_id: string
      slug: string
      name: string
      status: 'errored'
      error: string
      last_update: LastUpdateRef | null
    }

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }
export type Llm = (messages: ChatMessage[]) => Promise<string>

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const ISO_DATE_RE = /\d{4}-\d{2}-\d{2}(?:[tT ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|Z|[+-]\d{2}:?\d{2})?)?/g
const NUMERIC_DATE_RE = /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g
const MONTHS = 'jan(?:uary|\.)?|feb(?:ruary|\.)?|mar(?:ch|\.)?|apr(?:il|\.)?|may\.?|jun(?:e|\.)?|jul(?:y|\.)?|aug(?:ust|\.)?|sep(?:tember|\.)?|oct(?:ober|\.)?|nov(?:ember|\.)?|dec(?:ember|\.)?'
const MONTH_DATE_RE = new RegExp(`\\b(?:${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s*\\d{4})?\\b`, 'gi')
const DAY_MONTH_RE = new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})(?:,?\\s*\\d{4})?\\b`, 'gi')
const TIME_RE = /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:am|pm))?\b/gi
const YEAR_RE = /\b(?:19|20)\d{2}\b/g
const HEX_ID_RE = /\b[0-9a-f]{16,}\b/gi
const URL_RE = /https?:\/\/\S+/gi
const NUMBER_TOKEN_RE = /(?:\$|usd\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s*(?:[kmb]|thousand|million|billion))?(?:\s*%)?/gi

/** Mask ids, URLs, and dates so they are not treated as invented numbers. */
export function maskIgnoredSpans(text: string): string {
  return text
    .replace(URL_RE, ' ')
    .replace(UUID_RE, ' ')
    .replace(ISO_DATE_RE, ' ')
    .replace(NUMERIC_DATE_RE, ' ')
    .replace(MONTH_DATE_RE, ' ')
    .replace(DAY_MONTH_RE, ' ')
    .replace(TIME_RE, ' ')
    .replace(HEX_ID_RE, ' ')
    .replace(YEAR_RE, ' ')
}

/** Canonical form: lowercase, no thousands separators, k/m/b suffixes, no spaces. */
export function canonicalizeNumberText(text: string): string {
  return text
    .toLowerCase()
    .replace(/usd\s*/g, '$')
    .replace(/,/g, '')
    .replace(/\bthousand\b/g, 'k')
    .replace(/\bmillion\b/g, 'm')
    .replace(/\bbillion\b/g, 'b')
    .replace(/\s+/g, '')
}

export function extractNumericTokens(text: string): string[] {
  const masked = maskIgnoredSpans(text)
  const found: string[] = []
  const seen = new Set<string>()
  for (const match of masked.matchAll(NUMBER_TOKEN_RE)) {
    const token = canonicalizeNumberText(match[0] ?? '')
    if (!token || token === '$' || seen.has(token)) continue
    // A lone suffix-less integer that is just "0" is still a number; keep it.
    seen.add(token)
    found.push(token)
  }
  return found
}

export function buildNumberCorpus(entity: Pick<CatchUpEntity, 'new_items' | 'prior_items' | 'origin_signals'>): string {
  const parts: string[] = []
  const seen = new Set<string>()
  for (const item of [...entity.new_items, ...entity.prior_items]) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    parts.push(item.title, item.summary ?? '', item.note ?? '')
  }
  for (const signal of entity.origin_signals) {
    parts.push(signal.text ?? '', signal.excerpt ?? '', JSON.stringify(signal.numbers ?? {}))
  }
  return canonicalizeNumberText(maskIgnoredSpans(parts.join('\n')))
}

export function checkDraftNumbers(draftText: string, corpus: string): CheckFailure[] {
  const failures: CheckFailure[] = []
  for (const token of extractNumericTokens(draftText)) {
    const bare = token.startsWith('$') ? token.slice(1) : token
    if (corpus.includes(token) || (bare && corpus.includes(bare))) continue
    failures.push({ check: 'numbers', detail: `number ${token} is not in the items or their origin signals` })
  }
  return failures
}

export function loadedSourceIds(entity: Pick<CatchUpEntity, 'new_items' | 'prior_items' | 'origin_signals'>): {
  itemIds: Set<string>
  signalIds: Set<string>
} {
  const itemIds = new Set<string>()
  for (const item of [...entity.new_items, ...entity.prior_items]) itemIds.add(item.id)
  const signalIds = new Set<string>()
  for (const signal of entity.origin_signals) signalIds.add(signal.signal_id)
  for (const item of [...entity.new_items, ...entity.prior_items]) {
    if (item.signal_id) signalIds.add(item.signal_id)
  }
  return { itemIds, signalIds }
}

export function checkClaims(claims: Claim[], itemIds: Set<string>, signalIds: Set<string>): CheckFailure[] {
  if (claims.length === 0) {
    return [{ check: 'claims', detail: 'write draft has no claims' }]
  }
  const failures: CheckFailure[] = []
  claims.forEach((claim, index) => {
    const itemId = trimOrNull(claim.source_item_id)
    const signalId = trimOrNull(claim.source_signal_id)
    const label = claim.text.trim() || `claim ${index + 1}`
    if (!itemId && !signalId) {
      failures.push({ check: 'claims', detail: `"${label}" cites no source item or signal` })
      return
    }
    if (itemId && !itemIds.has(itemId)) {
      failures.push({ check: 'claims', detail: `"${label}" cites unknown source_item_id` })
    }
    if (signalId && !signalIds.has(signalId)) {
      failures.push({ check: 'claims', detail: `"${label}" cites unknown source_signal_id` })
    }
  })
  return failures
}

export function runDraftChecks(draft: CatchUpDraft, entity: CatchUpEntity): DraftCheckResult {
  const { itemIds, signalIds } = loadedSourceIds(entity)
  const failures = [
    ...checkClaims(draft.claims, itemIds, signalIds),
    ...checkDraftNumbers(draftText(draft), buildNumberCorpus(entity)),
  ]
  return { status: failures.length ? 'failed' : 'passed', failures }
}

export function draftText(draft: CatchUpDraft): string {
  return [draft.title, draft.what_happened, draft.how_we_got_here, draft.what_to_watch].join('\n')
}

export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0
}

export function draftWordCount(draft: CatchUpDraft): number {
  return wordCount([draft.what_happened, draft.how_we_got_here, draft.what_to_watch].join(' '))
}

export function parseJsonReply(raw: string): Record<string, unknown> {
  let text = raw.trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fenced) text = fenced[1]!.trim()
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a === -1 || b <= a) throw new Error('LLM reply has no JSON object')
  const value: unknown = JSON.parse(text.slice(a, b + 1))
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('LLM reply JSON is not an object')
  }
  return value as Record<string, unknown>
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function trimOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text && text.toLowerCase() !== 'null' ? text : null
}

function parseClaims(value: unknown): Claim[] {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error('claims must be an array')
  return value.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`claims[${index}] is not an object`)
    }
    const rec = row as Record<string, unknown>
    const text = asString(rec.text)
    if (!text) throw new Error(`claims[${index}] is missing text`)
    return {
      text,
      source_item_id: trimOrNull(rec.source_item_id),
      source_signal_id: trimOrNull(rec.source_signal_id),
    }
  })
}

export function parseModelReply(raw: string): ParsedDecision {
  const reply = parseJsonReply(raw)
  const decision = asString(reply.decision).toLowerCase()
  const reason = asString(reply.reason)
  if (!isDecision(decision)) throw new Error(`unknown decision ${JSON.stringify(reply.decision)}`)
  if (!reason) throw new Error('decision is missing a one-line reason')
  if (decision === 'hold' || decision === 'skip') return { decision, reason }
  const title = asString(reply.title)
  const what_happened = asString(reply.what_happened)
  const how_we_got_here = asString(reply.how_we_got_here)
  const what_to_watch = asString(reply.what_to_watch)
  if (!title) throw new Error('write draft is missing a title')
  if (!what_happened || !how_we_got_here || !what_to_watch) {
    throw new Error('write draft is missing one of the three parts')
  }
  return {
    decision: 'write',
    reason,
    draft: {
      title,
      what_happened,
      how_we_got_here,
      what_to_watch,
      claims: parseClaims(reply.claims),
    },
  }
}

function isDecision(value: string): value is DecisionAction {
  return (DECISIONS as readonly string[]).includes(value)
}

export function lastUpdateRef(entity: CatchUpEntity): LastUpdateRef | null {
  const prior = entity.last_update
  if (!prior) return null
  return { id: prior.id, title: prior.title, date: prior.occurred_at ?? prior.created_at }
}

export function selectEntities(entities: CatchUpEntity[], limit: number): CatchUpEntity[] {
  const byRecency = (a: CatchUpEntity, b: CatchUpEntity) =>
    b.latest_item_created_at.localeCompare(a.latest_item_created_at) || a.slug.localeCompare(b.slug)
  const withPrior = entities.filter((entity) => entity.last_update).sort(byRecency)
  const withoutPrior = entities.filter((entity) => !entity.last_update).sort(byRecency)
  if (limit === 0 || limit >= entities.length) return [...entities].sort(byRecency)
  const targetEach = Math.ceil(limit / 2)
  const picked = [
    ...withoutPrior.slice(0, targetEach),
    ...withPrior.slice(0, targetEach),
  ]
  const seen = new Set(picked.map((entity) => entity.id))
  const rest = [...withoutPrior, ...withPrior].filter((entity) => !seen.has(entity.id))
  while (picked.length < limit && rest.length > 0) picked.push(rest.shift()!)
  return picked.slice(0, limit).sort(byRecency)
}

export function filterEntitiesSince(entities: CatchUpEntity[], since: Date): CatchUpEntity[] {
  const sinceMs = since.getTime()
  return entities.filter((entity) =>
    entity.new_items.some((item) => Date.parse(item.created_at) >= sinceMs),
  ).map((entity) => ({
    ...entity,
    new_items: entity.new_items.filter((item) => Date.parse(item.created_at) >= sinceMs),
    new_item_ids: entity.new_item_ids?.filter((id) =>
      entity.new_items.some((item) => item.id === id && Date.parse(item.created_at) >= sinceMs),
    ),
    new_item_count: entity.new_items.filter((item) => Date.parse(item.created_at) >= sinceMs).length,
  })).filter((entity) => entity.new_items.length > 0)
}

export function buildUserMessage(entity: CatchUpEntity): string {
  const itemLine = (item: CatchUpItem, index: number) =>
    `${index + 1}. id: ${item.id} | created_at: ${item.created_at} | occurred_at: ${item.occurred_at ?? 'unknown'} | angle: ${item.angle ?? 'unknown'} | title: ${item.title} | summary: ${item.summary ?? '(none)'}`
  const newIds = new Set(entity.new_items.map((item) => item.id))
  const priorLane = entity.prior_items.filter((item) => !newIds.has(item.id))
  const signals = entity.origin_signals.length
    ? entity.origin_signals.map((signal, index) => {
        const numbers = signal.numbers == null ? '{}' : JSON.stringify(signal.numbers)
        return [
          `${index + 1}. signal_id: ${signal.signal_id} | type: ${signal.type ?? 'unknown'} | occurred_at: ${signal.occurred_at ?? 'unknown'}`,
          `text: ${signal.text ?? '(none)'}`,
          `excerpt: ${signal.excerpt ?? '(none)'}`,
          `numbers: ${numbers}`,
        ].join('\n')
      }).join('\n\n')
    : '(none)'
  const prior = entity.last_update
  const priorBlock = prior
    ? [
        `id: ${prior.id}`,
        `date: ${prior.occurred_at ?? prior.created_at}`,
        `title: ${prior.title ?? '(none)'}`,
        `summary: ${prior.summary ?? '(none)'}`,
      ].join('\n')
    : 'no earlier item'
  return [
    'ENTITY:',
    `name: ${entity.name}`,
    `slug: ${entity.slug}`,
    `type: ${entity.type}`,
    `summary: ${entity.summary ?? '(none)'}`,
    '',
    'NEW ITEMS (added in the window):',
    ...(entity.new_items.length ? entity.new_items.map((item, index) => itemLine(item, index)) : ['(none)']),
    '',
    'EARLIER ITEMS (last 7 before the window):',
    ...(priorLane.length ? priorLane.map((item, index) => itemLine(item, index)) : ['(none)']),
    '',
    'ORIGIN SIGNALS:',
    signals,
    '',
    'LAST UPDATE (newest earlier item):',
    priorBlock,
  ].join('\n')
}

const redact = (text: string, secret: string) => (secret ? text.split(secret).join('[redacted]') : text)
const snip = (text: string) => text.replace(/\s+/g, ' ').slice(0, 300)
const rec = (value: unknown): Record<string, unknown> =>
  (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})

/** Same Ollama Cloud client the analyst and entity-manager use. The key is never logged. */
export function createOllamaLlm(options: {
  apiKey: string
  model: string
  url?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Llm {
  const url = options.url ?? 'https://ollama.com/v1/chat/completions'
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return async (messages) => {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: options.model, messages, temperature: 0, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      throw new Error(`LLM HTTP ${response.status}: ${snip(redact(await response.text(), options.apiKey))}`)
    }
    const content = rec(rec((rec(await response.json()).choices as unknown[] | undefined)?.[0]).message).content
    if (typeof content !== 'string' || !content.trim()) throw new Error('LLM reply has no content')
    return content
  }
}

export function snapshotSqlForWindow(hours: number): string {
  const safeHours = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_HOURS
  return SNAPSHOT_SQL.replace("interval '24 hours'", `interval '${safeHours} hours'`)
}

export type CliOptions = {
  snapshot: string
  outDir: string
  limit: number
  hours: number | null
  since: string | null
  model: string
  timeoutMs: number
  printSnapshotSql: boolean
}

export function parseCli(argv: string[]): CliOptions {
  const args = [...argv]
  const take = (flag: string): string | null => {
    const index = args.indexOf(flag)
    if (index === -1) return null
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`)
    args.splice(index, 2)
    return value
  }
  const printSnapshotSql = args.includes('--print-snapshot-sql')
  if (printSnapshotSql) args.splice(args.indexOf('--print-snapshot-sql'), 1)
  const hoursRaw = take('--hours')
  const limitRaw = take('--limit')
  const timeoutRaw = take('--timeout-ms')
  return {
    snapshot: take('--snapshot') ?? 'packages/collectors/artifacts/catch-up-poc/snapshot.json',
    outDir: take('--out-dir') ?? 'packages/collectors/artifacts/catch-up-poc',
    limit: limitRaw == null ? DEFAULT_LIMIT : Number(limitRaw),
    hours: hoursRaw == null ? null : Number(hoursRaw),
    since: take('--since'),
    model: take('--model') || process.env.CATCH_UP_LLM_MODEL?.trim() || DEFAULT_MODEL,
    timeoutMs: timeoutRaw == null ? DEFAULT_TIMEOUT_MS : Number(timeoutRaw),
    printSnapshotSql,
  }
}

export function resolveSince(snapshot: CatchUpSnapshot, options: Pick<CliOptions, 'hours' | 'since'>): Date | null {
  if (options.since) {
    const date = new Date(options.since)
    if (Number.isNaN(date.getTime())) throw new Error(`invalid --since ${options.since}`)
    return date
  }
  if (options.hours != null) {
    if (!Number.isFinite(options.hours) || options.hours <= 0) throw new Error('invalid --hours')
    const until = Date.parse(snapshot.window.until || snapshot.generated_at)
    if (!Number.isFinite(until)) throw new Error('snapshot window.until is not a date')
    return new Date(until - options.hours * 60 * 60 * 1000)
  }
  return null
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'model timed out'
    return error.message
  }
  return String(error)
}

export async function decideEntity(entity: CatchUpEntity, llm: Llm): Promise<EntityResult> {
  const prior = lastUpdateRef(entity)
  try {
    const raw = await llm([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage(entity) },
    ])
    const parsed = parseModelReply(raw)
    if (parsed.decision !== 'write') {
      return {
        entity_id: entity.id,
        slug: entity.slug,
        name: entity.name,
        status: 'ok',
        action: parsed.decision,
        reason: parsed.reason,
        last_update: prior,
      }
    }
    const checks = runDraftChecks(parsed.draft, entity)
    return {
      entity_id: entity.id,
      slug: entity.slug,
      name: entity.name,
      status: 'ok',
      action: 'write',
      reason: parsed.reason,
      draft: parsed.draft,
      word_count: draftWordCount(parsed.draft),
      check_status: checks.status,
      check_failures: checks.failures,
      last_update: prior,
    }
  } catch (error) {
    return {
      entity_id: entity.id,
      slug: entity.slug,
      name: entity.name,
      status: 'errored',
      error: errorMessage(error).slice(0, 1000),
      last_update: prior,
    }
  }
}

export function summarize(results: EntityResult[]): {
  entities: number
  write: number
  hold: number
  skip: number
  errored: number
  checks_passed: number
  checks_failed: number
} {
  const summary = {
    entities: results.length,
    write: 0,
    hold: 0,
    skip: 0,
    errored: 0,
    checks_passed: 0,
    checks_failed: 0,
  }
  for (const result of results) {
    if (result.status === 'errored') summary.errored++
    else if (result.action === 'write') {
      summary.write++
      if (result.check_status === 'passed') summary.checks_passed++
      else summary.checks_failed++
    } else if (result.action === 'hold') summary.hold++
    else summary.skip++
  }
  return summary
}

export function formatMarkdown(run: {
  run_id: string
  started_at: string
  finished_at: string
  duration_ms: number
  model: string
  snapshot: string
  window: CatchUpSnapshot['window']
  since: string | null
  limit: number
  summary: ReturnType<typeof summarize>
  results: EntityResult[]
}): string {
  const lines = [
    `# Catch-up POC run ${run.run_id}`,
    '',
    `- Started: ${run.started_at}`,
    `- Finished: ${run.finished_at}`,
    `- Duration: ${(run.duration_ms / 1000).toFixed(1)}s`,
    `- Model: ${run.model}`,
    `- Snapshot: ${run.snapshot}`,
    `- Snapshot window: ${run.window.since} to ${run.window.until} (by ${run.window.field})`,
    `- Extra since filter: ${run.since ?? '(none)'}`,
    `- Limit: ${run.limit === 0 ? 'all' : run.limit}`,
    '',
    '## Counts',
    '',
    `- Entities: ${run.summary.entities}`,
    `- Write: ${run.summary.write} (checks passed ${run.summary.checks_passed}, failed ${run.summary.checks_failed})`,
    `- Hold: ${run.summary.hold}`,
    `- Skip: ${run.summary.skip}`,
    `- Errored: ${run.summary.errored}`,
    '',
  ]
  for (const result of run.results) {
    lines.push(`## ${result.name} (\`${result.slug}\`)`)
    lines.push('')
    if (result.status === 'errored') {
      lines.push(`- Status: errored`)
      lines.push(`- Error: ${result.error}`)
    } else {
      lines.push(`- Decision: ${result.action}`)
      lines.push(`- Reason: ${result.reason}`)
      if (result.action === 'write') {
        lines.push(`- Check: ${result.check_status}`)
        if (result.check_failures.length) {
          for (const failure of result.check_failures) lines.push(`  - ${failure.check}: ${failure.detail}`)
        }
        lines.push(`- Word count (three parts): ${result.word_count}`)
        lines.push('')
        lines.push(`### ${result.draft.title}`)
        lines.push('')
        lines.push(`**What happened.** ${result.draft.what_happened}`)
        lines.push('')
        lines.push(`**How we got here.** ${result.draft.how_we_got_here}`)
        lines.push('')
        lines.push(`**What to watch.** ${result.draft.what_to_watch}`)
      }
    }
    if (result.last_update) {
      lines.push('')
      lines.push(`Atlas last update \`${result.last_update.id}\` (${result.last_update.title ?? 'untitled'}, ${result.last_update.date ?? 'no date'}).`)
    } else {
      lines.push('')
      lines.push('No earlier Atlas item for this entity.')
    }
    lines.push('')
  }
  return lines.join('\n')
}

export function makeRunId(now = new Date()): string {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return iso
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseCli(argv)
  if (options.printSnapshotSql) {
    const hours = options.hours ?? DEFAULT_HOURS
    process.stdout.write(`${snapshotSqlForWindow(hours)}\n`)
    return
  }
  if (!Number.isFinite(options.limit) || options.limit < 0) throw new Error('invalid --limit')
  const snapshotPath = path.resolve(options.snapshot)
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as CatchUpSnapshot
  if (!snapshot || !Array.isArray(snapshot.entities)) throw new Error('snapshot is missing entities')
  const since = resolveSince(snapshot, options)
  const inWindow = since ? filterEntitiesSince(snapshot.entities, since) : snapshot.entities
  const selected = selectEntities(inWindow, options.limit)
  const apiKey = process.env.OLLAMA_API_KEY?.trim()
  if (!apiKey) throw new Error('OLLAMA_API_KEY is required')
  const llm = createOllamaLlm({ apiKey, model: options.model, timeoutMs: options.timeoutMs })
  const started = new Date()
  const results: EntityResult[] = []
  for (const entity of selected) {
    const result = await decideEntity(entity, llm)
    results.push(result)
    const label = result.status === 'errored' ? `errored: ${result.error}` : result.action
    console.log(`${entity.slug}: ${label}`)
  }
  const finished = new Date()
  const run_id = makeRunId(started)
  const payload = {
    run_id,
    started_at: started.toISOString(),
    finished_at: finished.toISOString(),
    duration_ms: finished.getTime() - started.getTime(),
    model: options.model,
    snapshot: options.snapshot,
    window: snapshot.window,
    since: since ? since.toISOString() : null,
    limit: options.limit,
    summary: summarize(results),
    results,
  }
  const outDir = path.resolve(options.outDir)
  await mkdir(outDir, { recursive: true })
  const jsonPath = path.join(outDir, `${run_id}.json`)
  const mdPath = path.join(outDir, `${run_id}.md`)
  await writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  await writeFile(mdPath, formatMarkdown({ ...payload, snapshot: options.snapshot }), 'utf8')
  console.log(JSON.stringify({ event: 'catch_up_poc', run_id, ...payload.summary, duration_ms: payload.duration_ms, json: jsonPath, md: mdPath }))
}

function isDirectRun(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  const base = path.basename(entry)
  return base === 'catch-up-poc.ts' || base === 'catch-up-poc.js'
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    console.error(`catch-up-poc: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
