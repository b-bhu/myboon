/**
 * Write bar (d), period consistency. Period tokens are found in CODE, not by the model. Patterns (#623):
 *   - month names, full and 3-letter (Sept too), with an optional year          "September CPI", "Oct 2026"
 *   - Q1 to Q4, optional year                                                    "Q3", "Q3 2026"
 *   - H1 / H2, optional year                                                     "H2 2026"
 *   - FY, two or four digit year                                                 "FY25", "FY2026"
 * A month that is part of a calendar date ("Dec 10", "10 December") is a date, not a period, and is ignored
 * here (bar (c) wants a date in what_to_watch). "May" counts as a month only after a preposition or before a
 * year, so the verb "may" and a sentence-initial "May" do not.
 *
 * The check holds a draft when:
 *   1. a period it names is not named by any supplied source (new items, earlier items, signals, last update);
 *   2. the new sources (new items and their signals) give different periods for one indicator the draft
 *      mentions ("September CPI" in one, "October CPI" in another);
 *   3. the draft pairs a period with an indicator ("September CPI") and the new sources name that indicator
 *      only with other periods.
 * A period that the sources confirm, even when the release came later ("September CPI, released in
 * October"), is not held. The draft's what_to_watch is out of scope for this check: it names the future, and
 * bar (c) covers it. Heuristic; the eval set is where it is tested.
 */
import type { Bundle, CheckFailure, Draft } from './types.js';
import { itemText, newSourcesText, signalText } from './text.js';

export type PeriodKind = 'month' | 'quarter' | 'half' | 'fy';
export type Period = { kind: PeriodKind; n: number; year: number | null; label: string; indicator: string | null };

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ABBR: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_TOKEN = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec';
const MONTH_RE = new RegExp(`\\b(${MONTH_TOKEN})\\b\\.?(?:,?\\s+((?:19|20)\\d{2})\\b)?`, 'g');
const QUARTER_RE = /\bQ([1-4])\b(?:[\s,]+((?:19|20)\d{2})\b)?/g;
const HALF_RE = /\bH([12])\b(?:[\s,]+((?:19|20)\d{2})\b)?/g;
const FY_RE = /\bFY\s?((?:20)?\d{2})\b/g;
const MAY_PREPOSITION_RE = /\b(?:in|of|for|since|until|through|by|from|during|last|next|this|early|late|mid)\s+$/i;
const INDICATOR_RE = /^\s+(?:(?:U\.S\.|US|UK|EU|core|headline|monthly|annual)\s+)*(CPI|PPI|PCE|GDP|NFP|PMI|ISM|JOLTS|[A-Z]{2,6}|inflation|jobs|payrolls|employment|unemployment|earnings|revenue|sales|results|guidance|report|data|print|figures)\b/;

const monthNumber = (word: string): number => {
  const lower = word.toLowerCase();
  const full = MONTH_NAMES.indexOf(lower);
  return full >= 0 ? full + 1 : (MONTH_ABBR[lower] ?? 0);
};

function indicatorAfter(text: string, end: number): string | null {
  const m = INDICATOR_RE.exec(text.slice(end, end + 40));
  return m ? m[1]!.toLowerCase() : null;
}

/** Is the month at [start, end) part of a calendar date? "Dec 10", "December 10th", "10 December". */
function isCalendarDate(text: string, start: number, end: number): boolean {
  if (/^\s+\d{1,2}(?:st|nd|rd|th)?(?!\d)/.test(text.slice(end, end + 8))) return true;
  return /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?$/.test(text.slice(Math.max(0, start - 12), start));
}

