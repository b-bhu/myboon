// Scores one analyst-eval pass: fixtures/signals.json vs fixtures/labels.csv and
// results/pass-<n>/runs.jsonl (from run-eval.ts). Decision validity is judged with
// the #440 contracts (safeParseDecision); shelf ids are resolved to slugs with
// getShelvesByIds (atlas, read-only GET).
//
// Usage: tsx scripts/analyst-eval/score.ts --pass <1..3>
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSignal, safeParseDecision } from '../../packages/contracts/src/index.js';
import { getShelvesByIds } from './tools/search_atlas.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(SCRIPT_DIR, 'fixtures');
const RESULTS = join(SCRIPT_DIR, 'results');
/** Pass needs BOTH: main shelf >= 31/36 labelled signals and keep/skip >= 43/50 (CTO, #442). */
export const MAIN_PASS_MARK = 31 / 36;
export const ACTION_PASS_MARK = 43 / 50;

export interface LabelRow {
  signal_id: string;
  expected_main_shelf: string;
  expected_target_item_id: string;
  expected_action: string;
  notes: string;
}

/** One record as appended by run-eval.ts to runs.jsonl. */
export interface RunRecord {
  signal_id: string;
  decision: unknown;
  parse_ok: boolean;
  error: string | null;
  tool_calls: number;
  seconds: number;
  tokens: number;
  cost_usd: number;
  api_calls: number;
  hermes_calls: number;
  overrun: boolean;
}

export interface ScoreSignal {
  signal_id: string;
}

export interface ScoreRow {
  signal_id: string;
  has_run: boolean;
  labeled: boolean; // has expected_main_shelf
  has_target_label: boolean;
  expected_main_shelf: string | null;
  expected_target_item_id: string | null;
  got_main_shelf: string | null; // slug via shelfSlugById
  confidence: number | null;
  decision_valid: boolean;
  parse_ok: boolean;
  overrun: boolean;
  skipped: boolean;
  target_agree: boolean | null; // null = no label to compare
  expected_action: string | null;
  got_action: 'keep' | 'skip' | null; // file -> its action, merge -> keep, none -> null
  action_agree: boolean | null; // null = no expected_action label
  uncertain: boolean; // label notes flag UNCERTAIN (soft miss when wrong)
  tool_calls: number | null;
  seconds: number | null;
  tokens: number | null;
  cost_usd: number | null;
  api_calls: number | null;
  hermes_calls: number | null;
  /** ok = valid decision, no overrun, and (unlabeled or expected main shelf hit). */
  ok: boolean;
}

export interface ScoreResult {
  rows: ScoreRow[];
  rowCount: number;
  recordCount: number;
  labeledCount: number; // rows with expected_main_shelf
  correctCount: number; // labeled rows with ok
  accuracy: number | null; // null when no labels
  mainPass: boolean; // accuracy >= 31/36
  actionTotal: number; // rows with expected_action
  actionAgreeCount: number;
  actionAccuracy: number | null;
  actionPass: boolean; // >= 43/50
  pass: boolean; // mainPass && actionPass
  uncertainCount: number;
  uncertainMisses: number; // uncertain rows that are a main-shelf or keep/skip miss (soft)
  targetTotal: number;
  targetAgree: number;
  skipCount: number;
  skipRate: number | null; // skips / valid decisions
  parseFailures: number;
  invalidDecisions: number;
  overruns: number;
  missing: number; // labeled signals with no run record
  totalTokens: number;
  meanTokens: number | null;
  totalCost: number;
  totalApiCalls: number;
  totalSeconds: number;
  meanSeconds: number | null;
}

/** Minimal RFC-4180 parser: quoted fields, escaped quotes, commas inside quotes. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
    i++;
  }
  if (field !== '' || row.length > 1 || (row.length === 1 && row[0] !== '')) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

/** Parses fixtures/labels.csv (header: signal_id,expected_main_shelf,...). */
export function parseLabelsCsv(text: string): LabelRow[] {
  const rows = parseCsvRows(text);
  const header = rows.shift();
  if (!header || header[0] !== 'signal_id') {
    throw new Error('labels.csv: first line must start with "signal_id"');
  }
  const col = (name: string) => header.indexOf(name);
  const cMain = col('expected_main_shelf');
  const cTarget = col('expected_target_item_id');
  const cAction = col('expected_action');
  const cNotes = col('notes');
  const at = (row: string[], idx: number) => idx === -1 ? '' : (row[idx] ?? '');
  return rows.map((row) => ({
    signal_id: row[0] ?? '',
    expected_main_shelf: at(row, cMain),
    expected_target_item_id: at(row, cTarget),
    expected_action: at(row, cAction),
    notes: at(row, cNotes),
  })).filter((row) => row.signal_id !== '');
}

