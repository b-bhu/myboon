/**
 * Shared analyst decision types. The old #479 linkerStory() job and the #480
 * proposed-entity reviewer were removed in the #571 cleanup; story / park /
 * duplicate judgement now lives in @myboon/entity-manager.
 */
export type Interpretation = { status: 'analysed' | 'parked'; parkedReason?: string; fields: Record<string, unknown> };

/** Thrown by buildCase when the signal is parked before any decider call. */
export class ParkSignal extends Error {
  constructor(readonly reason: string) {
    super(`parked: ${reason}`);
    this.name = 'ParkSignal';
  }
}
