import { z } from 'zod';

/** Schema version of the analyst output form (#504). Bumped on breaking changes. */
export const ANALYST_OUTPUT_SCHEMA_VERSION = 1;

/** The 9 shelf types; mirrors the atlas.shelves type check (see analyst-output.test.ts). */
export const SHELF_TYPES = [
  'organization',
  'asset',
  'protocol',
  'person',
  'topic',
  'place',
  'event',
  'product',
  'regulation',
] as const;

export type ShelfType = (typeof SHELF_TYPES)[number];

/** What a signal can do to an entity once it is placed there. */
export const ANGLES = ['new_story', 'existing_story', 'plain_update'] as const;

export type Angle = (typeof ANGLES)[number];

const analystTargetSchema = z.object({
  entity: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'entity must be a lowercase kebab-case slug'),
  kind: z.enum(['existing', 'new']),
  type: z.enum(SHELF_TYPES),
  angle: z.enum(ANGLES),
  note: z.string(),
});

export const analystOutputSchema = z
  .object({
    schema_version: z.literal(ANALYST_OUTPUT_SCHEMA_VERSION),
    analyst_version: z.string().min(1),
    signal_id: z.string().min(1),
    summary: z.string(),
    decision: z.enum(['keep', 'ignore', 'unclear']),
    reason: z.string().min(1),
    targets: z.array(analystTargetSchema).max(3),
  })
  .refine((out) => new Set(out.targets.map((t) => t.entity)).size === out.targets.length, {
    message: 'target entities must be unique',
  })
  .refine((out) => (out.decision === 'ignore' || out.decision === 'unclear' ? out.targets.length === 0 : true), {
    message: 'ignore and unclear carry no targets',
  });

export type AnalystOutput = z.output<typeof analystOutputSchema>;

/** Parses an AnalystOutput and returns the typed value; throws ZodError on invalid input. */
export function parseAnalystOutput(input: unknown): AnalystOutput {
  return analystOutputSchema.parse(input);
}

/** Safe variant of {@link parseAnalystOutput} that returns the parse result instead of throwing. */
export function safeParseAnalystOutput(input: unknown) {
  return analystOutputSchema.safeParse(input);
}