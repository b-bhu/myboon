// Runs one pass of the #442 analyst eval: drives `hermes --safe-mode` one-shot per
// turn against analyst.SKILL.md over the 50-signal fixture, executing the analyst's
// search_atlas calls locally (read-only PostgREST GETs via tools/search_atlas.ts).
// Appends one record per signal to results/pass-<n>/runs.jsonl; reruns are resumable
// (already-recorded signal_ids are skipped).
//
// Usage: tsx scripts/analyst-eval/run-eval.ts --pass <1..3> [--limit N] [--out dir] [--no-labels]
//
// Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the env; hermes and the model
// provider do the network calls — this process only talks to Supabase and stdout.
import { execFile } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { safeParseSignal, type Signal } from '../../packages/contracts/src/index.js';
import { searchAtlas, type AtlasItem, type AtlasShelf } from './tools/search_atlas.js';
import type { RunRecord } from './score.js';

const execFileP = promisify(execFile);

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(SCRIPT_DIR, 'fixtures');
const RESULTS = join(SCRIPT_DIR, 'results');
const SKILL_PATH = join(SCRIPT_DIR, 'analyst.SKILL.md');
const SIGNALS_PATH = join(FIXTURES, 'signals.json');
const LABELS_PATH = join(FIXTURES, 'labels.csv');

const HERMES_BIN = 'hermes';
const HERMES_ARGS_BASE = ['--safe-mode', '-t', 'clarify', '-m', 'glm-5.3-flash', '--provider', 'ollama-cloud'];
const SIGNAL_BUDGET_MS = 180_000; // per-signal budget across all hermes calls
const MAX_TOOL_CALLS = 10; // matches V4 analyst limit
const SIGNAL_TOKEN_BUDGET = 25_000; // per-signal token budget
const FILE_TURN_RESERVE = 10_000; // ~one hermes call's fixed overhead, kept for the filing turn
const RESULTS_PER_KIND = 5;
const SEARCH_TIMEOUT_MS = 15_000;
const TOKEN_CAP = 3_000_000; // stop the whole run across results/pass-*/
const COST_CAP_USD = 5;
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;

interface UsageTotals {
  tokens: number;
  cost: number;
  apiCalls: number;
}

interface SignalOutcome {
  record: RunRecord | null; // null = nothing attempted, do not write
  stopped: boolean; // spend cap reached: stop the whole run
}

interface TurnLine {
  query: string;
  resultText: string;
}

function parseArgs(argv: readonly string[]): { pass: number; limit: number | null; out: string | null; noLabels: boolean; maxTokens: number | null } {
  let maxTokens: number | null = null;
  let pass = NaN;
  let limit: number | null = null;
  let out: string | null = null;
  let noLabels = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--pass') pass = Number(argv[++i]);
    else if (arg === '--limit') limit = Number(argv[++i]);
    else if (arg === '--out') out = argv[++i] ?? null;
    else if (arg === '--no-labels') noLabels = true;
    else if (arg === '--max-tokens') maxTokens = Number(argv[++i]);
    else {
      console.error(`usage: tsx scripts/analyst-eval/run-eval.ts --pass <1..3> [--limit N] [--out dir] [--no-labels] [--max-tokens N] (unknown arg: ${arg})`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(pass) || pass < 1 || pass > 3) {
    console.error('refusing to run: --pass must be an integer 1..3');
    process.exit(2);
  }
  return {
    pass,
    limit: Number.isFinite(limit) && limit !== null ? limit : null,
    out,
    noLabels,
    maxTokens: maxTokens !== null && Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : null,
  };
}

function loadSignals(): Signal[] {
  const raw = JSON.parse(readFileSync(SIGNALS_PATH, 'utf8')) as unknown[];
  return raw.map((entry) => {
    const parsed = safeParseSignal(entry);
    if (!parsed.success) throw new Error('fixtures/signals.json contains an invalid #440 Signal — rebuild with build-fixture.ts');
    return parsed.data;
  });
}

/** Sums tokens/cost across every recorded runs.jsonl under results/ (spend-cap baseline). */
function sumRecordedSpend(): UsageTotals {
  const totals: UsageTotals = { tokens: 0, cost: 0, apiCalls: 0 };
  if (!existsSync(RESULTS)) return totals;
  for (const dir of readdirSync(RESULTS)) {
    if (!dir.startsWith('pass-')) continue;
    const path = join(RESULTS, dir, 'runs.jsonl');
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const rec = JSON.parse(trimmed) as Partial<RunRecord>;
        totals.tokens += typeof rec.tokens === 'number' ? rec.tokens : 0;
        totals.cost += typeof rec.cost_usd === 'number' ? rec.cost_usd : 0;
        totals.apiCalls += typeof rec.api_calls === 'number' ? rec.api_calls : 0;
      } catch {
        console.error(`warning: skipping malformed line in ${path}`);
      }
    }
  }
  return totals;
}

