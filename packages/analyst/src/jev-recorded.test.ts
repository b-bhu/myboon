/**
 * #485 fix 3: offline replay of the recorded real-Jev responses that
 * scripts/jev-record.ts wrote to src/fixtures/jev-recorded.json (that run needs
 * the shared JEV_API_TOKEN; this test never touches the network -- every
 * response is replayed through TypeSafeJev via a fake fetch). It checks the
 * recorded raw responses still parse through the adapter and logs pick
 * accuracy against the recorded expected labels. Without the fixture (CI and
 * dev machines without the token) the test skips.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { TypeSafeJev, type JevQuestion } from './index.js';

type RecordedFixture = {
  recordedAt: string;
  model: string;
  questionKey: string;
  questions: Record<string, JevQuestion>;
  samples: Array<{ signalId: string; state: unknown; expected: string; rawResponse: unknown }>;
};

const fixturePath = fileURLToPath(new URL('./fixtures/jev-recorded.json', import.meta.url));
const hasFixture = existsSync(fixturePath);

/** Serves the recorded body exactly like the recording day: HTTP 200, JSON. */
function fakeBody(body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
}

describe.skipIf(!hasFixture)('#485 recorded Jev fixture replay', () => {
  it('replays every recorded response through TypeSafeJev and reports pick accuracy', async () => {
    const data = JSON.parse(readFileSync(fixturePath, 'utf8')) as RecordedFixture;
    expect(data.samples.length).toBeGreaterThan(0);
    let correct = 0;
    for (const sample of data.samples) {
      const jev = new TypeSafeJev({
        apiToken: 'fixture-replay-only', // fake fetch: the token never leaves this process
        model: data.model,
        questions: data.questions,
        fetchImpl: fakeBody(sample.rawResponse),
      });
      const out = await jev.decide(sample.state, new AbortController().signal);
      const picked = (out.answer as Record<string, unknown>)[data.questionKey];
      if (picked === sample.expected) {
        correct += 1;
      } else {
        console.log(`replay mismatch: ${sample.signalId} picked ${String(picked)}, expected ${sample.expected}`);
      }
    }
    console.log(`replay: parse ok for ${data.samples.length}/${data.samples.length} responses, pick accuracy ${correct}/${data.samples.length}`);
  });
});