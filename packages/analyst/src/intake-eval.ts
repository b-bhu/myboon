/**
 * #625 eval of the intake filter on stored rows, read-only. Replays the signals through the same code the worker runs
 * (replayIntake) and reports, per IST day: rows, dropped by rule, kept, and what would still reach the entity manager.
 *
 * Inputs are the raw outputs of the read-only Atlas helper, in one directory:
 *   sig_*.json    atlas signals --since <ISO> --until <ISO> --limit 200 --all
 *   dec_*.json    atlas analyst --since <ISO> --until <ISO> --limit 200 --all
 *   items_a.json  atlas entity-items --since <ISO> --limit 200 --all
 *
 *   npx tsx src/intake-eval.ts <dir> [--story-cutoff 2026-11-10T14:30:00Z]
 *
 * "Reaching the entity manager" = analyst keep with an entity (what the entity manager claims once #621 is on). Rows created
 * after --story-cutoff have not been finished by the entity manager yet, so "became a story" is only judged before it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { replayIntake, type IntakeRule } from './intake-filter.js';

type Sig = { signal_id: string; text: string | null; link: string | null; created_at: string };
type Dec = { signal_id: string; decision: string; targets?: Array<{ entity?: string }> | null };

const dir = process.argv[2];
if (!dir) { console.error('usage: tsx src/intake-eval.ts <dir> [--story-cutoff ISO]'); process.exit(2); }
const ci = process.argv.indexOf('--story-cutoff');
const cutoff = Date.parse(ci > 0 ? process.argv[ci + 1]! : '2026-11-10T14:30:00Z');

const files = (re: RegExp) => readdirSync(dir).filter((f) => re.test(f)).sort();
const pages = (f: string): Array<Record<string, unknown>> => { const j = JSON.parse(readFileSync(join(dir, f), 'utf8')); return Array.isArray(j) ? j : [j]; };

const sigs = new Map<string, Sig>();
for (const f of files(/^sig_.*\.json$/)) for (const p of pages(f)) for (const s of p.signals as Sig[]) sigs.set(s.signal_id, s);
const decs = new Map<string, Dec>();
for (const f of files(/^dec_.*\.json$/)) for (const p of pages(f)) for (const d of p.decisions as Dec[]) decs.set(d.signal_id, d);
const storySignals = new Set<string>();
for (const f of files(/^items_.*\.json$/)) for (const p of pages(f)) for (const i of p.items as Array<{ signal_id: string }>) storySignals.add(i.signal_id);

const rows = [...sigs.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.signal_id.localeCompare(b.signal_id));
const replay = replayIntake(rows);

const ist = (iso: string) => new Date(Date.parse(iso) + 5.5 * 3600_000).toISOString().slice(0, 10);
const label = (s: Sig): string => {
  if (Date.parse(s.created_at) >= cutoff) return 'not yet finished by the entity manager';
  if (storySignals.has(s.signal_id)) return 'became a story';
  const d = decs.get(s.signal_id);
  if (!d) return 'no decision';
  if (d.decision === 'ignore') return 'analyst ignore';
  return d.targets?.[0]?.entity ? 'keep with entity, no story (parked or duplicate)' : 'keep, no entity';
};
const hasEntity = (id: string) => { const d = decs.get(id); return d?.decision === 'keep' && !!d.targets?.[0]?.entity; };
const isKeep = (id: string) => decs.get(id)?.decision === 'keep';

type Day = { rows: number; kept: number; byRule: Record<IntakeRule, number>; keepBase: number; keepAfter: number; emBase: number; emAfter: number };
const days = new Map<string, Day>();
const zero = (): Day => ({ rows: 0, kept: 0, byRule: { url_dup: 0, near_dup: 0, same_event: 0, low_content: 0 }, keepBase: 0, keepAfter: 0, emBase: 0, emAfter: 0 });
for (const { row, verdict } of replay) {
  const d = days.get(ist(row.created_at)) ?? zero();
  days.set(ist(row.created_at), d);
  d.rows++;
  if (verdict.keep) d.kept++; else d.byRule[verdict.rule]++;
  if (isKeep(row.signal_id)) { d.keepBase++; if (verdict.keep) d.keepAfter++; }
  if (hasEntity(row.signal_id)) { d.emBase++; if (verdict.keep) d.emAfter++; }
}

const out: string[] = [];
out.push('| IST day | signals | kept | dropped | url_dup | near_dup | same_event | low_content | to analyst-kept now -> after | to entity manager (keep with entity) now -> after |');
out.push('|---|---|---|---|---|---|---|---|---|---|');
const tot = zero();
for (const [day, d] of [...days].sort()) {
  out.push(`| ${day} | ${d.rows} | ${d.kept} | ${d.rows - d.kept} | ${d.byRule.url_dup} | ${d.byRule.near_dup} | ${d.byRule.same_event} | ${d.byRule.low_content} | ${d.keepBase} -> ${d.keepAfter} | ${d.emBase} -> ${d.emAfter} |`);
  tot.rows += d.rows; tot.kept += d.kept; tot.keepBase += d.keepBase; tot.keepAfter += d.keepAfter; tot.emBase += d.emBase; tot.emAfter += d.emAfter;
  for (const r of Object.keys(d.byRule) as IntakeRule[]) tot.byRule[r] += d.byRule[r];
}
const n = days.size;
out.push(`| total / ${n}-day average | ${tot.rows} / ${(tot.rows / n).toFixed(0)} | ${tot.kept} / ${(tot.kept / n).toFixed(0)} | ${tot.rows - tot.kept} / ${((tot.rows - tot.kept) / n).toFixed(0)} | ${tot.byRule.url_dup} | ${tot.byRule.near_dup} | ${tot.byRule.same_event} | ${tot.byRule.low_content} | ${(tot.keepBase / n).toFixed(0)} -> ${(tot.keepAfter / n).toFixed(0)} | ${(tot.emBase / n).toFixed(0)} -> ${(tot.emAfter / n).toFixed(0)} |`);

const finished = replay.filter((r) => Date.parse(r.row.created_at) < cutoff);
const stories = finished.filter((r) => storySignals.has(r.row.signal_id));
const storyDrops = stories.filter((r) => !r.verdict.keep);
const dropped = replay.filter((r) => !r.verdict.keep);
const byLabel = new Map<string, number>();
for (const r of finished.filter((x) => !x.verdict.keep)) byLabel.set(label(r.row), (byLabel.get(label(r.row)) ?? 0) + 1);

console.log(out.join('\n'));
console.log(`\nSignals ${replay.length}, dropped ${dropped.length} (${((100 * dropped.length) / replay.length).toFixed(1)}%).`);
console.log(`Finished-by-entity-manager window (created before ${new Date(cutoff).toISOString()}): ${finished.length} signals, ${stories.length} became stories, ${storyDrops.length} of those would be dropped (${((100 * storyDrops.length) / Math.max(1, stories.length)).toFixed(1)}%).`);
console.log(`Dropped in that window by outcome: ${[...byLabel].map(([k, v]) => `${k}: ${v}`).join('; ')}`);

const short = (s: string | null, n = 110) => (s ?? '').replace(/\s+/g, ' ').slice(0, n);
const line = (r: (typeof replay)[number]) => {
  const v = r.verdict;
  const m = !v.keep && v.match_signal_id ? sigs.get(v.match_signal_id) : undefined;
  return `- [${v.keep ? 'keep' : v.rule}${!v.keep && v.score != null ? ` ${v.score.toFixed(2)}` : ''}] "${short(r.row.text)}" (${label(r.row)})${m ? `\n    matched earlier: "${short(m.text)}"` : ''}`;
};
const h = (id: string) => createHash('sha256').update(id).digest('hex');
console.log('\n## Sample of 30 drops (deterministic: first 30 by sha256 of signal_id)');
for (const r of [...dropped].sort((a, b) => h(a.row.signal_id).localeCompare(h(b.row.signal_id))).slice(0, 30)) console.log(line(r));
console.log(`\n## Drops that became stories (false drops): ${storyDrops.length}`);
for (const r of storyDrops) console.log(line(r));
