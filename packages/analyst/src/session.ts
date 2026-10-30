/**
 * #504 D36 analyst session, pure (no DB): one LLM session dissects a signal and proposes where it should
 * live; every decision is made by the decision tool (Jev, falling back to Clef) through the injected
 * `ask`. The LLM never overrules the decision tool; this code owns kind and candidate validity, and the
 * entity matching runs over whatever `search` is wired to (see shelfSearchFromDb in d36-worker.ts).
 */
import {
  ANGLES,
  ANALYST_OUTPUT_SCHEMA_VERSION,
  SHELF_TYPES,
  parseAnalystOutput,
  type Angle,
  type AnalystOutput,
  type ShelfType,
} from '@myboon/contracts';

/** Analyst version written on every D36 output. */
export const ANALYST_D36_VERSION = 'analyst-504-v1';

/** Fixed keep question, written by code (the LLM never writes it). */
export const KEEP_QUESTION = 'Would a crypto trader or market watcher care about this, even if it is only talk for now?';

/** The keep result when nothing is left to route (no mentions, all not related, or all new targets dropped). */
const NOTHING_TO_ROUTE = 'The decision tool said keep, but every mentioned entity was judged not related, so there is nothing to route.';

/** The allowed entity-type values for the LLM's JSON shapes, generated from the contracts' SHELF_TYPES. */
const SHELF_TYPE_VALUES = SHELF_TYPES.map((t) => `"${t}"`).join(' | ');

export const SYSTEM_PROMPT =
  'You are the analyst. You receive one signal, the way a market analyst hears news, posts and talk as it happens. Your job is not to check whether it is true. ' +
  'It is to understand what is being said, who it touches, and what it could mean for them. Read it, dissect it (who, what, why it matters), then decide where ' +
  'it should live. Ask the decision tool first whether this signal is worth keeping, then, for each entity it touches, whether it belongs to an existing entity, ' +
  'needs a new one, or is not related. Use the entity tool to see what exists. After the decision tool answers, decide the angle for each entity: what is forming ' +
  "there, written the way it was said: if someone announces it, it's announced; if people are talking about it, it's talk. Don't make it sound weaker or stronger than it is. " +
  "The signal comes from a source (a news site, an account, a feed). The source is only the messenger; don't treat it as an entity unless the news is about the source itself. " +
  "Your note is what you'd want to read months later. Say who said it: if the entity itself says it, it's their announcement; if a news site or someone else says it, it's their report; if people are just talking, it's talk. Never overrule the decision tool; if its answer makes no sense, mark the signal unclear. " +
  'Return only the structured output.';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** One OpenAI-compatible chat completion; the endpoint and key live in the factory below. */
export type Llm = (messages: ChatMessage[]) => Promise<string>;

export type SignalInput = { signal_id: string; text: string; source?: string | null; link?: string | null };

export type Candidate = { slug: string; name: string; type: string };

export type ShelfLike = { slug: string; name: string; type: string; aliases: string[] };

/** The entity tool: match a mention's name and search terms against the shelves. */
export type EntitySearch = (terms: string[]) => Promise<Candidate[]>;

export type AskInput = { question: string; choices: string[]; state: Record<string, unknown>; shortlist: Candidate[] };

/** Throws when the decision tool cannot answer (both deciders failed); a bad choice in choices is not thrown. */
export type AskResult = { choice: string; probabilities: Record<string, number>; provider: 'jev' | 'clef' };

export type Ask = (input: AskInput) => Promise<AskResult>;

/** One answered decision-tool question, logged for every ask call. */
export type JevLogEntry = {
  signal_id: string;
  question: string;
  choices: string[];
  answer: string;
  confidence: number | null;
  provider: 'jev' | 'clef';
};

/**
 * The Ollama completion client: POST {model, messages, temperature 0, stream false} with the key as
 * a bearer. Its errors carry the HTTP status and a snippet of the body with the key redacted; the
 * key value is never logged.
 */
