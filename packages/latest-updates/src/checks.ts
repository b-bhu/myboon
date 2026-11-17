/**
 * The write bar, enforced in code (#623 decision 5). All four must hold, otherwise the draft is a hold:
 *   (a) novelty    what_happened holds a number, date or named actor that is in the NEW items and is absent
 *                  from the last update's text (a cheap backstop for the model's own judgement)
 *   (b) trace      every claim cites a supplied item or origin signal, and every number in the draft appears
 *                  in a supplied source (the #612 check, kept)
 *   (c) watch      what_to_watch names a concrete date, price level or decision
 *   (d) period     see periods.ts
 *   (e) repeat_previous  how_we_got_here and what_to_watch are not near-repeats of our last card's (#671)
 *   (f) stale_timeframe  see timeframe.ts (#671)
 * Bar (c) also holds a watch line whose concrete date, level, decision or fact is not in the new items or their
 * origin signals (same check name, #671).
 * The model never gets to waive a check. The matching is heuristic by design; the eval set tests it.
 */
import { checkPeriods } from './periods.js';
import { checkStaleTimeframe } from './timeframe.js';
import type { Bundle, CheckFailure, Claim, Draft } from './types.js';
import { allSourcesText, canonicalizeNumberText, draftText, extractNumericTokens, maskIgnoredSpans, MONTH_WORDS, newSourcesText } from './text.js';

// ---------- (a) novelty ----------

