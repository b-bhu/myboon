/**
 * #625 intake filter: a cheap, deterministic relevance and near-duplicate gate that runs on a claimed signal before the
 * analyst's LLM and deciders. No model, no network, no per-outlet rule. A signal is dropped (parked, never deleted) only when:
 *
 *   url_dup     its link is the same page as an earlier signal's link, apart from tracking parameters (utm_*, fbclid, ...)
 *   near_dup    its title is almost the same as an earlier signal's title (trigram Jaccard >= NEAR_DUP_JACCARD)
 *   same_event  its title adds nothing to an earlier one: >= SAME_EVENT_TOKEN_OVERLAP of ITS OWN words already appear in the
 *               earlier title (so a richer headline that merely contains an earlier short one is kept), at least
 *               SAME_EVENT_MIN_SHARED shared words, and at least one shared number
 *               of 3+ characters
 *   low_content its title is shorter than MIN_TITLE_CHARS characters once normalised (empty, symbols only, one short word)
 *
 * "Earlier" means a signal created in the 24 hours before this one that the filter itself did not drop. The thresholds were
 * chosen on the Nov 9-13 rows (see the #625 eval); decideIntake is pure so the same code runs in the eval and in the worker.
 */

export const NEAR_DUP_JACCARD = 0.6;
export const SAME_EVENT_TOKEN_OVERLAP = 0.7;
export const SAME_EVENT_MIN_SHARED = 4;
export const MIN_TITLE_CHARS = 12;
export const LOOKBACK_HOURS = 24;
/** parked_reason prefix for every signal this filter drops; the rule and the matched signal follow. */
export const INTAKE_FILTER_REASON_PREFIX = 'intake_filter:';

export type IntakeRule = 'url_dup' | 'near_dup' | 'same_event' | 'low_content';
export type IntakeSignal = { signal_id: string; text: string | null; link: string | null };
export type IntakeFeatures = { signal_id: string; url: string | null; chars: number; trigrams: Set<string>; tokens: Set<string>; numbers: Set<string> };
export type IntakeVerdict =
  | { keep: true }
  | { keep: false; rule: IntakeRule; match_signal_id: string | null; score: number | null };

const STOP_WORDS = new Set(
  'the and for with from that this its after over into new says say amid has have had are was were will been not but than then their there they them his her you your our out off all any can may could would should about more most also just who what when where which while'.split(' '),
);
const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|source$|cmpid$|igshid$)/i;

/** Same page apart from tracking parameters, fragment, scheme, www and a trailing slash. Null for no or an unparsable link. */
export function canonicalUrl(link: string | null | undefined): string | null {
  if (!link) return null;
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    return null;
  }
  for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.replace(/\/+$/, '');
  const q = u.searchParams.toString();
  return `${host}${path}${q ? `?${q}` : ''}`;
}

/** Lowercase, strip accents and an "OUTLET:" prefix, keep letters, digits and $ % . in any script. */
function normTitle(text: string | null): string {
  let t = (text ?? '').normalize('NFKD').replace(/\p{M}+/gu, '');
  t = t.replace(/^[A-Z][A-Z .]{2,19}: /, '').toLowerCase();
  return t.replace(/[^\p{L}\p{N}$%. ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function intakeFeatures(s: IntakeSignal): IntakeFeatures {
  const t = normTitle(s.text);
  const padded = ` ${t} `;
  const trigrams = new Set<string>();
  if (t) for (let i = 0; i + 3 <= padded.length; i++) trigrams.add(padded.slice(i, i + 3));
  const tokens = new Set((t.match(/[\p{L}\p{N}$%.]+/gu) ?? []).filter((w) => w.length > 2 && !STOP_WORDS.has(w)));
  // Numbers of 3+ characters only (73,000 / 1.2 / 409.7): a bare 50 or 6 is too common to show two headlines are the same event.
  const numbers = new Set(((s.text ?? '').match(/\d[\d,.]*\d/g) ?? []).filter((n) => n.length >= 3));
  return { signal_id: s.signal_id, url: canonicalUrl(s.link), chars: t.length, trigrams, tokens, numbers };
}

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};

/** How many of `own`'s words appear in `earlier`, and that as a share of `own`. */
function overlap(own: Set<string>, earlier: Set<string>): { shared: number; ratio: number } {
  if (own.size === 0 || earlier.size === 0) return { shared: 0, ratio: 0 };
  let shared = 0;
  for (const x of own) if (earlier.has(x)) shared++;
  return { shared, ratio: shared / own.size };
}

/** Decide one signal against the earlier kept signals (any order). Pure. */
export function decideIntake(sig: IntakeFeatures, earlier: Iterable<IntakeFeatures>): IntakeVerdict {
  if (sig.chars < MIN_TITLE_CHARS) {
    return { keep: false, rule: 'low_content', match_signal_id: null, score: null };
  }
  let near: { id: string; score: number } | null = null;
  let event: { id: string; score: number } | null = null;
  for (const e of earlier) {
    if (e.signal_id === sig.signal_id) continue;
    if (sig.url !== null && sig.url === e.url) return { keep: false, rule: 'url_dup', match_signal_id: e.signal_id, score: 1 };
    const j = jaccard(sig.trigrams, e.trigrams);
    if (j >= NEAR_DUP_JACCARD && (near === null || j > near.score)) near = { id: e.signal_id, score: j };
    if (event === null) {
      const o = overlap(sig.tokens, e.tokens);
      if (o.ratio >= SAME_EVENT_TOKEN_OVERLAP && o.shared >= SAME_EVENT_MIN_SHARED && [...sig.numbers].some((n) => e.numbers.has(n))) {
        event = { id: e.signal_id, score: o.ratio };
      }
    }
  }
  if (near) return { keep: false, rule: 'near_dup', match_signal_id: near.id, score: near.score };
  if (event) return { keep: false, rule: 'same_event', match_signal_id: event.id, score: event.score };
  return { keep: true };
}

export function intakeReason(v: Extract<IntakeVerdict, { keep: false }>): string {
  return `${INTAKE_FILTER_REASON_PREFIX}${v.rule}${v.match_signal_id ? `:${v.match_signal_id}` : ''}`;
}

/** Replay a time-ordered list through the filter exactly as the worker does: each signal is compared with the earlier kept ones in the last 24 h. */
export function replayIntake(rows: Array<IntakeSignal & { created_at: string }>): Array<{ row: IntakeSignal & { created_at: string }; verdict: IntakeVerdict }> {
  const kept: Array<{ at: number; f: IntakeFeatures }> = [];
  let from = 0;
  const out: Array<{ row: IntakeSignal & { created_at: string }; verdict: IntakeVerdict }> = [];
  for (const row of rows) {
    const at = Date.parse(row.created_at);
    while (from < kept.length && kept[from]!.at < at - LOOKBACK_HOURS * 3600_000) from++;
    const f = intakeFeatures(row);
    const verdict = decideIntake(f, kept.slice(from).map((k) => k.f));
    out.push({ row, verdict });
    if (verdict.keep) kept.push({ at, f });
  }
  return out;
}