export function scoreRun(
  signals: readonly ScoreSignal[],
  labels: readonly LabelRow[],
  runs: readonly RunRecord[],
  shelfSlugById: ReadonlyMap<string, string>,
): ScoreResult {
  const labelsById = new Map(labels.map((l) => [l.signal_id, l]));
  const runsById = new Map(runs.map((r) => [r.signal_id, r]));

  const rows = signals.map((signal) => evalRow(signal, labelsById.get(signal.signal_id), runsById.get(signal.signal_id), shelfSlugById));
  const labeledRows = rows.filter((r) => r.labeled);
  const validDecisions = rows.filter((r) => r.decision_valid);
  const withRun = rows.filter((r) => r.has_run);
  const sum = (pick: (r: ScoreRow) => number | null) => withRun.reduce((acc, r) => acc + (pick(r) ?? 0), 0);

  const accuracy = labeledRows.length > 0 ? correctCount(rows) / labeledRows.length : null;
  const actionRows = rows.filter((r) => r.action_agree !== null);
  const actionAgreeCount = actionRows.filter((r) => r.action_agree === true).length;
  const actionAccuracy = actionRows.length > 0 ? actionAgreeCount / actionRows.length : null;
  const EPS = 1e-9;
  const mainPass = accuracy !== null && accuracy + EPS >= MAIN_PASS_MARK;
  const actionPass = actionAccuracy !== null && actionAccuracy + EPS >= ACTION_PASS_MARK;
  const uncertainRows = rows.filter((r) => r.uncertain);
  return {
    rows,
    rowCount: rows.length,
    recordCount: withRun.length,
    labeledCount: labeledRows.length,
    correctCount: correctCount(rows),
    accuracy,
    mainPass,
    actionTotal: actionRows.length,
    actionAgreeCount,
    actionAccuracy,
    actionPass,
    pass: mainPass && actionPass,
    uncertainCount: uncertainRows.length,
    uncertainMisses: uncertainRows.filter(isMiss).length,
    targetTotal: rows.filter((r) => r.has_target_label).length,
    targetAgree: rows.filter((r) => r.target_agree === true).length,
    skipCount: validDecisions.filter((r) => r.skipped).length,
    skipRate: validDecisions.length > 0 ? validDecisions.filter((r) => r.skipped).length / validDecisions.length : null,
    parseFailures: withRun.filter((r) => !r.parse_ok).length,
    invalidDecisions: withRun.filter((r) => r.parse_ok && !r.decision_valid).length,
    overruns: withRun.filter((r) => r.overrun).length,
    missing: labeledRows.filter((r) => !r.has_run).length,
    totalTokens: sum((r) => r.tokens),
    meanTokens: withRun.length > 0 ? sum((r) => r.tokens) / withRun.length : null,
    totalCost: sum((r) => r.cost_usd),
    totalApiCalls: sum((r) => r.api_calls),
    totalSeconds: sum((r) => r.seconds),
    meanSeconds: withRun.length > 0 ? sum((r) => r.seconds) / withRun.length : null,
  };
}

function isMiss(r: ScoreRow): boolean {
  return (r.labeled && !r.ok) || r.action_agree === false;
}

function correctCount(rows: readonly ScoreRow[]): number {
  return rows.filter((r) => r.labeled && r.ok).length;
}

