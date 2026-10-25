import { z } from 'zod';

import { HEX64 } from './common.js';

/** Schema version of the V4 Decision form. Bumped on breaking changes. */
export const DECISION_SCHEMA_VERSION = 1;

const decisionFields = {
  schema_version: z.literal(1),
  signal_id: z.string().regex(HEX64),
  analyst_version: z.string().min(1),
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1),
};

const shelfSchema = z.object({
  shelf_id: z.uuid(),
  role: z.union([z.literal('main'), z.literal('also_affects')]),
});

const shelvesSchema = z
  .array(shelfSchema)
  .min(1)
  .refine((shelves) => shelves.filter((shelf) => shelf.role === 'main').length === 1, {
    message: 'exactly one shelf must have role main',
  })
  .refine(
    (shelves) => new Set(shelves.map((shelf) => shelf.shelf_id)).size === shelves.length,
    { message: 'shelf_id must not be duplicated' },
  );

const fileDecisionSchemaBase = z.object({
  decision_type: z.literal('file'),
  ...decisionFields,
  shelves: shelvesSchema,
  /** null = the signal does not map to an existing item (file to a new one). */
  target_item_id: z.uuid().nullable(),
  item_key: z.string().min(1),
  action: z.union([z.literal('keep'), z.literal('skip')]),
});

const mergeDecisionSchemaBase = z
  .object({
    decision_type: z.literal('merge'),
    ...decisionFields,
    /** The item being retired in favor of merged_into_id. */
    target_item_id: z.uuid(),
    /** The survivor item; must differ from target_item_id. */
    merged_into_id: z.uuid(),
  })
  .refine((decision) => decision.merged_into_id !== decision.target_item_id, {
    path: ['merged_into_id'],
    message: 'merged_into_id must differ from target_item_id',
  });

export const decisionSchema = z.discriminatedUnion('decision_type', [
  fileDecisionSchemaBase,
  mergeDecisionSchemaBase,
]);

export type DecisionType = 'file' | 'merge';
export type Decision = z.output<typeof decisionSchema>;

/** Parses a Decision input and returns the typed value; throws ZodError on invalid input. */
export function parseDecision(input: unknown): Decision {
  return decisionSchema.parse(input);
}

/** Safe variant of {@link parseDecision} that returns the parse result instead of throwing. */
export function safeParseDecision(input: unknown): z.SafeParseReturnType<unknown, Decision> {
  return decisionSchema.safeParse(input);
}

export { DECISION_SCHEMA_VERSION };