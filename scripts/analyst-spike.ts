/**
 * Analyst spike (one file). One LLM session dissects a signal and proposes where it should live; every decision is
 * made by the System One decider from packages/analyst (Jev, falling back to Clef). The LLM never overrules the
 * decider; this code owns kind and candidate validity.
 *
 * Usage: npx tsx scripts/analyst-spike.ts --file <signal.json> [--shelves <shelves.json>]
 * Input: {signal_id, text, source?, link?}. Shelves: [{slug, name, type, aliases}] (default
 * scripts/data/shelves-snapshot.json). Output: printed to stdout and written to scripts/out/analyst-<signal_id>.json.
 * Env: OLLAMA_API_KEY (LLM + Clef), JEV_API_TOKEN (optional, enables Jev first), ANALYST_MODEL (default
 * glm-5.3-flash). Env values are never printed. No deps beyond node built-ins; no .env file is read.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CLEF_ENDPOINT, CLEF_MODEL, JEV_ENDPOINT, JEV_MODEL, SystemOneDecider, type DecisionCase } from '../packages/analyst/src/deciders.ts';

type Decision = 'keep' | 'ignore' | 'unclear';
const ANGLES = ['new_story', 'existing_story', 'plain_update'] as const;
type Angle = (typeof ANGLES)[number];
const DECIDE_TIMEOUT_MS = 30_000;

type Shelf = { slug: string; name: string; type: string; aliases: string[] };
type Candidate = { slug: string; name: string; type: string };
type Mention = { name: string; type: string; search_terms: string[] };
type SignalInput = { signal_id: string; text: string; source: string | null; link: string | null };
type Target = { entity: string; kind: 'existing' | 'new'; type: string; angle: Angle | null; note: string };
type EntityQuestion = { mention: string; question: string; best_shelf_slug: string | null; candidates: Candidate[] };
type KeptDraft = { mention: string; mentionType: string; kind: 'existing' | 'new'; candidates: Candidate[]; best_shelf_slug: string | null };
type JevEntry = { question: string; choices: string[]; answer: string | null; probabilities: Record<string, number> | null; provider: 'jev' | 'clef'; error?: string };
type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
type AnalystResult = {
  signal_id: string; summary: string; decision: Decision; reason: string; targets: Target[];
  debug: { model: string; jev: JevEntry[]; llm_turns: number };
};

const SYSTEM_PROMPT =
  'You are the analyst. You receive one signal, the way a market analyst hears news, posts and talk as it happens. Your job is not to check whether it is true. ' +
  'It is to understand what is being said, who it touches, and what it could mean for them. Read it, dissect it (who, what, why it matters), then decide where ' +
  'it should live. Ask the decision tool first whether this signal is worth keeping, then, for each entity it touches, whether it belongs to an existing entity, ' +
  'needs a new one, or is not related. Use the entity tool to see what exists. After the decision tool answers, decide the angle for each entity: what is forming ' +
  'there, written the way it was said: if someone announces it, it\'s announced; if people are talking about it, it\'s talk. Don\'t make it sound weaker or stronger than it is. ' +
  'The signal comes from a source (a news site, an account, a feed). The source is only the messenger; don\'t treat it as an entity unless the news is about the source itself. Never overrule the decision tool; if its answer makes no sense, mark the signal unclear. ' +
  'Return only the structured output.';

/** Fixed decision-tool questions, written by code (the LLM never writes them). */
function keepQuestionFor(summary: string): string {
  return `Signal summary: "${summary}". Would a crypto trader or market watcher care about this, even if it is only talk for now?`;
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

const ANALYST_MODEL = process.env.ANALYST_MODEL ?? 'glm-5.3-flash';
const LLM_URL = 'https://ollama.com/v1/chat/completions';

// One session: every step below shares this single history.
const history: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
const jevLog: JevEntry[] = [];
let llmTurns = 0;

function str(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : fallback; }
function asRec(row: unknown): Record<string, unknown> { return row && typeof row === 'object' && !Array.isArray(row) ? (row as Record<string, unknown>) : {}; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function snip(text: string): string { return text.replace(/\s+/g, ' ').slice(0, 300); }

function fail(message: string): never {
  console.error(`analyst-spike: ${message}`);
  process.exit(1);
}

/** The one LLM entry point; provider, endpoint and model live only here. */
async function callLLM(messages: ChatMessage[]): Promise<string> {
  const apiKey = process.env.OLLAMA_API_KEY;
  if (!apiKey) throw new Error('OLLAMA_API_KEY is not set');
  const response = await fetch(LLM_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: ANALYST_MODEL, messages, temperature: 0, stream: false }),
  });
  if (!response.ok) throw new Error(`LLM HTTP ${response.status}: ${snip(await response.text())}`);
  const payload = asRec(await response.json());
  const choices = Array.isArray(payload.choices) ? (payload.choices as unknown[]) : [];
  const content = str(asRec(asRec(choices[0]).message).content);
  if (!content.trim()) throw new Error('LLM reply has no content');
  return content;
}

