/**
 * #504 D36 analyst session, pure (no DB): one LLM session dissects a signal and decides where it should
 * live; every decision is made by the decision tool (Jev, falling back to Clef) through the injected
 * `ask`. The LLM never overrules the decision tool.
 *
 * #567 type-first matching: each mention carries its top 1-3 types (zod at the boundary). The type is
 * obvious when only one is given or the top type's lookup already has candidates; otherwise the decision
 * tool picks the type. Candidates come from the injected `lookup` (atlas.entity_candidates, #566: active
 * only, the mention's names plus names found in the article). The decision tool picks one candidate slug
 * or none (a closed choice). A miss retries once with the second type; only after both typed tries miss
 * does the cross-type exact fallback run. One main entity per signal: mentions are tried in order and
 * the first pick wins. The analyst never proposes or creates an entity; a full miss logs `entity_miss`.
 */
import {
  ANGLES,
  ANALYST_OUTPUT_SCHEMA_VERSION,
  ENTITY_TYPES,
  analystMentionSchema,
  parseAnalystOutput,
  type AnalystMention,
  type Angle,
  type AnalystOutput,
  type EntityType,
} from '@myboon/contracts';

/** Analyst version written on every D36 output. */
export const ANALYST_D36_VERSION = 'analyst-567-v1';

/** Fixed keep question, written by code (the LLM never writes it). */
export const KEEP_QUESTION = 'Would a crypto trader or market watcher care about this, even if it is only talk for now?';

/** The keep result when nothing is left to route (no mentions, all not related, or all new targets dropped). */
const NOTHING_TO_ROUTE = 'The decision tool said keep, but no mention matched an existing entity, so there is nothing to route.';

/** The allowed entity-type values for the LLM's JSON shapes, generated from the contracts' ENTITY_TYPES. */
const ENTITY_TYPE_VALUES = ENTITY_TYPES.map((t) => `"${t}"`).join(' | ');

export const SYSTEM_PROMPT =
  'You are the analyst. You receive one signal, the way a market analyst hears news, posts and talk as it happens. Your job is not to check whether it is true. ' +
  'It is to understand what is being said, who it touches, and what it could mean for them. Read it, dissect it (who, what, why it matters), then decide where ' +
  'it should live. Ask the decision tool first whether this signal is worth keeping, then, for each entity it touches, which existing entity it belongs to, if any. ' +
  'You never create entities: a mention either matches one of the offered existing entities or none. After the decision tool answers, decide the angle for each entity: what is forming ' +
  "there, written the way it was said: if someone announces it, it's announced; if people are talking about it, it's talk. Don't make it sound weaker or stronger than it is. " +
  "The signal comes from a source (a news site, an account, a feed). The source is only the messenger; don't treat it as an entity unless the news is about the source itself. " +
  "Your summary and headline are for the reader: lead with the fact and why it matters to them. Never name the source, publisher, sharer or account, never say what kind of source it was, " +
  'and never use lead-ins like "According to", "reports", "per" or "shared by"; the source link is stored separately. ' +
  "Your note is what you'd want to read months later. Say who said it: if the entity itself says it, it's their announcement; if a news site or someone else says it, it's their report; if people are just talking, it's talk. Never overrule the decision tool; if its answer makes no sense, mark the signal unclear. " +
  'Return only the structured output.';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** One OpenAI-compatible chat completion; the endpoint and key live in the factory below. */
export type Llm = (messages: ChatMessage[]) => Promise<string>;

export type SignalInput = { signal_id: string; text: string; source?: string | null; link?: string | null };

/** One existing, active entity offered to the pick step. */
export type Candidate = { slug: string; name: string; type: string };

/**
 * The #566 candidate lookup (atlas.entity_candidates / entity_candidates_any). Both are active-only and
 * exact on atlas.norm_alias; the DB normalizes the names, so callers pass raw text.
 */
export interface CandidateLookup {
  /** Active entities of one type whose alias matches one of `names` (plus the type's recent/small-type extras). */
  typed(type: EntityType, names: string[]): Promise<Candidate[]>;
  /** The cross-type exact fallback: active entities of any type whose alias matches one of `names`. */
  anyType(names: string[]): Promise<Candidate[]>;
}

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

/** The structured miss line (#567): no candidate was picked for any mention of a kept signal. */
export type EntityMissEntry = {
  event: 'entity_miss';
  signal_id: string;
  mention: string;
  types: EntityType[];
  types_tried: EntityType[];
  candidate_count: number;
  fallback_tried: boolean;
  fallback_candidate_count: number;
};

/** One matching trace row per mention, for the dry run and debugging. Never written to the DB. */
export type MatchTrace = {
  signal_id: string;
  mention: string;
  types: EntityType[];
  type_decision: 'obvious' | 'decided';
  chosen_type: EntityType;
  tries: { type: EntityType | 'any'; candidates: string[]; pick: string | null }[];
  pick: Candidate | null;
};