export function createOllamaLlm(o: { apiKey: string; model: string; fetchImpl?: typeof fetch; url?: string }): Llm {
  const url = o.url ?? 'https://ollama.com/v1/chat/completions';
  const fetchImpl = o.fetchImpl ?? fetch;
  return async (messages: ChatMessage[]): Promise<string> => {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: o.model, messages, temperature: 0, stream: false }),
    });
    if (!response.ok) {
      throw new Error(`LLM HTTP ${response.status}: ${snip(redact(await response.text(), o.apiKey))}`);
    }
    const payload = asRec(await response.json());
    const choices = Array.isArray(payload.choices) ? (payload.choices as unknown[]) : [];
    const content = str(asRec(asRec(choices[0]).message).content);
    if (!content.trim()) throw new Error('LLM reply has no content');
    return content;
  };
}

function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join('[redacted]') : text;
}

/**
 * Entity search over an in-memory shelves list: case-insensitive over name/slug/aliases. Rank:
 * exact match on terms[0] (the mention name) first, then exact on other terms, then whole-word
 * match (terms < 3 chars exact only), then substring (so tickers like HYPE resolve to Hyperliquid);
 * max 5, first match per slug by rank.
 */
export function searchShelves(terms: string[], shelves: ShelfLike[]): Candidate[] {
  const wordMatch = (value: string, needle: string): boolean =>
    new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(value);
  const query = [...new Set(terms.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0))];
  const ranked = new Map<string, { rank: number; shelf: ShelfLike }>();
  for (const term of query) {
    for (const shelf of shelves) {
      const haystacks = [shelf.name, shelf.slug, ...shelf.aliases].map((v) => v.trim().toLowerCase());
      const exact = haystacks.includes(term);
      const rank = exact ? (term === query[0] ? -1 : 0) : looserMatch(haystacks, term, wordMatch);
      if (rank === null) continue;
      const previous = ranked.get(shelf.slug);
      if (!previous || rank < previous.rank) ranked.set(shelf.slug, { rank, shelf });
    }
  }
  return [...ranked.values()]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 5)
    .map(({ shelf }) => ({ slug: shelf.slug, name: shelf.name, type: shelf.type }));
}

/** Whole-word match, or substring as a last resort; null when the term matches nothing. */
function looserMatch(haystacks: string[], term: string, wordMatch: (value: string, needle: string) => boolean): number | null {
  if (term.length < 3) return null;
  if (haystacks.some((v) => wordMatch(v, term))) return 1;
  if (haystacks.some((v) => v.includes(term))) return 2;
  return null;
}

/** True only for the exact shelf types from the contracts, after trim + lowercase; no synonym mapping (the #508 rule). */
export function isShelfType(raw: string): raw is ShelfType {
  return (SHELF_TYPES as readonly string[]).includes(raw.trim().toLowerCase());
}

/** Short canonical slug for new entities: prefer an abbreviation in brackets (with whitespace before it), else kebab of the name. */
export function canonicalSlug(mention: string): string {
  const paren = mention.match(/^(.*?)\s+\(([^)]+)\)\s*$/);
  if (paren) {
    const [outer, inner] = [paren[1].trim(), paren[2].trim()];
    const isAbbr = (v: string): boolean => /^[A-Z0-9.&$-]{2,10}$/.test(v.replace(/\s+/g, ''));
    if (isAbbr(outer)) return kebabSlug(outer);
    if (isAbbr(inner)) return kebabSlug(inner);
    return kebabSlug(outer);
  }
  return kebabSlug(mention);
}

function kebabSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asRec(row: unknown): Record<string, unknown> {
  return row && typeof row === 'object' && !Array.isArray(row) ? (row as Record<string, unknown>) : {};
}

function snip(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 300);
}

/** Fixed decision-tool questions, written by code (the LLM never writes them). */
function keepQuestionFor(summary: string): string {
  return `Signal summary: "${summary}". ${KEEP_QUESTION}`;
}

