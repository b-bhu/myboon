/**
 * The eval gate (#623 Verification): run the editor and the write bar over the frozen set in eval/ and compare
 * with Bibhu's labels. Pure functions, so every number can be tested without a model or a database.
 *
 * Label mapping: a `write` label means "publish"; a `hold` label means "do not publish". The job's answer is
 * `write` only when the write bar publishes; model hold, model skip and a write the bar holds all count as `hold`
 * (nothing is shown to readers in each case).
 *
 * Bars (pass = all):
 *   untraced claims published      0   (a published draft with an unsourced claim or an invented number)
 *   period mismatches published    0
 *   agreement with labels          >= 80%
 *   hold-recall                    >= 80% (of the entities labelled hold, the job did not publish)
 *   timeouts after retry           < 5%
 * Untraced and period counts BEFORE the code gate (what the model drafted) are reported next to them, because the
 * code gate makes the published count 0 by construction; the pre-gate count shows how often it had to step in.
 */
import { readFileSync } from 'node:fs';

import { askEditor } from './editor.js';
import type { Llm } from './clients.js';
import { checkClaims, checkDraftNumbers, loadedSourceIds, runWriteBar } from './checks.js';
import { checkPeriods } from './periods.js';
import { allSourcesText, canonicalizeNumberText, draftText, maskIgnoredSpans } from './text.js';
import type { Bundle, CheckFailure, Item, Signal } from './types.js';

export const BARS = { agreement: 0.8, holdRecall: 0.8, timeoutRate: 0.05 } as const;
export const MIN_HOLD_LABELS = 8;
export const EVAL_ATTEMPTS = 3;

export type SnapshotEntity = {
  id: string; slug: string; name: string; type: string; summary: string | null;
  new_items: Array<Partial<Item> & { id: string; title: string; created_at: string }>;
  last_update: (Partial<Item> & { id: string; title: string }) | null;
  prior_items: Array<Partial<Item> & { id: string; title: string }>;
  origin_signals: Array<Partial<Signal> & { signal_id: string }>;
};
export type Snapshot = { meta: { frozen_at?: string; window?: Record<string, unknown> }; entities: SnapshotEntity[] };
export type Label = 'write' | 'hold';

export function loadSnapshot(path: string): Snapshot {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const o = raw as Snapshot;
  if (!o || typeof o !== 'object' || !Array.isArray(o.entities)) throw new Error('snapshot.json needs an entities array');
  for (const [i, e] of o.entities.entries()) {
    if (typeof e.slug !== 'string' || typeof e.id !== 'string' || !Array.isArray(e.new_items) || e.new_items.length === 0) {
      throw new Error(`snapshot entity ${i} needs id, slug and at least one new item`);
    }
  }
  return o;
}

const asItem = (i: Partial<Item> & { id: string; title: string; created_at?: string }): Item => ({
  id: i.id, title: i.title, summary: i.summary ?? null, note: i.note ?? null, angle: i.angle ?? null,
  occurred_at: i.occurred_at ?? null, created_at: i.created_at ?? '', signal_id: i.signal_id ?? null,
});

/** The bundle the runner would build for this entity: its newest new item is the decision's key. */
export function snapshotToBundle(e: SnapshotEntity): Bundle {
  const newItems = e.new_items.map(asItem);
  const newest = [...newItems].sort((a, b) => (Date.parse(b.occurred_at ?? '') || 0) - (Date.parse(a.occurred_at ?? '') || 0) || (a.id < b.id ? 1 : -1))[0]!;
  const newIds = new Set(newItems.map((i) => i.id));
  const last = e.last_update ? asItem(e.last_update) : null;
  return {
    entity: { id: e.id, slug: e.slug, name: e.name, type: e.type, summary: e.summary },
    newest_item_id: newest.id,
    new_items: newItems,
    prior_items: e.prior_items.filter((i) => !newIds.has(i.id)).map(asItem),
    origin_signals: e.origin_signals.map((s) => ({
      signal_id: s.signal_id, type: s.type ?? null, source: s.source ?? null, text: s.text ?? null, excerpt: s.excerpt ?? null,
      numbers: s.numbers ?? null, link: s.link ?? null, occurred_at: s.occurred_at ?? null, created_at: s.created_at ?? null,
    })),
    last_update: last ? { kind: 'earlier_item', id: last.id, title: last.title, date: last.occurred_at ?? last.created_at, text: [last.title, last.summary ?? '', last.note ?? ''].filter(Boolean).join('\n') } : null,
  };
}

// ---------- labels ----------

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export type Labels = { byslug: Map<string, Label>; rows: number; blank: number };

