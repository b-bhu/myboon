// #478 test-first stub: the API the acceptance tests drive. Implementation follows in the next commit.
import type { Pool } from 'pg';
export type JevAnswer = { answer: unknown; probability: number | null; runnerUp: unknown; modelVersion: string };
export interface JevPort { modelVersion: string; decide(input: unknown): Promise<JevAnswer> }
export type Claim = { signalId: string; token: string; state: string; attempts: number };
const todo = (): never => { throw new Error('not implemented (#478)'); };
export async function admitSignals(_p: Pool): Promise<number> { return todo(); }
export async function claimSignals(_p: Pool, _o: { state: string; limit: number; leaseMs: number; worker: string }): Promise<Claim[]> { return todo(); }
export async function completeClaim(_p: Pool, _c: Claim, _o: { to: string; parkReason?: string }): Promise<boolean> { return todo(); }
export async function failClaim(_p: Pool, _c: Claim, _o: { error: string; backoffMs: number }): Promise<'retry' | 'dead_lettered' | 'lost_claim'> { return todo(); }
export async function sweepExpiredClaims(_p: Pool): Promise<number> { return todo(); }
export async function callJev(_p: Pool, _j: JevPort, _o: { signalId: string; stage: string; inputCase: unknown; timeoutMs: number }): Promise<{ status: 'success' | 'error' | 'timeout' }> { return todo(); }
export async function runStageOnce(_p: Pool, _o: { stage: string; from: string; to: string; jev: JevPort; limit: number; leaseMs: number; backoffMs: number; timeoutMs: number }): Promise<unknown> { return todo(); }
