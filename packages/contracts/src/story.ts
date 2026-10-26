import { z } from 'zod';

/**
 * #479 (D20/D23/D25): the Story stage's wire contract. `storyCaseSchema` is
 * the per-signal input the analyst sends in ONE Jev call (logged to
 * atlas.jev_decisions.input_case): the linker shortlist -- up to five active
 * shelves whose aliases appear in the signal text (+ excerpt), with routing
 * rules applied -- and the two choice questions over it. `storyOutcomeSchema`
 * is the parsed analyst outcome derived from Jev's per-question probabilities
 * and the #479 cutoffs, before the DB write. Field names mirror the Jev
 * payload (snake_case), as in decision.ts.
 */
export const STORY_SCHEMA_VERSION = 1;

const isoDatetime = z.iso.datetime({ offset: true });

/** The signal as the linker sees it: headline in text, summary in excerpt. */
export const storySignalSchema = z.object({
  signal_id: z.string().min(1),
  text: z.string().nullable(),
  excerpt: z.string().nullable(),
  occurred_at: isoDatetime.nullable(),
});

/** One raw item of a candidate shelf, newest first. */
export const storyCandidateItemSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1),
  summary: z.string().nullable(),
  occurred_at: isoDatetime.nullable(),
});

/** One candidate shelf. The shortlist holds at most five of these. */
export const storyCandidateSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  items: z.array(storyCandidateItemSchema).max(5),
});

/** A per-call choice question, exactly as TypeSafeJev expects it in the input. */
export const storyQuestionSchema = z.object({
  type: z.literal('choice'),
  instructions: z.string().min(1),
  criteria: z.record(z.string().min(1), z.string().min(1)),
});

export const storyCaseSchema = z.object({
  state: z.object({
    signal: storySignalSchema,
    candidates: z.array(storyCandidateSchema).max(5),
  }),
  questions: z.object({
    /** Choice over the candidate slugs. */
    entity: storyQuestionSchema,
    /** Choice over every candidate item id, plus 'new_story' and 'adds_nothing'. */
    item: storyQuestionSchema,
  }),
});

export type StoryCase = z.output<typeof storyCaseSchema>;
export type StoryCandidate = z.output<typeof storyCandidateSchema>;
export type StoryCandidateItem = z.output<typeof storyCandidateItemSchema>;

export const STORY_OUTCOMES = ['linked', 'new_story', 'parked', 'failed'] as const;
export type StoryOutcomeKind = (typeof STORY_OUTCOMES)[number];

const unit = z.number().min(0).max(1);
/** Mirrors atlas.decisions entity_p / entity_margin / item_p / item_margin (#486). */
export const storyProbabilitiesSchema = z.object({
  entity_p: unit,
  entity_margin: unit,
  item_p: unit,
  item_margin: unit,
});
export type StoryProbabilities = z.output<typeof storyProbabilitiesSchema>;

export const storyOutcomeSchema = z.discriminatedUnion('outcome', [
  /** The signal updates an existing item: decisions.reason 'linked'. */
  z.object({
    outcome: z.literal('linked'),
    slug: z.string().min(1),
    item_id: z.uuid(),
    probabilities: storyProbabilitiesSchema,
  }),
  /** The signal starts a new item under the shelf: decisions.reason 'new_story'. */
  z.object({
    outcome: z.literal('new_story'),
    slug: z.string().min(1),
    probabilities: storyProbabilitiesSchema,
  }),
  /** Padded below the cutoffs or disagreeing: signal parked with a reason.
   * Covers no_match, below_cutoff (<entity|item>), adds_nothing, disagreeing_pick. */
  z.object({
    outcome: z.literal('parked'),
    park_reason: z.string().min(1),
  }),
  /** Jev error/timeout, or an answer the analyst cannot use: retry with backoff. */
  z.object({
    outcome: z.literal('failed'),
    error: z.string().min(1),
  }),
]);

export type StoryOutcome = z.output<typeof storyOutcomeSchema>;

/** Parses a StoryCase input; throws ZodError on invalid input. */
export function parseStoryCase(input: unknown): StoryCase {
  return storyCaseSchema.parse(input);
}

/** Safe variant of {@link parseStoryCase} returning the parse result instead of throwing. */
export function safeParseStoryCase(input: unknown) {
  return storyCaseSchema.safeParse(input);
}

/** Parses a StoryOutcome input; throws ZodError on invalid input. */
export function parseStoryOutcome(input: unknown): StoryOutcome {
  return storyOutcomeSchema.parse(input);
}