/** One turn of the single session: send, keep the reply in history, parse its JSON. */
async function step(userContent: string): Promise<Record<string, unknown>> {
  history.push({ role: 'user', content: userContent });
  const raw = await callLLM(history);
  history.push({ role: 'assistant', content: raw });
  llmTurns += 1;
  return parseJsonReply(raw);
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

type AskOutcome = { ok: true; choice: string; probabilities: Record<string, number> } | { ok: false; error: string };
type AttemptAnswer = { choice: string; probabilities: Record<string, number> } | { error: string };

/** One System One attempt with its own 30s timeout; errors carry no secrets (redacted in deciders.ts). */
async function attempt(name: 'jev' | 'clef', model: string, endpoint: string, token: string, kase: DecisionCase): Promise<AttemptAnswer> {
  try {
    const answer = await new SystemOneDecider({ name, model, endpoint, apiToken: token }).decide(kase, AbortSignal.timeout(DECIDE_TIMEOUT_MS));
    return { choice: answer.choice, probabilities: answer.probabilities };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

/** The decision tool: Jev first when JEV_API_TOKEN is set, then (or directly) Clef. Every Q/A lands in jevLog. */
async function ask(question: string, choices: string[], state: unknown, candidates: Candidate[] = []): Promise<AskOutcome> {
  const kase: DecisionCase = { question, choices, shortlist: candidates, itemIds: candidates.map((c) => c.slug), state };
  const log = (provider: 'jev' | 'clef', answer: AttemptAnswer): void => {
    const entry: JevEntry = { question, choices, answer: null, probabilities: null, provider };
    if ('error' in answer) entry.error = answer.error;
    else { entry.answer = answer.choice; entry.probabilities = answer.probabilities; }
    jevLog.push(entry);
  };

  const providers = [
    ['jev', JEV_MODEL, JEV_ENDPOINT, process.env.JEV_API_TOKEN],
    ['clef', CLEF_MODEL, CLEF_ENDPOINT, process.env.OLLAMA_API_KEY],
  ] as const;
  const failures: Partial<Record<'jev' | 'clef', string>> = {};
  for (const [provider, model, endpoint, token] of providers) {
    if (!token) continue;
    const answer = await attempt(provider, model, endpoint, token, kase);
    log(provider, answer);
    if ('error' in answer) failures[provider] = answer.error;
    else return { ok: true, ...answer };
  }
  const parts = [
    failures.jev ? `jev failed (${failures.jev})` : 'JEV_API_TOKEN is not set',
    failures.clef ? `clef failed (${failures.clef})` : 'OLLAMA_API_KEY is not set',
  ];
  return { ok: false, error: parts.join('; ') };
}

/** Entity tool: match terms against name/slug/aliases; an exact match on the first term (the mention name) ranks first, then other exact, then whole-word (terms < 3 chars exact-only). */
function searchShelves(terms: string[], shelves: Shelf[]): Candidate[] {
  const wordMatch = (value: string, needle: string): boolean =>
    new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(value);
  const query = [...new Set(terms.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0))];
  const ranked = new Map<string, { rank: number; shelf: Shelf }>();
  for (const term of query) {
    for (const shelf of shelves) {
      const haystacks = [shelf.name, shelf.slug, ...shelf.aliases].map((v) => v.trim().toLowerCase());
      const exact = haystacks.includes(term);
      if (!exact && (term.length < 3 || !haystacks.some((v) => wordMatch(v, term)))) continue;
      const rank = exact ? (term === query[0] ? -1 : 0) : 1;
      const previous = ranked.get(shelf.slug);
      if (!previous || rank < previous.rank) ranked.set(shelf.slug, { rank, shelf });
    }
  }
  return [...ranked.values()].sort((a, b) => a.rank - b.rank).slice(0, 5).map(({ shelf }) => ({ slug: shelf.slug, name: shelf.name, type: shelf.type }));
}

function kebabSlug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }

function toMentions(raw: unknown): Mention[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row): Mention | null => {
      const rec = asRec(row);
      const name = str(rec.name).trim();
      const terms = Array.isArray(rec.search_terms) ? rec.search_terms.filter((t): t is string => typeof t === 'string' && t.trim().length > 0) : [];
      return name ? { name, type: str(rec.type) || 'unknown', search_terms: terms } : null;
    })
    .filter((m): m is Mention => m !== null)
    .slice(0, 3);
}