/** Most candidates shown to the pick step per try. */
export const MAX_CANDIDATES = 8;

/** Most article phrases sent to the lookup; 1-3 word windows over the signal text. */
const MAX_ARTICLE_PHRASES = 600;

/**
 * Names found in the article: every 1-3 word window over the text (lowercased, punctuation stripped
 * except $ and .), deduplicated and capped. The lookup matches these against atlas.norm_alias, so an
 * alias counts only when its exact normalized form appears in the article.
 */
export function articlePhrases(text: string): string[] {
  const words = text.toLowerCase().replace(/[^a-z0-9$.\s-]+/g, ' ').split(/\s+/).map((w) => w.replace(/^[.-]+|[.-]+$/g, '')).filter((w) => w.length > 0);
  const out = new Set<string>();
  for (let i = 0; i < words.length && out.size < MAX_ARTICLE_PHRASES; i += 1) {
    for (let n = 1; n <= 3 && i + n <= words.length; n += 1) out.add(words.slice(i, i + n).join(' '));
  }
  return [...out].slice(0, MAX_ARTICLE_PHRASES);
}

/** True only for the exact entity types from the contracts, after trim + lowercase; no synonym mapping (the #508 rule). */
export function isEntityType(raw: string): raw is EntityType {
  return (ENTITY_TYPES as readonly string[]).includes(raw.trim().toLowerCase());
}

/**
 * The Ollama completion client: POST {model, messages, temperature 0, stream false} with the key as
 * a bearer. The fetch and body read abort after `timeoutMs` (default 20s) and surface as one
 * "LLM timed out after Nms" error (Refs #512); other errors carry the HTTP status and a snippet of
 * the body with the key redacted; the key value is never logged.
 */
export function createOllamaLlm(o: { apiKey: string; model: string; fetchImpl?: typeof fetch; url?: string; timeoutMs?: number }): Llm {
  const url = o.url ?? 'https://ollama.com/v1/chat/completions';
  const fetchImpl = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? 20_000;
  return async (messages: ChatMessage[]): Promise<string> => {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: o.model, messages, temperature: 0, stream: false }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`LLM HTTP ${response.status}: ${snip(redact(await response.text(), o.apiKey))}`);
      }
      const payload = asRec(await response.json());
      const choices = Array.isArray(payload.choices) ? (payload.choices as unknown[]) : [];
      const content = str(asRec(asRec(choices[0]).message).content);
      if (!content.trim()) throw new Error('LLM reply has no content');
      return content;
    } catch (err) {
      if (isTimeoutAbort(err)) throw new Error(`LLM timed out after ${timeoutMs}ms`);
      throw err;
    }
  };
}

