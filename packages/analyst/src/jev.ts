/**
 * #478: the logged Jev client. Exactly one atlas.jev_decisions row per call --
 * success, error or timeout -- with the measured latency. A Jev failure never
 * surfaces as an exception: the decision log and the returned status carry it.
 * Each call runs under its own AbortController; at timeout the controller is
 * aborted, so ports backed by HTTP stop the in-flight request instead of
 * waiting it out.
 */
import type { Pool } from 'pg';

export type JevAnswer = { answer: unknown; probability: number | null; runnerUp: unknown; modelVersion: string };

export interface JevPort { modelVersion: string; decide(input: unknown, signal: AbortSignal): Promise<JevAnswer> }

export type JevStatus = 'success' | 'error' | 'timeout';

export type JevCallOptions = { signalId: string; stage: string; inputCase: unknown; timeoutMs: number };

export type JevCallResult = { status: 'success' } | { status: 'error' | 'timeout'; error: string };

type Settled =
  | { status: 'success'; answer: JevAnswer }
  | { status: 'error'; error: string }
  | { status: 'timeout' };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A malformed answer is logged as an error row, never dropped: the DB check would reject it. */
function answerProblem(a: JevAnswer | undefined): string | null {
  if (a == null || a.answer === undefined || a.answer === null) return 'missing answer';
  const p = a.probability;
  if (p !== null && (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1)) return `probability out of range: ${String(p)}`;
  return null;
}

/** Races decide() against the timeout, aborting the call's signal at the deadline; never rejects either way. */
function settle(jev: JevPort, input: unknown, timeoutMs: number, ac: AbortController): Promise<Settled> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Settled>((resolve) => {
    timer = setTimeout(() => {
      ac.abort();
      resolve({ status: 'timeout' });
    }, timeoutMs);
  });
  const decision = Promise.resolve().then(() => jev.decide(input, ac.signal)).then(
    (answer): Settled => {
      const problem = answerProblem(answer);
      return problem ? { status: 'error', error: `invalid_answer: ${problem}` } : { status: 'success', answer };
    },
    (err: unknown): Settled => ({ status: 'error', error: errorMessage(err) }),
  );
  return Promise.race([decision, timeout]).finally(() => clearTimeout(timer));
}

/**
 * One Jev call for one signal, timed and logged whatever the outcome. The
 * model version comes from the port itself, so it is recorded even when
 * decide() throws, times out or returns a malformed answer (logged as
 * 'error'). Throws only when the database write itself fails.
 */
export async function callJev(pool: Pool, jev: JevPort, o: JevCallOptions): Promise<JevCallResult> {
  const startedAt = Date.now();
  const ac = new AbortController();
  const settled: Settled = await settle(jev, o.inputCase, o.timeoutMs, ac);
  const latencyMs = Date.now() - startedAt;

  const isSuccess = settled.status === 'success';
  await pool.query(
    `insert into atlas.jev_decisions
       (signal_id, stage, outcome, input_case, answer, probability, runner_up, model_version, error, latency_ms)
     values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8, $9, $10)`,
    [
      o.signalId,
      o.stage,
      settled.status,
      JSON.stringify(o.inputCase ?? null),
      isSuccess ? JSON.stringify(settled.answer.answer) : null,
      isSuccess ? settled.answer.probability : null,
      isSuccess ? JSON.stringify(settled.answer.runnerUp ?? null) : null,
      jev.modelVersion,
      settled.status === 'error' ? settled.error : null,
      latencyMs,
    ],
  );

  if (settled.status === 'success') return { status: 'success' };
  if (settled.status === 'error') return { status: 'error', error: settled.error };
  return { status: 'timeout', error: `jev timeout after ${o.timeoutMs}ms` };
}