function readUsageFile(path: string): UsageTotals | null {
  try {
    const usage = JSON.parse(readFileSync(path, 'utf8')) as {
      total_including_auxiliary?: { total_tokens?: number; estimated_cost_usd?: number; api_calls?: number };
    };
    const t = usage.total_including_auxiliary ?? {};
    return {
      tokens: typeof t.total_tokens === 'number' ? t.total_tokens : 0,
      cost: typeof t.estimated_cost_usd === 'number' ? t.estimated_cost_usd : 0,
      apiCalls: typeof t.api_calls === 'number' ? t.api_calls : 0,
    };
  } catch {
    return null; // missing/unreadable -> caller treats as 0 and records an error
  }
}

/** Extracts the first balanced {...} JSON object from arbitrary model text. */
export function extractFirstJsonObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const slice = text.slice(i, j + 1);
          try {
            return { ok: true, value: JSON.parse(slice) as Record<string, unknown> };
          } catch {
            break; // not the start of the real object; try the next '{'
          }
        }
      }
    }
  }
  return { ok: false };
}

// Strips raw_ids from the signal view the model gets.
function signalView(signal: Signal): Record<string, unknown> {
  return { ...signal, raw_ids: undefined } as unknown as Record<string, unknown>;
}

function trimShelf(s: AtlasShelf): Record<string, unknown> {
  return { id: s.id, slug: s.slug, name: s.name, aliases: (s.aliases ?? []).slice(0, 3) };
}

function trimItem(s: AtlasItem): Record<string, unknown> {
  return { id: s.id, item_key: s.item_key, title: s.title, main_shelf_id: s.main_shelf_id };
}

function renderTurn(turn: TurnLine): string {
  return `search_atlas ${JSON.stringify(turn.query)} -> ${turn.resultText}`;
}

/** Skill text for the forced filing turn: the search tool is not offered. */
export function fileOnlySkill(skill: string): string {
  return skill
    .split('\n')
    .filter((line) => !/search_atlas|^\s*Results list|^- Search first/.test(line))
    .join('\n');
}

