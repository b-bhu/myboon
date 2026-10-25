import { z } from 'zod';

import { signalId } from './ids.js';
import { HEX64 } from './common.js';

/** Schema version of the V4 Signal form. Bumped on breaking changes. */
export const SIGNAL_SCHEMA_VERSION = 1;

/** ISO datetime string with a UTC designator or numeric offset. */
const isoDatetime = z.iso.datetime({ offset: true });

const signalFields = {
  schema_version: z.literal(1),
  signal_id: z.string().regex(HEX64),
  source: z.string().min(1),
  source_id: z.string().min(1),
  occurred_at: isoDatetime.nullable(),
  fetched_at: isoDatetime,
  priority: z.union([z.literal(0), z.literal(1)]).default(0),
  text: z.string().nullable(),
  link: z.url().nullable(),
  raw_ids: z.record(z.string(), z.string()).default({}),
  unusual_score: z.number().nullable(),
  excerpt: z.string().max(500).nullable(),
  raw_hash: z.string().regex(HEX64),
};

const newsNumbers = z.strictObject({});
const postNumbers = z.strictObject({
  likes: z.number().finite().optional(),
  reposts: z.number().finite().optional(),
  replies: z.number().finite().optional(),
  views: z.number().finite().optional(),
  followers: z.number().finite().optional(),
});
const priceMoveNumbers = z.strictObject({
  price: z.number().finite().optional(),
  prev_price: z.number().finite().optional(),
  change_pct: z.number().finite().optional(),
  volume: z.number().finite().optional(),
});
const onchainEventNumbers = z.strictObject({
  amount: z.number().finite().optional(),
  amount_usd: z.number().finite().optional(),
  slot: z.number().finite().optional(),
  block: z.number().finite().optional(),
});

const signalSchemaBase = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('news'), numbers: newsNumbers.default({}), ...signalFields }),
    z.object({ type: z.literal('post'), numbers: postNumbers.default({}), ...signalFields }),
    z.object({
      type: z.literal('price_move'),
      numbers: priceMoveNumbers.default({}),
      ...signalFields,
    }),
    z.object({
      type: z.literal('onchain_event'),
      numbers: onchainEventNumbers.default({}),
      ...signalFields,
    }),
  ])
  .refine((signal) => signal.signal_id === signalId(signal.source, signal.source_id), {
    path: ['signal_id'],
    message: 'signal_id must equal signalId(source, source_id)',
  });

export const signalSchema = signalSchemaBase;

export type SignalType = 'post' | 'price_move' | 'onchain_event' | 'news';
export type Signal = z.output<typeof signalSchema>;

/** Parses a Signal input and returns the typed value; throws ZodError on invalid input. */
export function parseSignal(input: unknown): Signal {
  return signalSchema.parse(input);
}

/** Safe variant of {@link parseSignal} that returns the parse result instead of throwing. */
export function safeParseSignal(input: unknown) {
  return signalSchema.safeParse(input);
}