function evalRow(
  signal: ScoreSignal,
  label: LabelRow | undefined,
  run: RunRecord | undefined,
  shelfSlugById: ReadonlyMap<string, string>,
): ScoreRow {
  const labeled = label !== undefined && label.expected_main_shelf !== '';
  const hasTargetLabel = label !== undefined && label.expected_target_item_id !== '';

  const parsed = run?.decision == null ? { success: false as const } : safeParseDecision(run.decision);
  const file = parsed.success && parsed.data.decision_type === 'file' && parsed.data.signal_id === signal.signal_id
    ? parsed.data
    : null;
  const decisionValid = file !== null;
  const anyDecision = parsed.success && parsed.data.signal_id === signal.signal_id && !(run?.overrun ?? false)
    ? parsed.data
    : null;
  const gotAction: 'keep' | 'skip' | null = anyDecision === null
    ? null
    : anyDecision.decision_type === 'file' ? anyDecision.action : 'keep';
  const expectedAction = label !== undefined && label.expected_action.trim() !== '' ? label.expected_action.trim() : null;
  const actionAgree = expectedAction === null ? null : gotAction === expectedAction;
  const uncertain = label !== undefined && /UNCERTAIN/i.test(label.notes);
  const mainShelf = file !== null ? file.shelves.find((s) => s.role === 'main')! : null;
  const gotSlug = mainShelf === null ? null : (shelfSlugById.get(mainShelf.shelf_id) ?? null);

  const targetAgree = !hasTargetLabel
    ? null
    : file !== null && file.target_item_id === label!.expected_target_item_id;
  const ok = run !== undefined
    && decisionValid
    && !run.overrun
    && (!labeled || gotSlug === label!.expected_main_shelf);

  return {
    signal_id: signal.signal_id,
    has_run: run !== undefined,
    labeled,
    has_target_label: hasTargetLabel,
    expected_main_shelf: labeled ? label!.expected_main_shelf : null,
    expected_target_item_id: hasTargetLabel ? label!.expected_target_item_id : null,
    got_main_shelf: gotSlug,
    confidence: file !== null ? file.confidence : null,
    decision_valid: decisionValid,
    parse_ok: run?.parse_ok ?? false,
    overrun: run?.overrun ?? false,
    skipped: file !== null && file.action === 'skip',
    target_agree: targetAgree,
    expected_action: expectedAction,
    got_action: gotAction,
    action_agree: actionAgree,
    uncertain,
    tool_calls: run?.tool_calls ?? null,
    seconds: run?.seconds ?? null,
    tokens: run?.tokens ?? null,
    cost_usd: run?.cost_usd ?? null,
    api_calls: run?.api_calls ?? null,
    hermes_calls: run?.hermes_calls ?? null,
    ok,
  };
}

