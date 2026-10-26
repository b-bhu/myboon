/**
 * Map one normalized tokens.xyz feed item (@myboon/shared/news-feed) to a V4
 * Signal, validated with `parseSignal` before it leaves this function.
 *
 * Signal validity rules live in @myboon/contracts (`signalSchema`); this
 * module therefore throws (usually ZodError) for an item that cannot become a
 * valid signal — e.g. a URL that is not a valid absolute URL. The scout counts
 * such items as invalid and skips them; it never writes a half-formed signal.
 */
import {
  SIGNAL_SCHEMA_VERSION,
  parseSignal,
  rawHash,
  signalId,
  type Signal,
} from '@myboon/contracts';
import type { NewsFeedItem } from '@myboon/shared/news-feed';

/** Signal `source` for everything this scout writes. */
export const NEWS_SIGNAL_SOURCE = 'tokens_xyz';

/**
 * The schema caps `excerpt` at 500 chars and atlas.signals checks
 * `char_length(excerpt) <= 500` (code points). A UTF-16-unit slice of 500
 * never exceeds 500 code points, so truncating by string length is safe.
 */
const EXCERPT_MAX_CHARS = 500;

function truncateExcerpt(text: string): string {
  return text.length > EXCERPT_MAX_CHARS ? text.slice(0, EXCERPT_MAX_CHARS) : text;
}

/**
 * `feed_item -> Signal`:
 * - source/source_id: 'tokens_xyz' / item.url (the dedupe key is in the DB)
 * - type: article -> 'news', post -> 'post'; numbers always {}
 * - text: article title / post text; excerpt is the same text truncated to 500
 * - occurred_at: publishedAt (article) / postedAt (post), null when upstream
 *   had none; fetched_at: the moment the feed was fetched
 * - raw_ids: only non-empty members ({ coingecko: comma-joined ids, plus
 *   { outlet } or { handle } when present)
 * - raw_hash: sha256 of the upstream item as delivered (unchanged JSON)
 */
export function feedItemToSignal(item: NewsFeedItem, fetchedAt: Date): Signal {
  const text = item.kind === 'article' ? item.title : item.text;
  const rawIds: Record<string, string> = {};
  if (item.relatedCoinIds.length > 0) {
    rawIds.coingecko = item.relatedCoinIds.join(',');
  }
  if (item.kind === 'article' && item.outlet) {
    rawIds.outlet = item.outlet;
  }
  if (item.kind === 'post' && item.handle) {
    rawIds.handle = item.handle;
  }

  return parseSignal({
    schema_version: SIGNAL_SCHEMA_VERSION,
    signal_id: signalId(NEWS_SIGNAL_SOURCE, item.url),
    source: NEWS_SIGNAL_SOURCE,
    source_id: item.url,
    type: item.kind === 'article' ? 'news' : 'post',
    priority: 0,
    occurred_at: item.kind === 'article' ? item.publishedAt : item.postedAt,
    fetched_at: fetchedAt.toISOString(),
    text,
    numbers: {},
    link: item.url,
    raw_ids: rawIds,
    unusual_score: null,
    excerpt: truncateExcerpt(text),
    raw_hash: rawHash(JSON.stringify(item)),
  });
}