/** All periods named in `text`. Months that are plain calendar dates are skipped. */
export function extractPeriods(text: string): Period[] {
  const out: Period[] = [];
  for (const m of text.matchAll(MONTH_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const word = m[1]!;
    if (isCalendarDate(text, start, start + word.length + (text[start + word.length] === '.' ? 1 : 0))) continue;
    if (word === 'May' && !m[2] && !MAY_PREPOSITION_RE.test(text.slice(Math.max(0, start - 12), start)) && indicatorAfter(text, end) === null) continue;
    out.push({ kind: 'month', n: monthNumber(word), year: m[2] ? Number(m[2]) : null, label: m[0].trim(), indicator: indicatorAfter(text, end) });
  }
  for (const m of text.matchAll(QUARTER_RE)) {
    out.push({ kind: 'quarter', n: Number(m[1]), year: m[2] ? Number(m[2]) : null, label: m[0].trim(), indicator: indicatorAfter(text, (m.index ?? 0) + m[0].length) });
  }
  for (const m of text.matchAll(HALF_RE)) {
    out.push({ kind: 'half', n: Number(m[1]), year: m[2] ? Number(m[2]) : null, label: m[0].trim(), indicator: indicatorAfter(text, (m.index ?? 0) + m[0].length) });
  }
  for (const m of text.matchAll(FY_RE)) {
    const digits = m[1]!;
    out.push({ kind: 'fy', n: 0, year: digits.length === 2 ? 2000 + Number(digits) : Number(digits), label: m[0].trim(), indicator: indicatorAfter(text, (m.index ?? 0) + m[0].length) });
  }
  return out;
}

/** Months named anywhere, dates included: a source that says "September 12" does name September. */
function monthMentions(text: string): Array<{ n: number; year: number | null }> {
  const out: Array<{ n: number; year: number | null }> = [];
  for (const m of text.matchAll(MONTH_RE)) {
    const start = m.index ?? 0;
    const word = m[1]!;
    if (word === 'May' && !m[2] && !MAY_PREPOSITION_RE.test(text.slice(Math.max(0, start - 12), start)) && !/^\s+\d{1,2}\b/.test(text.slice(start + 3, start + 8))) continue;
    out.push({ n: monthNumber(word), year: m[2] ? Number(m[2]) : null });
  }
  return out;
}

const yearsAgree = (a: number | null, b: number | null) => a === null || b === null || a === b;
const sameKind = (a: Period, b: Period) => a.kind === b.kind && a.n === b.n && yearsAgree(a.year, b.year);
const periodKey = (p: Period) => `${p.kind}:${p.n}`;
const periodName = (p: Period) => (p.kind === 'month' ? (MONTH_NAMES[p.n - 1] ?? p.label) : p.label.toLowerCase().replace(/\s+/g, ' '));

function namedBySources(period: Period, sourcesText: string): boolean {
  if (period.kind === 'month') {
    return monthMentions(sourcesText).some((m) => m.n === period.n && yearsAgree(period.year, m.year));
  }
  return extractPeriods(sourcesText).some((s) => sameKind(period, s));
}

export function checkPeriods(draft: Draft, bundle: Bundle): CheckFailure[] {
  const failures: CheckFailure[] = [];
  const draftBackward = [draft.title, draft.what_happened, draft.how_we_got_here].join('\n');
  const draftPeriods = extractPeriods(draftBackward);

  const supplied = [
    ...bundle.new_items.map(itemText),
    ...bundle.prior_items.map(itemText),
    ...bundle.origin_signals.map(signalText),
    ...(bundle.last_update ? [bundle.last_update.text] : []),
  ].join('\n');

  // 1. A period the draft names must be named by a supplied source.
  const seen = new Set<string>();
  for (const p of draftPeriods) {
    const key = `${periodKey(p)}:${p.year ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!namedBySources(p, supplied)) {
      failures.push({ check: 'period', detail: `the draft names ${p.label}, which no supplied source names` });
    }
  }

  // 2 and 3: indicator-level agreement within the NEW sources (new items and their signals).
  const newPeriods = extractPeriods(newSourcesText(bundle));
  const byIndicator = new Map<string, Period[]>();
  for (const p of newPeriods) {
    if (!p.indicator) continue;
    const list = byIndicator.get(p.indicator) ?? [];
    list.push(p);
    byIndicator.set(p.indicator, list);
  }
  const lowerDraft = draftBackward.toLowerCase();
  for (const [indicator, list] of byIndicator) {
    const distinct = new Map<string, Period>();
    for (const p of list) distinct.set(periodKey(p), p);
    if (distinct.size > 1 && lowerDraft.includes(indicator)) {
      failures.push({ check: 'period', detail: `the new sources give different periods for ${indicator.toUpperCase()}: ${[...distinct.values()].map(periodName).join(' vs ')}` });
    }
  }
  const reportedMismatch = new Set<string>();
  for (const p of draftPeriods) {
    if (!p.indicator) continue;
    const sources = byIndicator.get(p.indicator);
    if (!sources || sources.some((s) => sameKind(p, s))) continue;
    const key = `${periodKey(p)}:${p.indicator}`;
    if (reportedMismatch.has(key)) continue;
    reportedMismatch.add(key);
    failures.push({ check: 'period', detail: `the draft says ${p.label}, but the new sources name ${p.indicator.toUpperCase()} only for ${[...new Set(sources.map(periodName))].join(', ')}` });
  }
  return failures;
}