/** True only for an aborted fetch or body read: AbortSignal.timeout rejects with 'TimeoutError', other aborts with 'AbortError'. */
function isTimeoutAbort(err: unknown): boolean {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join('[redacted]') : text;
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

function typeQuestionFor(mention: string, types: EntityType[]): string {
  return `This signal touches "${mention}". Which kind of entity is it? Answer ${types.join(', ')}.`;
}

function pickQuestionFor(mention: string, candidates: Candidate[]): string {
  return `This signal touches "${mention}". Candidate existing entities: ${candidates.map((c) => `${c.slug} (${c.name}, ${c.type})`).join('; ')}. ` +
    `Which one is "${mention}"? Answer one slug, or none if none of them is it.`;
}

function angleQuestionFor(mention: string): string {
  return `For "${mention}" (an existing entity), what does this signal do there? ` +
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

export type SessionDeps = {
  llm: Llm;
  ask: Ask;
  lookup: CandidateLookup;
  log?: (e: JevLogEntry) => void;
  /** entity_miss lines; default is one JSON line on stdout. */
  missLog?: (e: EntityMissEntry) => void;
  /** Per-mention matching trace (dry run); off by default. */
  trace?: (e: MatchTrace) => void;
  /** Every validated mention from turn 1 (dry run); off by default. */
  onMentions?: (mentions: AnalystMention[]) => void;
};

/** A thrown marker so a decision-tool answer outside the offered choices ends the session as unclear. */
class OffChoice extends Error {}

/**
 * One D36 session over one signal: T1 dissect (mentions with top types) -> keep question -> ignore
 * reason, or type-first matching until one mention picks an existing entity -> T3 reasoning -> angle
 * question -> T4 note -> the output with at most one existing target.
 */
export async function runSession(signal: SignalInput, deps: SessionDeps): Promise<AnalystOutput> {
  const history: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  const missLog = deps.missLog ?? ((e: EntityMissEntry) => { console.log(JSON.stringify(e)); });

  /** One turn of the single session: send, keep the reply in history, parse its JSON. */
  const step = async (userContent: string, o: { lenientKey?: string } = {}): Promise<Record<string, unknown>> => {
    history.push({ role: 'user', content: userContent });
    const raw = await deps.llm(history);
    history.push({ role: 'assistant', content: raw });
    if (!o.lenientKey) return parseJsonReply(raw);
    // Context-only turns: a prose reply is used as the value instead of failing the signal.
    try { return parseJsonReply(raw); } catch { return { [o.lenientKey]: raw.trim() }; }
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
    if (!choices.includes(answer.choice)) {
      throw new OffChoice(`The decision tool answered "${answer.choice}", which is not one of the offered choices (${choices.join(', ')}).`);
    }
    return answer.choice;
  };

  const final = (decision: 'keep' | 'ignore' | 'unclear', reason: string, targets: AnalystOutput['targets']): AnalystOutput =>
    parseAnalystOutput({
      schema_version: ANALYST_OUTPUT_SCHEMA_VERSION,
      analyst_version: ANALYST_D36_VERSION,
      signal_id: signal.signal_id,
      summary,
      ...(headline ? { headline } : {}),
      decision,
      reason,
      targets,
    });

  // Turn 1: dissect the signal and shape the keep question.
  const request = { signal_id: signal.signal_id, text: signal.text, source: signal.source ?? null, link: signal.link ?? null };
  const turn1 = await step(
    `Signal:\n${JSON.stringify(request, null, 2)}\n\nReply with JSON only:\n` +
      `{"headline": string, "summary": string, "mentions": [{"name": string, "types": [${ENTITY_TYPE_VALUES}], "search_terms": string[]}]}\n` +
      'headline: one complete headline of at most 90 characters stating what happened. ' +
      'summary: 2-3 sentences (what happened, who it touches, why it matters to the reader). ' +
      'Neither may name the source, publisher, sharer or account, or start with "According to", "per", "reports" or "shared by". ' +
      'mentions: at most 3 entities this signal touches, the main one first. types: the 1-3 most likely entity types for that mention, ' +
      'most likely first, each exactly one of the listed values; give one type when it is obvious. search_terms: other names or tickers for it.',
  );
  const summary = str(turn1.summary);
  const headline = str(turn1.headline);
  if (!summary) throw new Error('no summary in the first reply');
  const mentions = toMentions(turn1.mentions);
  deps.onMentions?.(mentions);

  try {
    // Decision 1: is the signal worth keeping at all?
    const keepChoice = await askAndLog(keepQuestionFor(summary), ['keep', 'ignore'], { signal: signal.text, summary }, []);
    if (keepChoice === 'ignore') {
      const ignoreReply = await step(
        'The decision tool said ignore. In one sentence, why is this signal not worth keeping? Reply with JSON only: {"reason": string}.',
      );
      return final('ignore', str(ignoreReply.reason) || 'The decision tool said ignore.', []);
    }
    if (mentions.length === 0) {
      return final('keep', 'The decision tool said keep, but no entities were mentioned, so there is nothing to route.', []);
    }

    // Decision 2: type-first matching, mention by mention, until one picks an existing entity (one main entity).
    const phrases = articlePhrases(signal.text);
    let main: { mention: string; entity: Candidate } | null = null;
    for (const mention of mentions) {
      const picked = await matchMention(mention, phrases);
      if (picked) {
        main = { mention: mention.name, entity: picked };
        break;
      }
    }
    if (!main) return final('keep', NOTHING_TO_ROUTE, []);

    // Turn 3: the LLM reasons about what this signal means for the main entity (context for the decision tool only).
    const turn3 = await step(
      `The decision tool matched "${main.mention}" to the existing entity ${main.entity.slug} (${main.entity.name}); this is fixed.\n` +
        'Reply with JSON only:\n{"reasoning": string}\n' +
        'One or two sentences on what this signal means for that entity and whether it starts something new, ' +
        'continues an ongoing story, or is a minor update. Do not pick an angle; the decision tool will.',
      { lenientKey: 'reasoning' },
    );
    // Decision 3: the angle with a fixed question.
    const angle = (await askAndLog(
      angleQuestionFor(main.mention),
      [...ANGLES],
      { signal: signal.text, summary, mention: main.mention, kind: 'existing', reasoning: str(turn3.reasoning) },
      [main.entity],
    )) as Angle;

    // Turn 4: the note, matching the decision tool's angle.
    const turn4 = await step(
      `The decision tool picked the angle ${angle} for ${main.entity.slug}; it is fixed.\n` +
        'Reply with JSON only:\n{"note": string, "reason": string}\n' +
        'note: one line on what is forming there, written to match the given angle.',
    );
    // entities.type mirrors ENTITY_TYPES (the atlas type check), so the entity's own type always parses.
    return final('keep', str(turn4.reason) || 'The decision tool answered keep and the main entity is routed.', [
      { entity: main.entity.slug, kind: 'existing', type: main.entity.type as EntityType, angle, note: str(turn4.note) },
    ]);
  } catch (e) {
    if (e instanceof OffChoice) return final('unclear', e.message, []);
    throw e;
  }

  /**
   * Type-first match for one mention: pick the type (obvious or decided), try it, retry once with the
   * second type, then the cross-type exact fallback. Returns the picked candidate or null (entity_miss).
   */
  async function matchMention(mention: AnalystMention, phrases: string[]): Promise<Candidate | null> {
    const own = [mention.name, ...mention.search_terms];
    const names = [...own, ...phrases];
    const cache = new Map<EntityType, Candidate[]>();
    const fetchTyped = async (t: EntityType): Promise<Candidate[]> => {
      const hit = cache.get(t);
      if (hit) return hit;
      const rows = rankCandidates(await deps.lookup.typed(t, names), own);
      cache.set(t, rows);
      return rows;
    };

    const [top] = mention.types;
    let order: EntityType[];
    let typeDecision: MatchTrace['type_decision'] = 'obvious';
    if (mention.types.length === 1 || (await fetchTyped(top)).length > 0) {
      order = mention.types;
    } else {
      typeDecision = 'decided';
      const chosen = (await askAndLog(typeQuestionFor(mention.name, mention.types), mention.types, { signal: signal.text, summary, mention: mention.name }, [])) as EntityType;
      order = [chosen, ...mention.types.filter((t) => t !== chosen)];
    }

    const tries: MatchTrace['tries'] = [];
    const pickFrom = async (candidates: Candidate[]): Promise<Candidate | null> => {
      if (candidates.length === 0) return null;
      const choice = await askAndLog(
        pickQuestionFor(mention.name, candidates),
        [...candidates.map((c) => c.slug), 'none'],
        { signal: signal.text, summary, mention: mention.name, candidates },
        candidates,
      );
      return candidates.find((c) => c.slug === choice) ?? null;
    };
    const done = (pick: Candidate | null): Candidate | null => {
      deps.trace?.({ signal_id: signal.signal_id, mention: mention.name, types: mention.types, type_decision: typeDecision, chosen_type: order[0], tries, pick });
      return pick;
    };

    let candidateCount = 0;
    const typesTried = order.slice(0, 2); // the chosen type, then one retry with the next
    for (const t of typesTried) {
      const candidates = await fetchTyped(t);
      candidateCount += candidates.length;
      const pick = await pickFrom(candidates);
      tries.push({ type: t, candidates: candidates.map((c) => c.slug), pick: pick?.slug ?? null });
      if (pick) return done(pick);
    }
    // Both typed tries missed: exact match across all types on the mention's own names only.
    const fallback = rankCandidates(await deps.lookup.anyType(own), own);
    const pick = await pickFrom(fallback);
    tries.push({ type: 'any', candidates: fallback.map((c) => c.slug), pick: pick?.slug ?? null });
    if (pick) return done(pick);
    missLog({
      event: 'entity_miss', signal_id: signal.signal_id, mention: mention.name, types: mention.types,
      types_tried: typesTried, candidate_count: candidateCount, fallback_tried: true, fallback_candidate_count: fallback.length,
    });
    return done(null);
  }
}

/** Dedupe by slug, entities named like the mention first, capped at MAX_CANDIDATES. */
function rankCandidates(rows: Candidate[], own: string[]): Candidate[] {
  const norm = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const wanted = new Set(own.map(norm));
  const bySlug = new Map<string, Candidate>();
  for (const r of rows) if (!bySlug.has(r.slug)) bySlug.set(r.slug, r);
  return [...bySlug.values()]
    .sort((a, b) => Number(wanted.has(norm(b.name)) || wanted.has(norm(b.slug))) - Number(wanted.has(norm(a.name)) || wanted.has(norm(a.slug))))
    .slice(0, MAX_CANDIDATES);
}

/** Validate the LLM's mention rows with the contracts' zod schema; invalid rows are dropped; at most 3. */
function toMentions(raw: unknown): AnalystMention[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => {
      const rec = asRec(row);
      // Older shape: a single "type" becomes a one-element types list.
      const input = rec.types === undefined && typeof rec.type === 'string' ? { ...rec, types: [rec.type] } : rec;
      const parsed = analystMentionSchema.safeParse(input);
      return parsed.success ? { ...parsed.data, search_terms: parsed.data.search_terms.filter((t) => t.trim().length > 0) } : null;
    })
    .filter((m): m is AnalystMention => m !== null)
    .slice(0, 3);
}
