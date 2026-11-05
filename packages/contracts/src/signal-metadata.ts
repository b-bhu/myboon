import { z } from 'zod';

import { ENTITY_TYPES, ANGLES } from './analyst-output.js';

/**
 * #571 the complete signal as stored in atlas.signals, unchanged: one shape for every signal type
 * scout produces, so the entity manager never re-reads the link. Fields mirror the table columns;
 * timestamps are ISO strings. Scout stores no article body today: `text` is the article title or
 * the full post text, `excerpt` is `text` cut to 500 chars.
 */

/** raw_ids keys scout-news writes (#561); any other string key is kept as is. */
export const signalRawIdsSchema = z
  .object({
    /** Image URL of the article or post. */
    image: z.string().optional(),
    author: z.string().optional(),
    /** Internal provenance ('coingecko' | 'x'); never shown to readers (#559). */
    feed_source: z.string().optional(),
    outlet: z.string().optional(),
    handle: z.string().optional(),
    /** Comma-joined CoinGecko coin ids. */
    coingecko: z.string().optional(),
  })
  .catchall(z.string());

const iso = z.iso.datetime({ offset: true });

export const signalMetadataSchema = z.object({
  signal_id: z.string().min(1),
  schema_version: z.number().int(),
  source: z.string().min(1),
  source_id: z.string().min(1),
  type: z.enum(['post', 'price_move', 'onchain_event', 'news']),
  priority: z.number().int(),
  occurred_at: iso.nullable(),
  fetched_at: iso,
  text: z.string().nullable(),
  /** Per-type numbers (post likes, price change_pct, onchain amount...); {} for news. */
  numbers: z.record(z.string(), z.number()),
  link: z.string().nullable(),
  raw_ids: signalRawIdsSchema,
  unusual_score: z.number().nullable(),
  excerpt: z.string().nullable(),
  raw_hash: z.string().nullable(),
  created_at: iso,
});

export type SignalMetadata = z.output<typeof signalMetadataSchema>;

/** Schema version of the analyst handoff (#571). */
export const ANALYST_HANDOFF_SCHEMA_VERSION = 1;

/** The analyst's one entity pick (the article's main subject), or null when it found none. */
const handoffEntitySchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  type: z.enum(ENTITY_TYPES),
  angle: z.enum(ANGLES),
  note: z.string(),
});

/**
 * #571 where the analyst stops: keep/ignore/unclear, the entity pick (or none) and the full signal.
 * No item, no summary: the entity manager decides what the signal means for the entity.
 */
export const analystHandoffSchema = z
  .object({
    schema_version: z.literal(ANALYST_HANDOFF_SCHEMA_VERSION),
    analyst_version: z.string().min(1),
    signal_id: z.string().min(1),
    decision: z.enum(['keep', 'ignore', 'unclear']),
    reason: z.string().min(1),
    entity: handoffEntitySchema.nullable(),
    signal: signalMetadataSchema,
  })
  .refine((h) => h.signal.signal_id === h.signal_id, { path: ['signal', 'signal_id'], message: 'signal must be the handed-over signal' })
  .refine((h) => h.decision === 'keep' || h.entity === null, { path: ['entity'], message: 'only keep carries an entity' });

export type AnalystHandoff = z.output<typeof analystHandoffSchema>;

export function parseAnalystHandoff(input: unknown): AnalystHandoff {
  return analystHandoffSchema.parse(input);
}
