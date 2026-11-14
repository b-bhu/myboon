/**
 * The editor: one model call per entity, GLM glm-5.3-flash, temperature 0, strict JSON out. The POC prompt
 * (#612) is the base; it now carries bars (a), (c) and (d) and says hold is the default. The model only
 * proposes: the write bar in checks.ts decides.
 */
import type { Llm } from './clients.js';
import type { Bundle, Claim, EditorOutcome, Item, ModelDecision, Signal } from './types.js';

export const EDITOR_VERSION = 'latest-updates-v1';

export const SYSTEM_PROMPT = `You are the Catch-up editor for MyBoon.

Write for a curious market reader. Make the signal clear, concrete, and easy to follow. Do not write like a database summary, and do not mention pipelines, memory lanes, bundles, snapshots, or source ids in the reader-facing copy.

Your job is one question: is this worth putting in front of the reader now?

Choose exactly one action. HOLD IS THE DEFAULT: when you are unsure, choose hold.
- write: a reader should see a latest update now. Only choose write when ALL of these are true:
  (a) the new items add at least one fact the last update does not already contain: a number, a date, a decision or an actor.
  (b) every claim in your draft traces to a supplied item id or origin signal id, and every number in your draft appears in a supplied source.
  (c) what_to_watch names something concrete: a date, a price level or a decision still to come.
  (d) any month, quarter, half-year or fiscal year you name (for example "September CPI", "Q3", "H2", "FY26") is named the same way by the supplied sources. Never move a data period to the month it was released in, and never name a period no source names.
  A brand-new item on an entity with no earlier items can still be write when (a) to (d) hold.
- hold: it may matter, but the evidence is thin, incomplete, or one of (a) to (d) fails. Wait for more.
- skip: the last update already covers the new items, or it is not worth the reader's attention.

Do not use watch, needs_more_research, or merge.

For write, draft a short latest update with:
- title: a short, plain-English headline
- what_happened: what changed, leading with the new fact from (a)
- how_we_got_here: the recent path that led here
- what_to_watch: the concrete date, price level or decision from (c), without telling the reader what to do
- claims: every factual claim in the draft, each linked to a source item id or origin signal id from the supplied bundle

Aim for about 90-140 words across the three parts. Use concrete numbers only when they appear in the supplied items or their linked origin signals. Do not invent facts or numbers. Do not promise an edge. Do not give trading, investment, or any other advice. Do not overstate causality.

If a last update is supplied, compare the new items with it and the earlier items before choosing write. If it already covers the new items, choose skip.

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
`;

export function buildUserMessage(bundle: Bundle): string {
  const itemLine = (item: Item, index: number) =>
    `${index + 1}. id: ${item.id} | occurred_at: ${item.occurred_at ?? 'unknown'} | angle: ${item.angle ?? 'unknown'} | title: ${item.title} | summary: ${item.summary ?? '(none)'}`;
  const newIds = new Set(bundle.new_items.map((item) => item.id));
  const earlier = bundle.prior_items.filter((item) => !newIds.has(item.id));
  const signal = (s: Signal, index: number) =>
    [
      `${index + 1}. signal_id: ${s.signal_id} | type: ${s.type ?? 'unknown'} | occurred_at: ${s.occurred_at ?? 'unknown'}`,
      `text: ${s.text ?? '(none)'}`,
      `excerpt: ${s.excerpt ?? '(none)'}`,
      `numbers: ${s.numbers == null ? '{}' : JSON.stringify(s.numbers)}`,
    ].join('\n');
  const last = bundle.last_update;
  return [
    'ENTITY:',
    `name: ${bundle.entity.name}`,
    `slug: ${bundle.entity.slug}`,
    `type: ${bundle.entity.type}`,
    `summary: ${bundle.entity.summary ?? '(none)'}`,
    '',
    'NEW ITEMS (not yet in the last update):',
    ...(bundle.new_items.length ? bundle.new_items.map(itemLine) : ['(none)']),
    '',
    'EARLIER ITEMS:',
    ...(earlier.length ? earlier.map(itemLine) : ['(none)']),
    '',
    'ORIGIN SIGNALS:',
    bundle.origin_signals.length ? bundle.origin_signals.map(signal).join('\n\n') : '(none)',
    '',
    last ? `LAST UPDATE (${last.kind === 'published' ? 'what we last published' : 'newest earlier item'}):` : 'LAST UPDATE:',
    last ? [`id: ${last.id}`, `date: ${last.date ?? 'unknown'}`, `text: ${last.text}`].join('\n') : 'no earlier item',
  ].join('\n');
}

export function parseJsonReply(raw: string): Record<string, unknown> {
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) text = fenced[1]!.trim();
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a === -1 || b <= a) throw new Error('LLM reply has no JSON object');
  const value: unknown = JSON.parse(text.slice(a, b + 1));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('LLM reply JSON is not an object');
  return value as Record<string, unknown>;
}

const asString = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const trimOrNull = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t && t.toLowerCase() !== 'null' ? t : null;
};

function parseClaims(value: unknown): Claim[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('claims must be an array');
  return value.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`claims[${index}] is not an object`);
    const r = row as Record<string, unknown>;
    const text = asString(r.text);
    if (!text) throw new Error(`claims[${index}] is missing text`);
    return { text, source_item_id: trimOrNull(r.source_item_id), source_signal_id: trimOrNull(r.source_signal_id) };
  });
}

/** Throws on anything that is not the strict shape: the caller turns that into an `error` run row. */
export function parseModelReply(raw: string): ModelDecision {
  const reply = parseJsonReply(raw);
  const decision = asString(reply.decision).toLowerCase();
  const reason = asString(reply.reason);
  if (decision !== 'write' && decision !== 'hold' && decision !== 'skip') throw new Error(`unknown decision ${JSON.stringify(reply.decision)}`);
  if (!reason) throw new Error('decision is missing a one-line reason');
  if (decision !== 'write') return { decision, reason };
  const title = asString(reply.title);
  const what_happened = asString(reply.what_happened);
  const how_we_got_here = asString(reply.how_we_got_here);
  const what_to_watch = asString(reply.what_to_watch);
  if (!title) throw new Error('write draft is missing a title');
  if (!what_happened || !how_we_got_here || !what_to_watch) throw new Error('write draft is missing one of the three parts');
  return { decision, reason, draft: { title, what_happened, how_we_got_here, what_to_watch, claims: parseClaims(reply.claims) } };
}

const snip = (text: string) => text.replace(/\s+/g, ' ').slice(0, 300);

/** One model call. A timeout, a failed call or an unusable reply is an `error` outcome, never a decision. */
export async function askEditor(bundle: Bundle, llm: Llm): Promise<EditorOutcome> {
  let raw: string;
  try {
    raw = await llm([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage(bundle) },
    ]);
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return { kind: 'error', code: 'timeout', message: 'model timed out' };
    return { kind: 'error', code: 'llm_error', message: snip(error instanceof Error ? error.message : String(error)) };
  }
  try {
    return { kind: 'decision', model: parseModelReply(raw) };
  } catch (error) {
    return { kind: 'error', code: 'bad_json', message: snip(error instanceof Error ? error.message : String(error)) };
  }
}