/** The model must file now: tool-call cap reached or per-signal token budget spent. */
export function mustFile(toolCalls: number, tokens: number): boolean {
  return toolCalls >= MAX_TOOL_CALLS || tokens >= SIGNAL_TOKEN_BUDGET - FILE_TURN_RESERVE;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runSignal(
  signal: Signal,
  skill: string,
  usageDir: string,
  usageCounter: { n: number },
  base: UsageTotals,
  passCap: { cap: number | null; spent: number },
): Promise<SignalOutcome> {
  const startedAt = Date.now();
  const turns: TurnLine[] = [];
  let toolCalls = 0;
  let hermesCalls = 0;
  let tokens = 0;
  let cost = 0;
  let apiCalls = 0;
  let decision: unknown = null;
  let parseOk = false;
  let error: string | null = null;
  let overrun = false;
  let needsReview = false;
  const seenShelfIds = new Set<string>();

  while (true) {
    // Spend cap: recorded spend across all passes + everything accrued so far in
    // this run (including this in-flight signal).
    const overPass = passCap.cap !== null && passCap.spent + tokens >= passCap.cap;
    if (overPass || base.tokens + tokens >= TOKEN_CAP || base.cost + cost >= COST_CAP_USD) {
      const spent = `tokens=${base.tokens + tokens}, cost=$${(base.cost + cost).toFixed(2)}`;
      if (hermesCalls === 0) {
        console.log(`stopped by spend cap before first hermes call (${spent})`);
        return { record: null, stopped: true };
      }
      error = `stopped by spend cap mid-signal (${spent})`;
      break;
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= SIGNAL_BUDGET_MS) {
      if (hermesCalls === 0) return { record: null, stopped: false };
      overrun = true;
      error = `overrun: ${SIGNAL_BUDGET_MS / 1000}s signal budget exceeded`;
      break;
    }

    const remainingMs = SIGNAL_BUDGET_MS - (Date.now() - startedAt);
    const forced = mustFile(toolCalls, tokens);
    const prompt = [
      forced ? fileOnlySkill(skill) : skill,
      '## Signal',
      JSON.stringify(signalView(signal)),
      '## Tool transcript',
      turns.length === 0 ? '(none)' : turns.map((t, k) => `${k + 1}. ${renderTurn(t)}`).join('\n'),
      forced
        ? 'Search budget used up. File now with what you have: reply with only your {"final": ...} decision. If no shelf in the results fits, use main shelf_id "none" with a short reason.'
        : `(tool calls used: ${toolCalls}/${MAX_TOOL_CALLS}) Reply with one JSON object.`,
    ].join('\n');
    const usagePath = join(usageDir, `usage-${usageCounter.n++}.json`);

    let stdout = '';
    let callFailed = false;
    try {
      const res = await execFileP(HERMES_BIN, [...HERMES_ARGS_BASE, '--usage-file', usagePath, '-z', prompt], {
        timeout: remainingMs,
        maxBuffer: MAX_STDOUT_BYTES,
        encoding: 'utf8',
      });
      stdout = res.stdout;
    } catch (err) {
      const e = err as Error & { killed?: boolean; code?: string; signal?: string };
      if (e.code === 'ENOENT') {
        throw new Error('hermes binary not found on PATH — install/wire it before running the eval');
      }
      if (e.killed === true || e.signal === 'SIGTERM' || /timed out/i.test(e.message)) {
        overrun = true;
        error = 'overrun: hermes call exceeded its remaining share of the 180s signal budget (killed)';
      } else {
        error = `hermes call failed: ${e.message.split('\n')[0]}`;
      }
      callFailed = true;
    }
    hermesCalls++;

    const usage = readUsageFile(usagePath);
    if (usage === null && !callFailed) {
      error = 'hermes usage file missing after a completed call — usage counted as 0';
    } else if (usage !== null) {
      tokens += usage.tokens;
      cost += usage.cost;
      apiCalls += usage.apiCalls;
    }
    if (callFailed) break;

    const extracted = extractFirstJsonObject(stdout);
    if (!extracted.ok) {
      parseOk = false;
      error = `model output on turn ${hermesCalls} contained no JSON object`;
      break;
    }
    const reply = extracted.value;

    if (reply.tool === 'search_atlas' && typeof reply.query === 'string') {
      if (forced) {
        needsReview = true;
        error = `needs review: did not file on the forced filing turn (${toolCalls}/${MAX_TOOL_CALLS} calls, ${tokens} tokens)`;
        break;
      }
      try {
        const result = await withTimeout(searchAtlas(reply.query, { env: process.env }), SEARCH_TIMEOUT_MS, `search_atlas "${reply.query}"`);
        for (const shelf of result.shelves.slice(0, RESULTS_PER_KIND)) seenShelfIds.add(shelf.id);
        turns.push({
          query: reply.query,
          resultText: JSON.stringify({ shelves: result.shelves.slice(0, RESULTS_PER_KIND).map(trimShelf), items: result.items.slice(0, RESULTS_PER_KIND).map(trimItem) }),
        });
      } catch (err) {
        turns.push({
          query: reply.query,
          resultText: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        });
      }
      toolCalls++;
      continue;
    }

    if (reply.final !== undefined) {
      parseOk = true;
      decision = reply.final;
      break;
    }

    error = `model JSON on turn ${hermesCalls} was neither a search_atlas call nor a final decision`;
    break;
  }

  const record: RunRecord = {
    signal_id: signal.signal_id,
    decision,
    parse_ok: parseOk,
    error,
    tool_calls: toolCalls,
    seconds: Math.round(((Date.now() - startedAt) / 1000) * 10) / 10,
    tokens,
    cost_usd: Math.round(cost * 1e9) / 1e9,
    api_calls: apiCalls,
    hermes_calls: hermesCalls,
    overrun,
    needs_review: needsReview,
    seen_shelf_ids: [...seenShelfIds],
  };
  return { record, stopped: false };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(LABELS_PATH) && !args.noLabels) {
    console.error(`refusing to run: ${LABELS_PATH} missing — write labels first, or pass --no-labels for a smoke run`);
    process.exit(1);
  }

  const signalsAll = loadSignals();
  const signals = args.limit && args.limit > 0 ? signalsAll.slice(0, args.limit) : signalsAll;
  const outDir = args.out ? resolve(args.out) : join(RESULTS, `pass-${args.pass}`);
  mkdirSync(outDir, { recursive: true });
  const runsPath = join(outDir, 'runs.jsonl');

  const done = new Set<string>();
  if (existsSync(runsPath)) {
    for (const line of readFileSync(runsPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        done.add((JSON.parse(trimmed) as { signal_id?: string }).signal_id ?? '');
      } catch {
        console.error(`warning: skipping malformed line in ${runsPath}`);
      }
    }
  }
  const alreadyDone = [...done].filter(Boolean).length;

  const base = sumRecordedSpend();
  const skill = readFileSync(SKILL_PATH, 'utf8');
  const usageDir = mkdtempSync(join(os.tmpdir(), 'analyst-eval-usage-'));
  try {
    let stopped = false;
    const passCap = { cap: args.maxTokens, spent: 0 };
    for (const signal of signals) {
      if (done.has(signal.signal_id)) continue;
      const usageCounter = { n: 0 };
      const outcome = await runSignal(signal, skill, usageDir, usageCounter, base, passCap);
      if (outcome.stopped) {
        stopped = true;
        break;
      }
      if (outcome.record === null) continue;
      appendFileSync(runsPath, `${JSON.stringify(outcome.record)}\n`);
      done.add(signal.signal_id);
      passCap.spent += outcome.record.tokens;
      const rec = outcome.record;
      const tag = rec.decision !== null && rec.parse_ok ? 'ok' : `error: ${rec.error ?? 'unknown'}`;
      console.log(`${rec.signal_id.slice(0, 8)} tools=${rec.tool_calls} turns=${rec.hermes_calls} ${rec.seconds}s tokens=${rec.tokens} ${tag}`);
    }
    const ran = done.size - alreadyDone;
    const summary = stopped ? `STOPPED EARLY: spend cap reached (pass tokens=${passCap.spent}, cap ${args.maxTokens ?? 'none'}; total cap 3M / $5)` : 'run complete';
    console.log(`${summary}; new records: ${ran}, previously recorded: ${alreadyDone}, out: ${runsPath}`);
  } finally {
    rmSync(usageDir, { recursive: true, force: true });
  }
}

/** True when run-eval.ts is the process entry point (not under `import`). */
function isEntryModule(): boolean {
  const argvPath = process.argv[1];
  const filePath = fileURLToPath(import.meta.url);
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(filePath);
  } catch {
    return argvPath === filePath;
  }
}

if (isEntryModule()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}