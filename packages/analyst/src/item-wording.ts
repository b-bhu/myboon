/**
 * #559 entity item wording: titles and summaries give the reader the fact and why it matters,
 * never who reported it. The source link is stored separately (atlas.signals.link), so it is
 * never needed in the text. Pure functions; the prompt rule lives in session.ts.
 */

/** Target headline length the prompt asks for. Titles are never cut to fit it. */
export const HEADLINE_MAX_CHARS = 90;

/** Leading attribution clauses: "According to X, ...", "Per X, ...", "As reported by X, ...". */
const LEAD_IN = /^\s*(?:according to|per|as (?:reported|shared|posted) by|reported by|shared by|citing)\s+[^,:]{1,80}[,:]\s*/i;

/** Inline sharer/reporter clauses: ", shared by X," / "(reported by X)" / " via X". */
const INLINE = /\s*[,(]?\s*\b(?:shared|reported|posted) by\s+@?[\w.() -]{1,60}?(?=[,).]|$)[,)]?|\s+via\s+@?[\w.-]+(?=[\s,.]|$)/gi;

/** "X reports that ..." / "X reported ..." at the very start, only when followed by "that". */
const REPORTS_THAT = /^\s*[\w@.() -]{1,60}?\s+(?:reports?|reported|says|said)\s+that\s+/i;

/** Remove source lead-ins and sharer clauses, then re-capitalise. Never truncates. */
export function stripSourceAttribution(text: string): string {
  let out = text.trim();
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(LEAD_IN, '').replace(REPORTS_THAT, '');
    if (next === out) break;
    out = next;
  }
  out = out.replace(INLINE, '').replace(/\s{2,}/g, ' ').replace(/\s+([,.;:])/g, '$1').trim();
  return out.length > 0 ? out[0].toUpperCase() + out.slice(1) : out;
}

/** The first whole sentence of a text (never cut mid-sentence). */
function firstSentence(text: string): string {
  const m = text.match(/^.+?[.!?](?=\s|$)/);
  return (m ? m[0] : text).trim();
}

/**
 * The item title: the LLM headline, or (when missing) the summary's first whole sentence, with
 * source attribution stripped. Never sliced, so it never stops mid-word or mid-sentence.
 */
export function itemTitle(headline: string | undefined, summary: string, note: string): string {
  const pick = headline?.trim() || firstSentence(summary) || firstSentence(note);
  return stripSourceAttribution(pick);
}

/**
 * The item summary: the signal summary without attribution. It differs from the note (#559);
 * when the LLM summary equals the note, store an empty summary rather than a copy.
 */
export function itemSummary(summary: string, note: string): string {
  const s = stripSourceAttribution(summary);
  return s === note.trim() ? '' : s;
}