function entityQuestionFor(mention: string, candidates: Candidate[]): string {
  const shown = candidates.length > 0
    ? ` Candidate existing entities: ${candidates.map((c) => `${c.slug} (${c.name}, ${c.type})`).join('; ')}.`
    : ' The entity search found no existing entities for it.';
  const ask = candidates.length > 0
    ? `Does "${mention}" belong to an existing entity, need a new entity, or is it not related? Answer existing, new or not_related.`
    : `Does "${mention}" need a new entity, or is it not related? Answer new or not_related.`;
  return `This signal touches "${mention}".${shown} ${ask}`;
}

function angleQuestionFor(mention: string, kind: 'existing' | 'new'): string {
  return `For "${mention}" (${kind === 'new' ? 'a new entity' : 'an existing entity'}), what does this signal do there? ` +
    'new_story: it starts a new story; existing_story: it continues a story already forming; plain_update: a minor update. Answer new_story, existing_story or plain_update.';
}

/** Strip ``` fences, take the first {...}, parse. */
function parseJsonReply(raw: string): Record<string, unknown> {
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error(`LLM reply has no JSON object: ${snip(text)}`);
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('LLM reply JSON is not an object');
  return parsed as Record<string, unknown>;
}

export type SessionDeps = { llm: Llm; ask: Ask; search: EntitySearch; log?: (e: JevLogEntry) => void };

/** A kept mention between the decision tool and the note turn. */
type KeptDraft = { mention: string; mentionType: string; kind: 'existing' | 'new'; candidates: Candidate[]; angle?: Angle };

/**
 * One D36 session over one signal: T1 dissect -> keep question -> ignore reason or per-mention entity
 * verdicts -> T3 reasoning -> angle question per kept entity -> T4 notes -> the output, with kind,
 * angle, entity and candidate validity owned by this code and the decision tool.
 */
