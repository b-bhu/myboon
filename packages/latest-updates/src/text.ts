/**
 * Text helpers for the write-bar checks. The number handling is the #612 proof-of-concept check, kept as it
 * was (copied, so this package does not depend on @myboon/collectors).
 */
import type { Bundle, Draft, Item, Signal } from './types.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_DATE_RE = /\d{4}-\d{2}-\d{2}(?:[tT ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|Z|[+-]\d{2}:?\d{2})?)?/g;
const NUMERIC_DATE_RE = /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g;
export const MONTH_WORDS = 'jan(?:uary|\\.)?|feb(?:ruary|\\.)?|mar(?:ch|\\.)?|apr(?:il|\\.)?|may\\.?|jun(?:e|\\.)?|jul(?:y|\\.)?|aug(?:ust|\\.)?|sep(?:t(?:ember)?|\\.)?|oct(?:ober|\\.)?|nov(?:ember|\\.)?|dec(?:ember|\\.)?';
const MONTH_DATE_RE = new RegExp(`\\b(?:${MONTH_WORDS})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s*\\d{4})?\\b`, 'gi');
const DAY_MONTH_RE = new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTH_WORDS})(?:,?\\s*\\d{4})?\\b`, 'gi');
const TIME_RE = /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:am|pm))?\b/gi;
const YEAR_RE = /\b(?:19|20)\d{2}\b/g;
const HEX_ID_RE = /\b[0-9a-f]{16,}\b/gi;
const URL_RE = /https?:\/\/\S+/gi;
const NUMBER_TOKEN_RE = /(?:\$|usd\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s*(?:[kmb]|thousand|million|billion))?(?:\s*%)?/gi;

/** Mask ids, URLs and dates so they are not treated as invented numbers. */
export function maskIgnoredSpans(text: string): string {
  return text
    .replace(URL_RE, ' ')
    .replace(UUID_RE, ' ')
    .replace(ISO_DATE_RE, ' ')
    .replace(NUMERIC_DATE_RE, ' ')
    .replace(MONTH_DATE_RE, ' ')
    .replace(DAY_MONTH_RE, ' ')
    .replace(TIME_RE, ' ')
    .replace(HEX_ID_RE, ' ')
    .replace(YEAR_RE, ' ');
}

/** Canonical form: lowercase, no thousands separators, k/m/b suffixes, no spaces. */
export function canonicalizeNumberText(text: string): string {
  return text
    .toLowerCase()
    .replace(/usd\s*/g, '$')
    .replace(/,/g, '')
    .replace(/\bthousand\b/g, 'k')
    .replace(/\bmillion\b/g, 'm')
    .replace(/\bbillion\b/g, 'b')
    .replace(/\s+/g, '');
}

export function extractNumericTokens(text: string): string[] {
  const masked = maskIgnoredSpans(text);
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of masked.matchAll(NUMBER_TOKEN_RE)) {
    const token = canonicalizeNumberText(match[0] ?? '');
    if (!token || token === '$' || seen.has(token)) continue;
    seen.add(token);
    found.push(token);
  }
  return found;
}

export const itemText = (item: Item): string => [item.title, item.summary ?? '', item.note ?? ''].join('\n');

export function signalText(signal: Signal): string {
  return [signal.text ?? '', signal.excerpt ?? '', signal.numbers == null ? '' : JSON.stringify(signal.numbers)].join('\n');
}

export function draftText(draft: Draft): string {
  return [draft.title, draft.what_happened, draft.how_we_got_here, draft.what_to_watch].join('\n');
}

/** Everything the model was shown about the new news: new items and their origin signals. */
export function newSourcesText(bundle: Bundle): string {
  const newSignalIds = new Set(bundle.new_items.map((i) => i.signal_id).filter((s): s is string => s !== null));
  return [
    ...bundle.new_items.map(itemText),
    ...bundle.origin_signals.filter((s) => newSignalIds.has(s.signal_id)).map(signalText),
  ].join('\n');
}

/** Everything supplied (new, earlier, signals, the last update): the corpus a draft number must come from. */
export function allSourcesText(bundle: Bundle): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const item of [...bundle.new_items, ...bundle.prior_items]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    parts.push(itemText(item));
  }
  for (const signal of bundle.origin_signals) parts.push(signalText(signal));
  if (bundle.last_update) parts.push(bundle.last_update.text);
  return parts.join('\n');
}

export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}