/** Renders the scorer output as markdown (table + totals). */
export function renderMarkdown(pass: number, r: ScoreResult): string {
  const lines: string[] = [];
  lines.push(`# Analyst eval — pass ${pass}`, '');
  lines.push(`signals: ${r.rowCount}, runs: ${r.recordCount}, labeled: ${r.labeledCount}, labeled without run: ${r.missing}`, '');
  lines.push('| signal_id | expected | got | action exp/got | conf | tools | s | tokens | ok |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const row of r.rows) {
    const expected = row.labeled ? row.expected_main_shelf : null;
    let got: string;
    if (!row.has_run) got = 'no-run';
    else if (!row.parse_ok) got = 'parse-fail';
    else if (!row.decision_valid) got = 'invalid-decision';
    else got = row.got_main_shelf ?? 'unknown-shelf';
    lines.push(`| ${row.signal_id.slice(0, 8)} | ${expected ?? '—'} | ${got} | ${row.expected_action ?? '—'}/${row.got_action ?? '—'}${row.action_agree === false ? ' ✗' : ''}${row.uncertain ? ' (U)' : ''} | ${row.confidence === null ? '' : row.confidence.toFixed(2)} | ${row.tool_calls ?? ''} | ${row.seconds === null ? '' : row.seconds.toFixed(1)} | ${row.tokens ?? ''} | ${row.ok ? '✓' : row.labeled ? '✗' : '—'} |`);
  }
  lines.push('');
  const pct = (x: number | null) => `${((x ?? 0) * 100).toFixed(1)}%`;
  lines.push(r.labeledCount === 0
    ? 'main-shelf accuracy: no labels (needs >= 31/36)'
    : `main-shelf accuracy: ${r.correctCount}/${r.labeledCount} = ${pct(r.accuracy)} — ${r.mainPass ? 'ok' : 'below'} (needs >= 31/36)`);
  lines.push(r.actionTotal === 0
    ? 'keep/skip agreement: no labels (needs >= 43/50)'
    : `keep/skip agreement: ${r.actionAgreeCount}/${r.actionTotal} = ${pct(r.actionAccuracy)} — ${r.actionPass ? 'ok' : 'below'} (needs >= 43/50)`);
  lines.push(`overall: ${r.pass ? 'PASS' : 'FAIL'}`);
  lines.push(`target_item_id agreement: ${r.targetAgree}/${r.targetTotal}`);
  lines.push(`skip rate: ${r.skipCount}/${r.recordCount} decisions${r.skipRate === null ? '' : ` (${(r.skipRate * 100).toFixed(1)}%)`}`);
  lines.push(`parse failures: ${r.parseFailures}, overruns: ${r.overruns}, invalid decisions: ${r.invalidDecisions}`);
  lines.push(`tokens: ${Math.round(r.totalTokens)} total${r.meanTokens === null ? '' : `, ${Math.round(r.meanTokens)} mean`}`);
  lines.push(`cost: $${r.totalCost.toFixed(2)}, api_calls: ${r.totalApiCalls}, seconds: ${r.totalSeconds.toFixed(1)} total${r.meanSeconds === null ? '' : `, ${r.meanSeconds.toFixed(1)} mean`}`);
  const uncertain = r.rows.filter((row) => row.uncertain);
  if (uncertain.length > 0) {
    lines.push('', `## UNCERTAIN labels (soft misses): ${r.uncertainMisses}/${r.uncertainCount} missed`, '');
    lines.push('| signal_id | expected shelf | got | action exp/got | miss |');
    lines.push('|---|---|---|---|---|');
    for (const row of uncertain) {
      lines.push(`| ${row.signal_id.slice(0, 8)} | ${row.expected_main_shelf ?? '—'} | ${row.got_main_shelf ?? '—'} | ${row.expected_action ?? '—'}/${row.got_action ?? '—'} | ${isMiss(row) ? 'soft' : ''} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function parsePassArg(argv: readonly string[]): number {
  const idx = argv.indexOf('--pass');
  const raw = idx !== -1 ? argv[idx + 1] : undefined;
  const pass = Number(raw);
  if (!Number.isInteger(pass) || pass < 1 || pass > 3) {
    console.error('usage: tsx scripts/analyst-eval/score.ts --pass <1..3>');
    process.exit(2);
  }
  return pass;
}

async function main(): Promise<void> {
  const pass = parsePassArg(process.argv.slice(2));
  const outDir = join(RESULTS, `pass-${pass}`);
  const runsPath = join(outDir, 'runs.jsonl');
  if (!existsSync(runsPath)) {
    console.error(`no runs.jsonl at ${runsPath} — run run-eval.ts --pass ${pass} first`);
    process.exit(1);
  }

  const runs: RunRecord[] = readFileSync(runsPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, i) => {
      const rec = JSON.parse(line) as RunRecord;
      if (typeof rec.signal_id !== 'string') throw new Error(`runs.jsonl line ${i + 1}: missing signal_id`);
      return rec;
    });

  const signals = (JSON.parse(readFileSync(join(FIXTURES, 'signals.json'), 'utf8')) as unknown[])
    .map((raw) => parseSignal(raw));
  const knownIds = new Set(signals.map((s) => s.signal_id));
  const unknownRuns = runs.filter((r) => !knownIds.has(r.signal_id));
  if (unknownRuns.length > 0) {
    console.error(`warning: ${unknownRuns.length} run records reference unknown signal_ids`);
  }

  const labelsPath = join(FIXTURES, 'labels.csv');
  const labels = existsSync(labelsPath) ? parseLabelsCsv(readFileSync(labelsPath, 'utf8')) : [];
  if (labels.length === 0) console.error('note: labels.csv missing or empty — accuracy unavailable');
  else {
    const strayLabels = labels.filter((l) => !knownIds.has(l.signal_id)).length;
    if (strayLabels > 0) console.error(`warning: ${strayLabels} labels reference unknown signal_ids`);
  }

  // Resolve every shelf id referenced by an (attempted) decision to its atlas slug.
  const shelfIds = new Set<string>();
  for (const run of runs) {
    if (run.decision == null) continue;
    const parsed = safeParseDecision(run.decision);
    if (parsed.success && parsed.data.decision_type === 'file') {
      for (const shelf of parsed.data.shelves) shelfIds.add(shelf.shelf_id);
    }
  }
  let slugById = new Map<string, string>();
  if (shelfIds.size > 0) {
    try {
      const refs = await getShelvesByIds([...shelfIds], { env: process.env });
      slugById = new Map(refs.map((ref) => [ref.id, ref.slug]));
    } catch (err) {
      console.error(`could not resolve shelf ids from atlas: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  const result = scoreRun(signals, labels, runs, slugById);
  const markdown = renderMarkdown(pass, result);
  writeFileSync(join(outDir, 'results.md'), markdown);
  console.log(markdown);
}

/** True when score.ts is the process entry point (not under `import` in tests). */
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