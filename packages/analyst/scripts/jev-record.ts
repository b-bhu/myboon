/**
 * #485 fix 3: record real Jev (TypeSafe System One) answers for the
 * fixture-replay test src/jev-recorded.test.ts. Small fixed case set: the
 * contract news samples, one 'choice' question asking which of three given
 * entity candidates the headline is mainly about.
 *
 * Run with the shared team token (scout-news pattern — tsx comes from the
 * workspace root):  pnpm --filter @myboon/analyst jev:record
 * JEV_API_TOKEN is read from the environment and never printed or written.
 * Without it the script explains that and exits 0, so CI and local test runs
 * stay green. The written fixture (src/fixtures/jev-recorded.json) holds the
 * request state, the expected label, the raw response BODY (no HTTP headers,
 * no token) and a timestamp; the replay test reads exactly that.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { newsSampleSignals } from '@myboon/contracts/test-fixtures';
import { TypeSafeJev, type JevQuestion } from '../src/typesafe-jev.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '..', 'src', 'fixtures', 'jev-recorded.json');

const questionKey = 'pick';
const questions: Record<string, JevQuestion> = {
  [questionKey]: {
    type: 'choice',
    instructions: 'Which of the three candidate entities is this headline mainly about?',
    criteria: {
      trump:
        'Donald J. Trump: a proposal, statement or event that is mainly about him and his actions',
      polymarket:
        'The Polymarket prediction-market platform: its markets, contracts, odds and prices',
      us_congress:
        'The U.S. Congress or one of its members acting in Congress (bills, impeachment articles, chamber business)',
    },
  },
};

/**
 * Ground-truth entity per contract news sample, aligned with newsSampleSignals
 * order (currently: Trump's $5,000 proposal; Polymarket US-Iran odds; Polymarket
 * Trump-out odds). If a sample is added to the fixture, add its expected label
 * here too -- the length check below fails loudly otherwise.
 */
const expectedLabels = ['trump', 'polymarket', 'polymarket'] as const;

const token = process.env.JEV_API_TOKEN?.trim() ?? '';
if (token === '') {
  console.log(
    'JEV_API_TOKEN is not set: skipping the real-Jev recording run (no network). '
    + 'Set the shared team token with `pnpm --filter @myboon/analyst jev:record` to refresh the fixture.',
  );
  process.exit(0);
}

if (expectedLabels.length !== newsSampleSignals.length) {
  throw new Error(
    `expectedLabels (${expectedLabels.length}) must cover every newsSampleSignals entry `
    + `(${newsSampleSignals.length}); add the new sample's expected entity before recording.`,
  );
}

// Capture the raw response body for the fixture while TypeSafeJev still gets a
// normal Response: clone() hands the recorder its own copy. Calls run strictly
// sequentially, so the array index matches the sample index.
const rawResponseBodies: unknown[] = [];
const capturingFetch: typeof fetch = async (...args) => {
  const response = await fetch(...args);
  try {
    rawResponseBodies.push(await response.clone().json());
  } catch {
    rawResponseBodies.push(null);
  }
  return response;
};

const jev = new TypeSafeJev({ apiToken: token, questions, fetchImpl: capturingFetch });

const samples: Array<{ signalId: string; state: unknown; expected: string; rawResponse: unknown }> = [];
for (const [i, s] of newsSampleSignals.entries()) {
  const state = { signal_id: s.signal_id, title: s.text, text: s.excerpt, link: s.link };
  const out = await jev.decide(state, new AbortController().signal);
  const picked = (out.answer as Record<string, unknown>)[questionKey];
  if (picked === undefined) throw new Error(`Jev answered no ${questionKey} for sample ${i}`);
  if (picked === expectedLabels[i]) {
    console.log(`${s.signal_id}: picked ${String(picked)} (expected ${expectedLabels[i]})`);
  } else {
    console.log(`${s.signal_id}: picked ${String(picked)}, expected ${expectedLabels[i]} (recorded as-is for offline replay)`);
  }
  samples.push({ signalId: s.signal_id, state, expected: expectedLabels[i], rawResponse: rawResponseBodies[i] ?? null });
}

const fixture = {
  recordedAt: new Date().toISOString(),
  model: jev.modelVersion,
  questionKey,
  questions,
  samples,
};
await mkdir(dirname(fixturePath), { recursive: true });
await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`Recorded ${samples.length} Jev response(s) (model ${fixture.model}) to ${fixturePath}.`);