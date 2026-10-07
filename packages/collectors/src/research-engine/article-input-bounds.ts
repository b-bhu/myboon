/**
 * Input bounds shared by article placement and its Jev state projections.
 *
 * The source bound is an admission limit: callers keep the complete captured
 * text and hold when it is larger. It is never used to truncate the source.
 */
export const ARTICLE_DECISION_SOURCE_MAX_CHARS = 48_000

/** Candidate descriptions are context for placement, not durable profiles. */
export const ARTICLE_DECISION_CANDIDATE_SUMMARY_MAX_CHARS = 1_000

/** Keep the existing serialized-state guard explicit at every state assembly. */
export const ARTICLE_DECISION_STATE_MAX_BYTES = 96_000

/** Historical titles are a bounded Jev description, never a stored value. */
export const ARTICLE_HISTORY_TITLE_MAX_CHARS = 500
const ARTICLE_HISTORY_TITLE_EXCERPT_SUFFIX = ' [excerpted]'
const ARTICLE_HISTORY_TITLE_UNAVAILABLE = '[title unavailable]'

/** Preserve history identity while making missing and overlong titles explicit. */
export function articleHistoryDecisionTitle(title: string): string {
  if (!title.trim()) return ARTICLE_HISTORY_TITLE_UNAVAILABLE
  if (title.length <= ARTICLE_HISTORY_TITLE_MAX_CHARS) return title
  return `${title.slice(0, ARTICLE_HISTORY_TITLE_MAX_CHARS - ARTICLE_HISTORY_TITLE_EXCERPT_SUFFIX.length)}${ARTICLE_HISTORY_TITLE_EXCERPT_SUFFIX}`
}

/**
 * Project a profile summary into the bounded description sent to Jev.
 * Empty database summaries are absent context; long summaries carry an
 * explicit marker so the model is not given a misleading complete description.
 */
export function articleCandidateDecisionSummary(summary: string | null): string | null {
  if (summary === null) return null
  const text = summary.trim()
  if (!text) return null
  return text.length <= ARTICLE_DECISION_CANDIDATE_SUMMARY_MAX_CHARS
    ? text
    : `${text.slice(0, ARTICLE_DECISION_CANDIDATE_SUMMARY_MAX_CHARS - 14)} [excerpted]`
}
