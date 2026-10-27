// #478 test-first stub: the API the acceptance tests drive. Implementation follows.
import type { Pool } from 'pg';
type Db = Pick<Pool, 'query'>;
export class DeciderError extends Error {
  constructor(readonly kind: 'error' | 'timeout' | 'out_of_credit', message: string) { super(message); }
}
export type DecisionCase = { question: string; choices: string[]; shortlist: unknown[]; itemIds: string[]; state: unknown };
export type DeciderAnswer = { choice: string; probabilities: Record<string, number> };
export interface Decider { name: 'jev' | 'clef'; modelName: string; modelVersion: string; decide(c: DecisionCase, signal: AbortSignal): Promise<DeciderAnswer> }
export type Claim = { signalId: string; token: string; attempts: number };
export type ProcessOptions = {
  primary: Decider; fallback: Decider; shadow: Decider;
  buildCase(signal: { signal_id: string; text: string | null; excerpt: string | null; link: string | null }): DecisionCase;
  promptVersion: string; leaseMs: number; timeoutMs: number; backoffMs: number; maxAttempts: number; worker: string;
};
const todo = (): never => { throw new Error('not implemented (#478)'); };
export async function claimNext(_db: Db, _o: { leaseMs: number; worker: string }): Promise<Claim | null> { return todo(); }
export async function finishClaim(_db: Db, _c: Claim, _o: { status: string; parkedReason?: string }): Promise<boolean> { return todo(); }
export async function failClaim(_db: Db, _c: Claim, _o: { error: string; backoffMs: number; maxAttempts: number }): Promise<'retry' | 'dead' | 'lost_claim'> { return todo(); }
export async function processNext(_db: Pool, _o: ProcessOptions): Promise<{ signalId: string } | null> { return todo(); }
