/**
 * #582 batching: pending signals split into fixed-size batches (the last batch
 * takes the remainder — 45 items become 10,10,10,10,5), with at most
 * maxParallel batches in flight. The batch worker is expected to be
 * best-effort (per-signal failures are recorded inside it); a rejecting worker
 * cannot stall the pool, only its own batch ends early.
 */

export function chunkBatch<T>(items: readonly T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let at = 0; at < items.length; at += batchSize) {
    batches.push(items.slice(at, at + batchSize));
  }
  return batches;
}

export interface RunBatchesResult {
  /** Highest number of batches observed in flight — the injected concurrency signal. */
  maxInFlight: number;
}

export async function runBatches<T>(
  batches: readonly T[],
  maxParallel: number,
  worker: (batch: T) => Promise<void>,
): Promise<RunBatchesResult> {
  let nextIndex = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  return new Promise<RunBatchesResult>((resolve) => {
    const maybeDone = () => {
      if (inFlight === 0 && (nextIndex >= batches.length || batches.length === 0)) resolve({ maxInFlight });
    };
    const launch = () => {
      while (inFlight < maxParallel && nextIndex < batches.length) {
        const batch = batches[nextIndex++];
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        worker(batch)
          .catch(() => { /* best-effort: the batch worker reports its own outcomes */ })
          .finally(() => {
            inFlight -= 1;
            launch();
            maybeDone();
          });
      }
      maybeDone();
    };
    launch();
  });
}