const STOP_ACTORS = new Set([
  'the', 'and', 'but', 'for', 'with', 'from', 'after', 'before', 'while', 'when', 'where', 'this', 'that', 'these', 'those', 'its', 'his', 'her', 'their',
  'new', 'one', 'two', 'three', 'now', 'also', 'still', 'more', 'most', 'some', 'many', 'last', 'next', 'over', 'into', 'than', 'then', 'have', 'has',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'note', 'reason', 'reported', 'per', 'any', 'all', 'not', 'who', 'what',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);
const DATE_PATTERNS = [
  new RegExp(`\\b(${MONTH_WORDS})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi'),
  new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_WORDS})\\b`, 'gi'),
];
const monthKey = (word: string) => word.toLowerCase().replace(/\./g, '').slice(0, 3);

/** Facts of one kind-prefixed key each: numbers (n:), calendar dates (d:) and named actors (a:). */
export function factKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const token of extractNumericTokens(text)) keys.add(`n:${token.startsWith('$') ? token.slice(1) : token}`);
  for (const iso of text.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) keys.add(`d:${iso[1]}`);
  for (const m of text.matchAll(DATE_PATTERNS[0]!)) keys.add(`d:${monthKey(m[1]!)}-${Number(m[2])}`);
  for (const m of text.matchAll(DATE_PATTERNS[1]!)) keys.add(`d:${monthKey(m[2]!)}-${Number(m[1])}`);
  // Named actors: capitalised words in the middle of a sentence, and ALL-CAPS tickers or acronyms anywhere.
  const stripped = maskIgnoredSpans(text).replace(/https?:\/\/\S+/g, ' ');
  for (const m of stripped.matchAll(/\b([A-Z][A-Za-z0-9&'-]*)\b/g)) {
    const word = m[1]!;
    const sentenceStart = /(?:^|[.!?:;]\s*|\n\s*)$/.test(stripped.slice(0, m.index ?? 0));
    const allCaps = /^[A-Z0-9&]{2,}$/.test(word) && /[A-Z]/.test(word);
    if (word.length < 3 && !allCaps) continue;
    const lower = word.toLowerCase();
    if (STOP_ACTORS.has(lower)) continue;
    if (sentenceStart && !allCaps) continue;
    keys.add(`a:${lower}`);
  }
  return keys;
}

export function checkNovelty(draft: Draft, bundle: Bundle): CheckFailure[] {
  const inDraft = factKeys(draft.what_happened);
  const inNew = factKeys(newSourcesText(bundle));
  const inLast = bundle.last_update ? factKeys(bundle.last_update.text) : new Set<string>();
  const added = [...inDraft].filter((k) => inNew.has(k) && !inLast.has(k));
  if (added.length > 0) return [];
  return [{ check: 'novelty', detail: 'what_happened has no number, date or named actor from the new items that the last update lacks' }];
}

// ---------- (b) trace ----------

export function loadedSourceIds(bundle: Bundle): { itemIds: Set<string>; signalIds: Set<string> } {
  const itemIds = new Set<string>();
  const signalIds = new Set<string>();
  for (const item of [...bundle.new_items, ...bundle.prior_items]) {
    itemIds.add(item.id);
    if (item.signal_id) signalIds.add(item.signal_id);
  }
  for (const signal of bundle.origin_signals) signalIds.add(signal.signal_id);
  return { itemIds, signalIds };
}

export function checkClaims(claims: Claim[], itemIds: Set<string>, signalIds: Set<string>): CheckFailure[] {
  if (claims.length === 0) return [{ check: 'claims', detail: 'write draft has no claims' }];
  const failures: CheckFailure[] = [];
  claims.forEach((claim, index) => {
    const label = claim.text.trim() || `claim ${index + 1}`;
    if (!claim.source_item_id && !claim.source_signal_id) {
      failures.push({ check: 'claims', detail: `"${label}" cites no source item or signal` });
      return;
    }
    if (claim.source_item_id && !itemIds.has(claim.source_item_id)) failures.push({ check: 'claims', detail: `"${label}" cites unknown source_item_id` });
    if (claim.source_signal_id && !signalIds.has(claim.source_signal_id)) failures.push({ check: 'claims', detail: `"${label}" cites unknown source_signal_id` });
  });
  return failures;
}

export function checkDraftNumbers(text: string, corpus: string): CheckFailure[] {
  const failures: CheckFailure[] = [];
  for (const token of extractNumericTokens(text)) {
    const bare = token.startsWith('$') ? token.slice(1) : token;
    if (corpus.includes(token) || (bare && corpus.includes(bare))) continue;
    failures.push({ check: 'numbers', detail: `number ${token} is not in the items or their origin signals` });
  }
  return failures;
}

// ---------- (c) what_to_watch ----------

const WATCH_DATE_RES = [
  new RegExp(`\\b(?:${MONTH_WORDS})\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, 'i'),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTH_WORDS})\\b`, 'i'),
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/,
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/,
  /\b(?:Q[1-4]|H[12]|FY\s?\d{2,4})\b/,
  /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/,
];
const WATCH_LEVEL_RES = [
  /\$\s?\d/,
  /\b\d[\d,]*(?:\.\d+)?\s?(?:k|m|bn|b)\b/i,
  /\b\d{1,3}(?:,\d{3})+\b/,
  /\b(?!(?:19|20)\d{2}\b)\d{4,}\b/,
  /\b\d+(?:\.\d+)?\s?%/,
];
const WATCH_DECISION_RE = /\b(?:decision|vote|ruling|verdict|approval|deadline|hearing|meeting|FOMC|earnings|auction|election|summit|expir(?:y|es|ation)|launch|filing)\b/i;

export function checkWatch(draft: Draft): CheckFailure[] {
  const text = draft.what_to_watch;
  if (WATCH_DATE_RES.some((re) => re.test(text)) || WATCH_LEVEL_RES.some((re) => re.test(text)) || WATCH_DECISION_RE.test(text)) return [];
  return [{ check: 'watch', detail: 'what_to_watch names no concrete date, price level or decision' }];
}

/** Lowercased decision words in a text, keyed like factKeys so they can be compared with the new sources. */
function decisionKeys(text: string): Set<string> {
  return new Set([...text.matchAll(new RegExp(WATCH_DECISION_RE.source, 'gi'))].map((m) => `k:${m[0].toLowerCase()}`));
}
const WEEKDAY_RE = /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/gi;
function weekdayKeys(text: string): Set<string> {
  return new Set([...text.matchAll(WEEKDAY_RE)].map((m) => `w:${m[1]!.toLowerCase()}`));
}
/** The concrete things a line names: numbers, dates, actors, weekdays and decision words. */
const concreteKeys = (text: string): Set<string> => new Set([...factKeys(text), ...weekdayKeys(text), ...decisionKeys(text)]);

/**
 * The watch line must be about the new news: at least one of its concrete keys appears in the new items or their
 * origin signals. The entity's own name does not count (it is in every item).
 */
export function checkWatchTied(draft: Draft, bundle: Bundle): CheckFailure[] {
  const entityKeys = new Set([...bundle.entity.name.split(/\s+/), ...bundle.entity.slug.split(/[-_\s]+/)].map((w) => `a:${w.toLowerCase()}`));
  const inNew = concreteKeys(newSourcesText(bundle));
  const tied = [...concreteKeys(draft.what_to_watch)].some((k) => !entityKeys.has(k) && inNew.has(k));
  if (tied) return [];
  return [{ check: 'watch', detail: 'what_to_watch names no date, level or decision from the new items or their origin signals' }];
}

// ---------- (e) repeat_previous ----------

export const REPEAT_JACCARD = 0.7;
const REPEAT_MIN_WORDS = 8;
const REPEAT_MIN_CHARS = 40;

const repeatTokens = (text: string): string[] =>
  text.toLowerCase().split(/\s+/).map((t) => t.replace(/^[^\p{L}\p{N}$]+|[^\p{L}\p{N}%]+$/gu, '')).filter(Boolean);

/** Near-repeat: one line contains the other (8+ words or 40+ chars), or word Jaccard (stop words out) >= 0.7. */
export function isNearRepeat(draftLine: string, lastLine: string, bundle: Bundle): boolean {
  const a = repeatTokens(draftLine);
  const b = repeatTokens(lastLine);
  if (a.length === 0 || b.length === 0) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const shortText = short.join(' ');
  if ((short.length >= REPEAT_MIN_WORDS || shortText.length >= REPEAT_MIN_CHARS) && ` ${long.join(' ')} `.includes(` ${shortText} `)) return true;
  const sa = new Set(a.filter((t) => !STOP_ACTORS.has(t)));
  const sb = new Set(b.filter((t) => !STOP_ACTORS.has(t)));
  const union = new Set([...sa, ...sb]).size;
  if (union === 0 || [...sa].filter((t) => sb.has(t)).length / union < REPEAT_JACCARD) return false;
  // A reused phrase that adds a new date, level or decision from the new items is not a repeat.
  const inNew = concreteKeys(newSourcesText(bundle));
  const inLast = concreteKeys(lastLine);
  const adds = [...concreteKeys(draftLine)].some((k) => /^[ndk]:/.test(k) && inNew.has(k) && !inLast.has(k));
  return !adds;
}

export function checkRepeatPrevious(draft: Draft, bundle: Bundle): CheckFailure[] {
  const last = bundle.last_update;
  if (!last || last.kind !== 'published') return [];
  const failures: CheckFailure[] = [];
  if (isNearRepeat(draft.how_we_got_here, last.card.how_we_got_here, bundle)) {
    failures.push({ check: 'repeat_previous', detail: 'how_we_got_here repeats the last card' });
  }
  if (isNearRepeat(draft.what_to_watch, last.card.what_to_watch, bundle)) {
    failures.push({ check: 'repeat_previous', detail: 'what_to_watch repeats the last card' });
  }
  return failures;
}

// ---------- all of them ----------

/** The failures of the whole write bar; empty means the draft may be published. */
export function runWriteBar(draft: Draft, bundle: Bundle): CheckFailure[] {
  const { itemIds, signalIds } = loadedSourceIds(bundle);
  const watch = checkWatch(draft);
  return [
    ...checkNovelty(draft, bundle),
    ...checkClaims(draft.claims, itemIds, signalIds),
    ...checkDraftNumbers(draftText(draft), canonicalizeNumberText(maskIgnoredSpans(allSourcesText(bundle)))),
    ...(watch.length > 0 ? watch : checkWatchTied(draft, bundle)),
    ...checkPeriods(draft, bundle),
    ...checkRepeatPrevious(draft, bundle),
    ...checkStaleTimeframe(draft, bundle),
  ];
}