async function analyze(signal: SignalInput, shelves: Shelf[]): Promise<AnalystResult> {
  const request = { signal_id: signal.signal_id, text: signal.text, source: signal.source, link: signal.link };

  // Turn 1: dissect the signal and shape the keep question.
  const turn1 = await step(
    `Signal:\n${JSON.stringify(request, null, 2)}\n\nReply with JSON only:\n` +
      '{"summary": string, "mentions": [{"name": string, "type": string, "search_terms": string[]}]}\n' +
      'summary: 2-3 sentences (who, what, why it matters). ' +
      'mentions: at most 3 entities this signal touches, each with a type guess and search_terms.'
  );
  const summary = str(turn1.summary);
  if (!summary) throw new Error('no summary in the first reply');
  const keepQuestion = keepQuestionFor(summary);
  const mentions = toMentions(turn1.mentions);

  // Decision 1: is the signal worth keeping at all?
  const keep = await ask(keepQuestion, ['keep', 'ignore'], { signal: signal.text, summary });
  if (!keep.ok) return resultOf(signal, 'unclear', `The decision tool was unreachable. ${keep.error}`, [], summary);
  if (keep.choice === 'ignore') {
    const ignoreReply = await step(
      'The decision tool said ignore. In one sentence, why is this signal not worth keeping? Reply with JSON only: {"reason": string}.'
    );
    return resultOf(signal, 'ignore', str(ignoreReply.reason) || 'The decision tool said ignore.', [], summary);
  }

  // Entity tool: match every mention against the shelves snapshot.
  if (mentions.length === 0) {
    return resultOf(signal, 'keep', 'The decision tool said keep, but no entities were mentioned, so there is nothing to route.', [], summary);
  }
  const searchRows = mentions.map((mention) => ({
    mention: mention.name,
    candidates: searchShelves([mention.name, ...mention.search_terms], shelves),
  }));

  // Fixed per-entity questions; best shelf is the entity tool's top-ranked candidate.
  const entityQuestions: EntityQuestion[] = searchRows.map((row) => ({
    mention: row.mention, question: entityQuestionFor(row.mention, row.candidates),
    best_shelf_slug: row.candidates[0]?.slug ?? null, candidates: row.candidates,
  }));
  // Decision 2: one verdict per mention; this code owns kind and sanity.
  const kept: KeptDraft[] = [];
  const unclearReasons: string[] = [];
  const doubts: Target[] = [];
  for (const eq of entityQuestions) {
    const state = { signal: signal.text, summary, mention: eq.mention, candidates: eq.candidates };
    const choices = eq.candidates.length > 0 ? ['existing', 'new', 'not_related'] : ['new', 'not_related'];
    const verdict = await ask(eq.question, choices, state, eq.candidates);
    if (!verdict.ok) return resultOf(signal, 'unclear', `The decision tool was unreachable. ${verdict.error}`, [], summary);
    if (verdict.choice === 'not_related') continue;
    if (verdict.choice === 'existing' && eq.candidates.length === 0) {
      const why = `The decision tool placed "${eq.mention}" in an existing entity, but the entity search found no candidate shelves.`;
      unclearReasons.push(why);
      doubts.push({ entity: kebabSlug(eq.mention), kind: 'existing', type: mentions.find((m) => m.name === eq.mention)?.type ?? 'unknown', angle: null, note: why });
      continue;
    }
    const kind: 'existing' | 'new' = verdict.choice === 'new' ? 'new' : 'existing';
    const mention = mentions.find((item) => item.name === eq.mention);
    kept.push({ mention: eq.mention, mentionType: mention?.type ?? 'unknown', kind, candidates: eq.candidates, best_shelf_slug: eq.best_shelf_slug });
  }

  if (kept.length === 0 && unclearReasons.length === 0) {
    return resultOf(signal, 'keep', 'The decision tool said keep, but every mentioned entity was judged not related, so there is nothing to route.', [], summary);
  }

  // Turn 3: route the kept entities; kinds are fixed by the decider answers above.
  let reason = '';
  const targets: Target[] = [];
  if (kept.length > 0 && unclearReasons.length === 0) {
    const turn3 = await step(
      `The decision tool has answered; each kind below is fixed and cannot change.\n${JSON.stringify(kept, null, 2)}\n\n` +
        'Reply with JSON only:\n' +
        '{"targets": [{"mention": string, "type": string, "angle": "new_story" | "existing_story" | "plain_update", "note": string}], "reason": string}\n' +
        'One row per kept mention, no others: entities are fixed by code. note: one line on what is forming there.'
    );
    reason = str(turn3.reason);
    const rows = Array.isArray(turn3.targets) ? turn3.targets : [];
    if (rows.length === 0) throw new Error('no targets in the third reply');
    buildTargets(rows, kept, targets, unclearReasons);
  }
  if (unclearReasons.length > 0) return resultOf(signal, 'unclear', unclearReasons.join(' '), doubts, summary);
  return resultOf(signal, 'keep', reason || 'The decision tool answered keep and every kept entity is routed.', targets, summary);
}

