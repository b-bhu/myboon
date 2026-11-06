import { describe, expect, test } from 'vitest';

import { chunkBatch, runBatches } from './batching.js';

describe('batching (#582)', () => {
  test('45 items split into 10/10/10/10/5 with a final remainder batch', () => {
    const batches = chunkBatch(Array.from({ length: 45 }, (_, i) => i), 10);
    expect(batches.map((b) => b.length)).toEqual([10, 10, 10, 10, 5]);
    expect(batches.flat()).toEqual(Array.from({ length: 45 }, (_, i) => i));
  });

  test('empty input yields no batches', () => {
    expect(chunkBatch([], 10)).toEqual([]);
  });

  test('never exceeds maxParallel batches in flight, and processes every batch', async () => {
    const order: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const batches = [0, 1, 2, 3, 4, 5, 6];
    const { maxInFlight: reported } = await runBatches(batches, 2, async (batch) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(batch);
      inFlight -= 1;
    });
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(reported).toBe(maxInFlight);
    expect(order.sort()).toEqual(batches);
  });

  test('runs up to maxParallel concurrently when enough batches exist', async () => {
    const gate = new Promise<void>((resolve) => { setTimeout(resolve, 20); });
    let inFlight = 0;
    let reached = 0;
    const { maxInFlight } = await runBatches([0, 1, 2, 3, 4], 5, async () => {
      inFlight += 1;
      reached = Math.max(reached, inFlight);
      await gate;
      inFlight -= 1;
    });
    expect(reached).toBe(5);
    expect(maxInFlight).toBe(5);
  });

  test('a rejecting worker cannot stall the pool — later batches still run', async () => {
    const processed: number[] = [];
    await runBatches([0, 1, 2], 2, async (batch) => {
      processed.push(batch);
      if (batch === 1) throw new Error('boom');
    });
    // batch 1 rejects after starting; batches 0 and 2 still complete
    expect(processed).toEqual([0, 1, 2]);
  });

  test('zero batches resolve immediately', async () => {
    const result = await runBatches([], 5, async () => { throw new Error('never called'); });
    expect(result.maxInFlight).toBe(0);
  });
});
