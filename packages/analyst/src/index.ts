/**
 * The V4 analyst decider slot and signal claim state (#478). Public surface:
 *
 * - state helpers: claimNext, finishClaim, failClaim, Claim (atlas.signal_* SQL)
 * - deciders: Decider, DeciderError, DecisionCase, DeciderAnswer,
 *   SystemOneDecider, jevFromEnv, clefFromEnv
 * - orchestration: processNext with ProcessOptions
 */
export * from './deciders.js';
export * from './states.js';
export * from './process.js';