/** Enforce decider-fixed kind and candidate validity on the LLM's routing. */
function buildTargets(rows: unknown[], kept: KeptDraft[], targets: Target[], unclearReasons: string[]): void {
  const byMention = new Map<string, Record<string, unknown>>();
  for (const row of rows) byMention.set(str(asRec(row).mention).toLowerCase(), asRec(row));
  kept.forEach((draft, index) => {
    let row = byMention.get(draft.mention.toLowerCase());
    if (!row && rows.length === kept.length) row = asRec(rows[index]);
    const angle = str(row?.angle);
    if (!(ANGLES as readonly string[]).includes(angle)) { unclearReasons.push(`No valid angle was given for "${draft.mention}".`); return; }
    if (draft.kind === 'existing') {
      const slugs = draft.candidates.map((c) => c.slug);
      const entity: string | null = draft.best_shelf_slug && slugs.includes(draft.best_shelf_slug) ? draft.best_shelf_slug : null;
      if (!entity) { unclearReasons.push(`The decision tool placed "${draft.mention}" in an existing entity, but no chosen candidate slug is valid.`); return; }
      const matched = draft.candidates.find((c) => c.slug === entity);
      targets.push({ entity, kind: 'existing', type: str(row?.type) || matched?.type || draft.mentionType, angle: angle as Angle, note: str(row?.note) });
      return;
    }
    const entity = kebabSlug(draft.mention);
    if (!entity) { unclearReasons.push(`No usable slug for the new entity "${draft.mention}".`); return; }
    targets.push({ entity, kind: 'new', type: str(row?.type) || draft.mentionType, angle: angle as Angle, note: str(row?.note) });
  });
}

function resultOf(signal: SignalInput, decision: Decision, reason: string, targets: Target[], summary = ''): AnalystResult {
  return { signal_id: signal.signal_id, summary, decision, reason, targets, debug: { model: ANALYST_MODEL, jev: jevLog, llm_turns: llmTurns } };
}

function writeAndPrint(result: AnalystResult): void {
  const outPath = `${resolve('scripts/out')}/analyst-${result.signal_id.replace(/[^A-Za-z0-9._-]+/g, '_')}.json`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}

function parseArgs(argv: string[]): { file: string; shelvesPath: string } {
  let file: string | undefined;
  let shelvesPath = 'scripts/data/shelves-snapshot.json';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--file') { file = argv[i + 1]; i += 1; }
    else if (argv[i] === '--shelves') { shelvesPath = argv[i + 1] ?? shelvesPath; i += 1; }
  }
  if (!file) fail('usage: npx tsx scripts/analyst-spike.ts --file <signal.json> [--shelves <shelves.json>]');
  return { file, shelvesPath };
}

function asSignal(raw: unknown): SignalInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('signal JSON must be an object');
  const rec = raw as Record<string, unknown>;
  return {
    signal_id: str(rec.signal_id) || fail('signal JSON is missing signal_id'),
    text: str(rec.text) || fail('signal JSON is missing text'),
    source: str(rec.source) || null,
    link: str(rec.link) || null,
  };
}

function asShelves(raw: unknown): Shelf[] {
  if (!Array.isArray(raw)) fail('shelves snapshot must be a JSON array');
  return raw
    .map((row): Shelf => {
      const rec = asRec(row);
      return {
        slug: str(rec.slug),
        name: str(rec.name),
        type: str(rec.type) || 'unknown',
        aliases: Array.isArray(rec.aliases) ? rec.aliases.filter((a): a is string => typeof a === 'string') : [],
      };
    })
    .filter((shelf) => shelf.slug && shelf.name);
}

function loadJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { return fail(`cannot read JSON from ${path}: ${errorMessage(error)}`); }
}

async function main(): Promise<void> {
  const { file, shelvesPath } = parseArgs(process.argv.slice(2));
  const signal = asSignal(loadJson(file));
  const shelves = asShelves(loadJson(shelvesPath));
  try {
    writeAndPrint(await analyze(signal, shelves));
  } catch (error) {
    // LLM/pipeline failure: emit an honest unclear result, never a fabricated one.
    writeAndPrint(resultOf(signal, 'unclear', `LLM call failed: ${errorMessage(error)}`, []));
  }
}

main().catch((error: unknown) => {
  console.error(`analyst-spike: ${errorMessage(error)}`);
  process.exit(1);
});