/** `slug,label,note`. A blank label is "not labelled yet". Anything else but write/hold is an error. */
export function parseLabels(text: string): Labels {
  const rows = parseCsv(text);
  const header = rows[0]?.map((c) => c.trim().toLowerCase()) ?? [];
  if (header[0] !== 'slug' || header[1] !== 'label') throw new Error('labels.csv must start with the header slug,label,note');
  const byslug = new Map<string, Label>();
  let blank = 0;
  for (const [i, r] of rows.slice(1).entries()) {
    const slug = (r[0] ?? '').trim();
    const label = (r[1] ?? '').trim().toLowerCase();
    if (!slug) throw new Error(`labels.csv row ${i + 2} has no slug`);
    if (label === '') { blank += 1; continue; }
    if (label !== 'write' && label !== 'hold') throw new Error(`labels.csv row ${i + 2} (${slug}): label must be write or hold`);
    byslug.set(slug, label);
  }
  return { byslug, rows: rows.length - 1, blank };
}

// ---------- running ----------

export type EntityResult = {
  slug: string;
  /** write = published by the bar; hold = model hold, or a write the bar held; skip; error = every attempt failed. */
  answer: 'write' | 'hold' | 'skip' | 'error';
  modelDecision: 'write' | 'hold' | 'skip' | null;
  reason: string;
  attempts: number;
  timedOut: boolean;
  failures: CheckFailure[];
  /** Counted on the model's own draft before the gate. */
  untracedClaimsInDraft: number;
  periodMismatchesInDraft: number;
  /** Counted on what would be published. */
  untracedPublished: number;
  periodMismatchesPublished: number;
};

export async function evaluateEntity(e: SnapshotEntity, llm: Llm, attempts = EVAL_ATTEMPTS): Promise<EntityResult> {
  const bundle = snapshotToBundle(e);
  let last = await askEditor(bundle, llm);
  let tries = 1;
  while (last.kind === 'error' && tries < attempts) { last = await askEditor(bundle, llm); tries += 1; }
  const base = { slug: e.slug, attempts: tries, failures: [] as CheckFailure[], untracedClaimsInDraft: 0, periodMismatchesInDraft: 0, untracedPublished: 0, periodMismatchesPublished: 0 };
  if (last.kind === 'error') return { ...base, answer: 'error', modelDecision: null, reason: `${last.code}: ${last.message}`, timedOut: last.code === 'timeout' };
  const m = last.model;
  if (m.decision !== 'write') return { ...base, answer: m.decision, modelDecision: m.decision, reason: m.reason, timedOut: false };
  const { itemIds, signalIds } = loadedSourceIds(bundle);
  const untraced = [
    ...checkClaims(m.draft.claims, itemIds, signalIds),
    ...checkDraftNumbers(draftText(m.draft), canonicalizeNumberText(maskIgnoredSpans(allSourcesText(bundle)))),
  ];
  const periods = checkPeriods(m.draft, bundle);
  const failures = runWriteBar(m.draft, bundle);
  const published = failures.length === 0;
  return {
    ...base,
    answer: published ? 'write' : 'hold', modelDecision: 'write', reason: m.reason, timedOut: false, failures,
    untracedClaimsInDraft: untraced.length, periodMismatchesInDraft: periods.length,
    untracedPublished: published ? untraced.length : 0, periodMismatchesPublished: published ? periods.length : 0,
  };
}

// ---------- scoring ----------

export type Score =
  | { scored: false; why: string }
  | {
      scored: true; labelled: number; holdLabels: number; agreement: number; holdRecall: number | null; timeoutRate: number;
      untracedPublished: number; periodMismatchesPublished: number; untracedInDrafts: number; periodMismatchesInDrafts: number;
      bars: Array<{ name: string; value: string; need: string; pass: boolean }>; pass: boolean; warnings: string[];
    };