export async function runSession(signal: SignalInput, deps: SessionDeps): Promise<AnalystOutput> {
  const history: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];

  /** One turn of the single session: send, keep the reply in history, parse its JSON. */
  const step = async (userContent: string): Promise<Record<string, unknown>> => {
    history.push({ role: 'user', content: userContent });
    const raw = await deps.llm(history);
    history.push({ role: 'assistant', content: raw });
    return parseJsonReply(raw);
  };

  /** Ask the decision tool, log the answered question, and refuse answers outside the offered choices. */
  const askAndLog = async (question: string, choices: string[], state: Record<string, unknown>, shortlist: Candidate[]): Promise<string> => {
    const answer = await deps.ask({ question, choices, state, shortlist });
    deps.log?.({
      signal_id: signal.signal_id,
      question,
      choices,
      answer: answer.choice,
      confidence: answer.probabilities[answer.choice] ?? null,
      provider: answer.provider,
    });
    return answer.choice;
  };

  const final = (decision: 'keep' | 'ignore' | 'unclear', reason: string, targets: AnalystOutput['targets']): AnalystOutput =>
    parseAnalystOutput({
      schema_version: ANALYST_OUTPUT_SCHEMA_VERSION,
      analyst_version: ANALYST_D36_VERSION,
      signal_id: signal.signal_id,
      summary,
      decision,
      reason,
      targets,
    });

  const unclear = (reason: string): AnalystOutput => final('unclear', reason, []);

  // Turn 1: dissect the signal and shape the keep question.
  const request = { signal_id: signal.signal_id, text: signal.text, source: signal.source ?? null, link: signal.link ?? null };
  const turn1 = await step(
    `Signal:\n${JSON.stringify(request, null, 2)}\n\nReply with JSON only:\n` +
      `{"summary": string, "mentions": [{"name": string, "type": ${SHELF_TYPE_VALUES}, "search_terms": string[]}]}\n` +
      'summary: 2-3 sentences (who, what, why it matters). ' +
      'mentions: at most 3 entities this signal touches, each with a type (exactly one of the listed values) and search_terms.',
  );
  const summary = str(turn1.summary);
  if (!summary) throw new Error('no summary in the first reply');
  const mentions = toMentions(turn1.mentions);

  // Decision 1: is the signal worth keeping at all?
  const keepChoices = ['keep', 'ignore'];
  const keepChoice = await askAndLog(keepQuestionFor(summary), keepChoices, { signal: signal.text, summary }, []);
  if (!keepChoices.includes(keepChoice)) {
    return unclear(`The decision tool answered "${keepChoice}", which is not one of the offered choices (keep, ignore).`);
  }
  if (keepChoice === 'ignore') {
    const ignoreReply = await step(
      'The decision tool said ignore. In one sentence, why is this signal not worth keeping? Reply with JSON only: {"reason": string}.',
    );
    return final('ignore', str(ignoreReply.reason) || 'The decision tool said ignore.', []);
  }

  if (mentions.length === 0) {
    return final('keep', 'The decision tool said keep, but no entities were mentioned, so there is nothing to route.', []);
  }

  // Decision 2: one verdict per mention; this code owns kind and candidate validity.
  const kept: KeptDraft[] = [];
  for (const mention of mentions) {
    const candidates = await deps.search([mention.name, ...mention.search_terms]);
    const choices = candidates.length > 0 ? ['existing', 'new', 'not_related'] : ['new', 'not_related'];
    const state = { signal: signal.text, summary, mention: mention.name, candidates };
    const verdict = await askAndLog(entityQuestionFor(mention.name, candidates), choices, state, candidates);
    if (!choices.includes(verdict)) {
      return unclear(`The decision tool answered "${verdict}", which is not one of the offered choices (${choices.join(', ')}).`);
    }
    if (verdict === 'not_related') continue;
    kept.push({
      mention: mention.name,
      mentionType: mention.type,
      kind: verdict === 'new' ? 'new' : 'existing',
      candidates,
    });
  }

  if (kept.length === 0) {
    return final('keep', NOTHING_TO_ROUTE, []);
  }

  // Turn 3: the LLM reasons about what is forming per kept entity (context for Jev only; it does not pick the angle).
  const turn3 = await step(
    'The decision tool has answered; each kind below is fixed and cannot change.\n' +
      `${JSON.stringify(kept.map((k) => ({ mention: k.mention, kind: k.kind })), null, 2)}\n\n` +
      'Reply with JSON only:\n{"reasoning": [{"mention": string, "reasoning": string}]}\n' +
      'One row per kept mention: one or two sentences on what this signal means for that entity and whether it starts something new, ' +
      'continues an ongoing story, or is a minor update. Do not pick an angle; the decision tool will.',
  );
  const reasoningRows = Array.isArray(turn3.reasoning) ? turn3.reasoning.map(asRec) : [];

  // Decision 3: the angle for each kept entity with a fixed question.
  for (const [index, draft] of kept.entries()) {
    const row = reasoningRows.find((r) => str(r.mention).toLowerCase() === draft.mention.toLowerCase()) ?? reasoningRows[index];
    const reasoning = str(row?.reasoning);
    const verdict = await askAndLog(
      angleQuestionFor(draft.mention, draft.kind),
      [...ANGLES],
      { signal: signal.text, summary, mention: draft.mention, kind: draft.kind, reasoning },
      draft.candidates,
    );
    if (!(ANGLES as readonly string[]).includes(verdict)) {
      return unclear(`The decision tool answered "${verdict}", which is not one of the offered choices (${ANGLES.join(', ')}).`);
    }
    draft.angle = verdict as Angle;
  }

  // Turn 4: the LLM writes the note, matching the decision tool's angle; its own angle/entity fields are ignored.
  const turn4 = await step(
    'The decision tool has picked each angle; kind and angle below are fixed and cannot change.\n' +
      `${JSON.stringify(kept.map((k) => ({ mention: k.mention, kind: k.kind, angle: k.angle })), null, 2)}\n\n` +
      `{"targets": [{"mention": string, "type": ${SHELF_TYPE_VALUES}, "note": string}], "reason": string}\n` +
      'One row per kept mention, no others. type is exactly one of the listed values, the type of that entity. ' +
      'note: one line on what is forming there, written to match the given angle.',
  );
  const reason = str(turn4.reason);
  const rows = Array.isArray(turn4.targets) ? turn4.targets : [];
  if (rows.length === 0) throw new Error('no targets in the note reply');

  const targets: AnalystOutput['targets'] = [];
  const unclearReasons: string[] = [];
  buildTargets(rows, kept, targets, unclearReasons);
  if (unclearReasons.length > 0) return unclear(unclearReasons.join(' '));
  if (targets.length === 0) return final('keep', NOTHING_TO_ROUTE, []);
  return final('keep', reason || 'The decision tool answered keep and every kept entity is routed.', targets);
}

