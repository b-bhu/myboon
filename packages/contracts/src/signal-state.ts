import { z } from 'zod';

/**
 * The per-signal lifecycle states (#478). The forward path is received ->
 * analysed -> written; parked, dead_lettered, discarded and deleted are exits.
 * Order mirrors the SQL check on atlas.signal_states.state.
 */
export const SIGNAL_STATES = [
  'received',
  'analysed',
  'written',
  'parked',
  'dead_lettered',
  'discarded',
  'deleted',
] as const;

export type SignalState = (typeof SIGNAL_STATES)[number];

export const signalStateSchema = z.enum(SIGNAL_STATES);

/** One Jev call's outcome, as recorded in atlas.jev_decisions.outcome. */
export const JEV_OUTCOMES = ['success', 'error', 'timeout'] as const;

export type JevOutcome = (typeof JEV_OUTCOMES)[number];

export const jevOutcomeSchema = z.enum(JEV_OUTCOMES);

/**
 * Schema version of the V4 Jev decision record. Bumped on breaking changes.
 * The atlas.jev_decisions table predates versioning, so the version travels
 * only through code (the schema below is the v1 form).
 */
export const JEV_DECISION_SCHEMA_VERSION = 1;

const isoDatetime = z.iso.datetime({ offset: true });

/**
 * One atlas.jev_decisions row: exactly one record per Jev call. Fields are the
 * table columns in camelCase, with the same constraints as the SQL: probability
 * in [0, 1], and an answer present exactly when the outcome is success.
 */
export const jevDecisionSchema = z
  .object({
    id: z.uuid(),
    signalId: z.string().min(1),
    stage: z.string().min(1),
    outcome: jevOutcomeSchema,
    inputCase: z.unknown(),
    answer: z.unknown().nullable(),
    probability: z.number().finite().min(0).max(1).nullable(),
    runnerUp: z.unknown().nullable(),
    modelVersion: z.string().min(1),
    error: z.string().nullable(),
    latencyMs: z.number().int().nullable(),
    createdAt: isoDatetime,
  })
  .refine((decision) => (decision.outcome === 'success') === (decision.answer != null), {
    message: 'answer must be present exactly when outcome is success',
  });

export type JevDecision = z.output<typeof jevDecisionSchema>;