export function score(results: EntityResult[], labels: Labels): Score {
  const labelled = results.filter((r) => labels.byslug.has(r.slug));
  if (labelled.length === 0) {
    return { scored: false, why: `labels.csv has no labels (${labels.rows} rows, ${labels.blank} blank). Agreement and hold-recall need Bibhu's write/hold labels.` };
  }
  const predicted = (r: EntityResult): Label => (r.answer === 'write' ? 'write' : 'hold');
  const agree = labelled.filter((r) => predicted(r) === labels.byslug.get(r.slug)).length;
  const holds = labelled.filter((r) => labels.byslug.get(r.slug) === 'hold');
  const heldOk = holds.filter((r) => predicted(r) === 'hold').length;
  const timeouts = results.filter((r) => r.timedOut).length;
  const agreement = agree / labelled.length;
  const holdRecall = holds.length ? heldOk / holds.length : null;
  const timeoutRate = results.length ? timeouts / results.length : 0;
  const untracedPublished = results.reduce((n, r) => n + r.untracedPublished, 0);
  const periodPublished = results.reduce((n, r) => n + r.periodMismatchesPublished, 0);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const bars = [
    { name: 'untraced claims (published)', value: String(untracedPublished), need: '0', pass: untracedPublished === 0 },
    { name: 'period mismatches (published)', value: String(periodPublished), need: '0', pass: periodPublished === 0 },
    { name: 'agreement with labels', value: `${pct(agreement)} (${agree}/${labelled.length})`, need: '>= 80%', pass: agreement >= BARS.agreement },
    { name: 'hold-recall', value: holdRecall === null ? 'n/a (no hold labels)' : `${pct(holdRecall)} (${heldOk}/${holds.length})`, need: '>= 80%', pass: holdRecall !== null && holdRecall >= BARS.holdRecall },
    { name: 'timeouts after retry', value: `${pct(timeoutRate)} (${timeouts}/${results.length})`, need: '< 5%', pass: timeoutRate < BARS.timeoutRate },
  ];
  const warnings: string[] = [];
  if (holds.length < MIN_HOLD_LABELS) warnings.push(`only ${holds.length} hold labels; #629 asks for at least ${MIN_HOLD_LABELS}, so the hold-recall bar is weak`);
  if (labelled.length < results.length) warnings.push(`${results.length - labelled.length} entities have no label and are not in agreement or hold-recall`);
  return {
    scored: true, labelled: labelled.length, holdLabels: holds.length, agreement, holdRecall, timeoutRate,
    untracedPublished, periodMismatchesPublished: periodPublished,
    untracedInDrafts: results.reduce((n, r) => n + r.untracedClaimsInDraft, 0),
    periodMismatchesInDrafts: results.reduce((n, r) => n + r.periodMismatchesInDraft, 0),
    bars, pass: bars.every((b) => b.pass), warnings,
  };
}

export function formatReport(args: { entities: number; model: string | null; results: EntityResult[] | null; score: Score | null; labels: Labels; skippedWhy: string | null }): string {
  const out: string[] = [];
  out.push('latest-updates eval');
  out.push(`  frozen entities: ${args.entities}`);
  out.push(`  labels: ${args.labels.byslug.size} of ${args.labels.rows} filled`);
  if (!args.results) {
    out.push(`  model run: SKIPPED (${args.skippedWhy})`);
    out.push('');
    if (args.labels.byslug.size === 0) {
      out.push(`CANNOT SCORE: labels.csv has no labels (${args.labels.rows} rows, ${args.labels.blank} blank). Agreement and hold-recall need Bibhu's write/hold labels.`);
      out.push('  This is not a failure: fill labels.csv, set OLLAMA_API_KEY, and run again.');
    }
    out.push('RESULT: NOT SCORED (no model run)');
    return out.join('\n');
  } else {
    const r = args.results;
    const n = (f: (x: EntityResult) => boolean) => r.filter(f).length;
    out.push(`  model: ${args.model}   entities run: ${r.length}`);
    out.push(`  answers: published ${n((x) => x.answer === 'write')}, hold ${n((x) => x.answer === 'hold')}, skip ${n((x) => x.answer === 'skip')}, error after retry ${n((x) => x.answer === 'error')}`);
    out.push(`  model drafts the gate had to hold: untraced claims or numbers in ${n((x) => x.untracedClaimsInDraft > 0)}, period mismatches in ${n((x) => x.periodMismatchesInDraft > 0)}`);
    out.push(`  timeouts after retry: ${n((x) => x.timedOut)} of ${r.length}`);
  }
  if (args.score && !args.score.scored) {
    out.push('');
    out.push(`CANNOT SCORE: ${args.score.why}`);
    out.push('  Agreement and hold-recall are not computed. This is not a failure: fill labels.csv and run again.');
    out.push('RESULT: NOT SCORED');
  } else if (args.score?.scored) {
    const s = args.score;
    out.push('');
    out.push('  bar                              result                  need     pass');
    for (const b of s.bars) out.push(`  ${b.name.padEnd(32)} ${b.value.padEnd(23)} ${b.need.padEnd(8)} ${b.pass ? 'PASS' : 'FAIL'}`);
    for (const w of s.warnings) out.push(`  warning: ${w}`);
    out.push(`RESULT: ${s.pass ? 'PASS' : 'FAIL'}`);
  } else {
    out.push('');
    out.push('RESULT: NOT SCORED (no model run)');
  }
  return out.join('\n');
}