/**
 * Enforce decision-tool-fixed kind and angle plus candidate validity on the LLM's routing. Existing
 * targets carry the matched shelf's own type (the LLM's type is ignored, even when missing or invalid);
 * a NEW target whose LLM type is not one of the shelf types is dropped silently, like a not_related
 * verdict (the #508 rule), and unclearReasons stays reserved for code/decision-tool failures.
 */
function buildTargets(rows: unknown[], kept: KeptDraft[], targets: AnalystOutput['targets'], unclearReasons: string[]): void {
  const byMention = new Map<string, Record<string, unknown>>();
  for (const row of rows) byMention.set(str(asRec(row).mention).toLowerCase(), asRec(row));
  const seen = new Set<string>();
  kept.forEach((draft, index) => {
    const row = byMention.get(draft.mention.toLowerCase()) ?? (rows.length === kept.length ? asRec(rows[index]) : {});
    if (!draft.angle) {
      unclearReasons.push(`The decision tool gave no valid angle for "${draft.mention}".`);
      return;
    }
    if (draft.kind === 'existing') {
      const matched = draft.candidates[0];
      if (!matched) {
        unclearReasons.push(`The entity search found no candidate for the existing entity "${draft.mention}".`);
        return;
      }
      if (!seen.has(matched.slug)) {
        seen.add(matched.slug);
        // shelves.type mirrors SHELF_TYPES (the atlas type check), so the shelf's own type always parses.
        targets.push({
          entity: matched.slug,
          kind: 'existing',
          type: matched.type as ShelfType,
          angle: draft.angle,
          note: str(row.note),
        });
      }
      return;
    }
    const askedType = (str(row.type) || draft.mentionType).trim().toLowerCase();
    if (!isShelfType(askedType)) return; // free text on a NEW target: dropped like a not_related verdict
    const entity = canonicalSlug(draft.mention);
    if (!entity) {
      unclearReasons.push(`No usable slug for the new entity "${draft.mention}".`);
      return;
    }
    if (seen.has(entity)) return;
    seen.add(entity);
    targets.push({ entity, kind: 'new', type: askedType, angle: draft.angle, note: str(row.note) });
  });
}

/** Normalize the LLM's mention rows: trimmed names, string search terms, at most 3. */
function toMentions(raw: unknown): { name: string; type: string; search_terms: string[] }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row): { name: string; type: string; search_terms: string[] } | null => {
      const rec = asRec(row);
      const name = str(rec.name).trim();
      const terms = Array.isArray(rec.search_terms) ? rec.search_terms.filter((t): t is string => typeof t === 'string' && t.trim().length > 0) : [];
      return name ? { name, type: str(rec.type) || 'unknown', search_terms: terms } : null;
    })
    .filter((m): m is { name: string; type: string; search_terms: string[] } => m !== null)
    .slice(0, 3);
}