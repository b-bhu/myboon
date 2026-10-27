import { z } from 'zod';

import { HEX64 } from './common.js';

/**
 * The saved statuses on atlas.signals (#478). The scout's insert is the
 * handoff: new rows arrive as 'received' with no claim, and 'analysed',
 * 'written', 'parked', 'dead' and 'deleted' are written by the analyst stages.
 */
export const SIGNAL_STATUSES = ['received', 'analysed', 'written', 'parked', 'dead', 'deleted'] as const;

export const signalStatusSchema = z.enum(SIGNAL_STATUSES);

export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

/** Parses a SignalStatus input and returns the typed value; throws ZodError on invalid input. */
export function parseSignalStatus(input: unknown): SignalStatus {
  return signalStatusSchema.parse(input);
}

/** Safe variant of {@link parseSignalStatus} that returns the parse result instead of throwing. */
export function safeParseSignalStatus(input: unknown) {
  return signalStatusSchema.safeParse(input);
}

/** Schema version of the decision provenance stored on atlas.decisions (#478). */
export const DECISION_PROVENANCE_SCHEMA_VERSION = 1;

const probabilitiesSchema = z.record(z.string(), z.number().min(0).max(1));
const answerSchema = z.object({ choice: z.string().min(1) });
const shadowOutcomeSchema = z.enum(['decided', 'error', 'timeout']);

/**
 * One analyst decision row as written by the V4 analyst: the chosen answer
 * with every candidate's probability, the runner-up margin, the deciding
 * model's provenance, and the Clef shadow columns (answer only when the
 * shadow answered; the shadow never affects the outcome).
 */
export const decisionProvenanceSchema = z.object({
  schema_version: z.literal(DECISION_PROVENANCE_SCHEMA_VERSION),
  signal_id: z.string().regex(HEX64),
  analyst_version: z.string().min(1),
  decision_type: z.literal('file'),
  action: z.literal('keep'),
  confidence: z.number().min(0).max(1),
  shortlist: z.array(z.object({ slug: z.string().min(1), score: z.number() })),
  item_ids: z.array(z.uuid()),
  prompt_version: z.string().min(1),
  model_name: z.string().min(1),
  model_version: z.string().min(1),
  decided_by: z.enum(['jev', 'clef']),
  answer: answerSchema,
  probabilities: probabilitiesSchema,
  runner_up_margin: z.number().min(0).max(1),
  latency_ms: z.number().int().min(0),
  outcome: z.literal('decided'),
  /** Kind + message of the losing primary when the fallback decided; null otherwise. */
  primary_error: z.string().nullable(),
  shadow_answer: answerSchema.nullable(),
  shadow_probabilities: probabilitiesSchema.nullable(),
  shadow_latency_ms: z.number().int().min(0).nullable(),
  shadow_outcome: shadowOutcomeSchema.nullable(),
  shadow_model_version: z.string().min(1).nullable(),
});

export type DecisionProvenance = z.output<typeof decisionProvenanceSchema>;

/** Parses a DecisionProvenance input and returns the typed value; throws ZodError on invalid input. */
export function parseDecisionProvenance(input: unknown): DecisionProvenance {
  return decisionProvenanceSchema.parse(input);
}

/** Safe variant of {@link parseDecisionProvenance} that returns the parse result instead of throwing. */
export function safeParseDecisionProvenance(input: unknown) {
  return decisionProvenanceSchema.safeParse(input);
}