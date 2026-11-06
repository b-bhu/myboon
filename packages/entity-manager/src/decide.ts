/** Pure decision logic: build the call, parse and validate the reply. No DB, no network. */
import type { AnalystHandoff } from '@myboon/contracts';

import type { Jev, Llm } from './clients.js';
import { JEV_QUESTION, SYSTEM_PROMPT } from './prompt.js';

export type EntityRow = { id: string; slug: string; name: string; type: string; summary: string | null };
export type RecentItem = { id: string; title: string; summary: string | null; date: string | null };

export type Decision =
  | { decision: 'story'; reason: string; title: string; summary: string }
  | { decision: 'park'; reason: string }
  | { decision: 'duplicate'; reason: string; duplicate_of: string };

export type DecideResult = Decision & { jev?: { choice: string; probabilities: Record<string, number> }; llm_decision: string };

export const MAX_RECENT_ITEMS = 7;
export const DECISIONS = ['story', 'park', 'duplicate'] as const;

/** https image from the signal, or null (no fallback image, by design). */
export function signalImage(h: AnalystHandoff): string | null {
  const img = h.signal.raw_ids.image?.trim();
  return img && img.startsWith('https://') && img.length <= 2048 ? img : null;
}

/** The SIGNAL block. Scout stores no body today, so body is the excerpt only when it differs from the title. */
export function signalBlock(h: AnalystHandoff) {
  const s = h.signal;
  const title = (s.text ?? '').split('\n')[0]!.trim();
  const body = s.excerpt && s.excerpt.trim() !== (s.text ?? '').trim() ? s.excerpt.trim() : null;
  return {
    title,
    body: body ?? (s.text && s.text.trim() !== title ? s.text.trim() : null),
    source_type: s.type,
    posted_at: s.occurred_at ?? s.created_at,
    image: signalImage(h),
  };
}

export function userMessage(entity: EntityRow, items: RecentItem[], h: AnalystHandoff): string {
  const sig = signalBlock(h);
  const lines = [
    'ENTITY:',
    `name: ${entity.name}`,
    `type: ${entity.type}`,
    `summary: ${entity.summary ?? '(none)'}`,
    '',
    'RECENT ITEMS:',
    ...(items.length
      ? items.map((it, i) => `${i + 1}. id: ${it.id} | date: ${it.date ?? 'unknown'} | title: ${it.title} | summary: ${it.summary ?? '(none)'}`)
      : ['(none yet)']),
    '',
    'SIGNAL:',
    `title: ${sig.title || '(none)'}`,
    `body: ${sig.body ?? '(missing)'}`,
    `source type: ${sig.source_type}`,
    `posted time: ${sig.posted_at}`,
    `image: ${sig.image ? 'yes' : '(missing)'}`,
  ];
  return lines.join('\n');
}

export function parseJsonReply(raw: string): Record<string, unknown> {
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) text = fenced[1]!.trim();
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a === -1 || b <= a) throw new Error('LLM reply has no JSON object');
  const v: unknown = JSON.parse(text.slice(a, b + 1));
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('LLM reply JSON is not an object');
  return v as Record<string, unknown>;
}

const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/**
 * Validate a decision. Jev's choice (when present) wins over the chat model's.
 * Throws on anything unusable, which the worker turns into em_fail.
 */
export function validateDecision(reply: Record<string, unknown>, items: RecentItem[], jevChoice?: string): Decision {
  const llmDecision = s(reply.decision);
  const decision = jevChoice ?? llmDecision;
  const reason = s(reply.reason) || `decided ${decision}`;
  if (decision === 'park') return { decision, reason };
  if (decision === 'duplicate') {
    const dup = s(reply.duplicate_of);
    if (!items.some((it) => it.id === dup)) throw new Error(`duplicate_of ${JSON.stringify(dup)} is not one of the recent items`);
    return { decision, reason, duplicate_of: dup };
  }
  if (decision === 'story') {
    const title = s(reply.title);
    const summary = s(reply.summary);
    if (!title || title.length > 90) throw new Error(`story title must be 1-90 chars (got ${title.length})`);
    if (!summary) throw new Error('story summary is missing');
    return { decision, reason, title, summary };
  }
  throw new Error(`unknown decision ${JSON.stringify(decision)}`);
}

/** One signal: Jev judges story/park/duplicate (if configured); the chat model writes the JSON. */
export async function decide(entity: EntityRow, items: RecentItem[], h: AnalystHandoff, deps: { llm: Llm; jev?: Jev }): Promise<DecideResult> {
  const user = userMessage(entity, items, h);
  let jevAnswer: DecideResult['jev'];
  if (deps.jev) {
    jevAnswer = await deps.jev(
      { entity: { name: entity.name, type: entity.type, summary: entity.summary }, recent_items: items, signal: signalBlock(h) },
      JEV_QUESTION,
      [...DECISIONS],
    );
  }
  const guide = jevAnswer ? `\n\nThe decision for this signal is "${jevAnswer.choice}". Reply with that decision and its fields.` : '';
  const raw = await deps.llm([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user + guide },
  ]);
  const reply = parseJsonReply(raw);
  return { ...validateDecision(reply, items, jevAnswer?.choice), jev: jevAnswer, llm_decision: s(reply.decision) };
}

/** LLM "park" is stored as em_status 'parked'. */
export function emOutcome(d: Decision['decision']): 'story' | 'parked' | 'duplicate' {
  return d === 'park' ? 'parked' : d;
}
