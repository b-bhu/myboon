/**
 * #631 eval script. Runs the editor and the write bar over the frozen set in eval/ and reports the bars from #623:
 * agreement, hold-recall, untraced claims, period mismatches and timeouts.
 *
 *   tsx src/eval.ts                            use eval/snapshot.json and eval/labels.csv
 *   tsx src/eval.ts --snapshot a.json --labels b.csv --attempts 3 --timeout-ms 30000 --model glm-5.3-flash --json out.json
 *   tsx src/eval.ts --print-freeze-sql --hours 72 --basis created_at --until 2026-11-14T01:00:00Z [--slugs a,b]
 *
 * Exit codes: 0 scored PASS, 0 NOT SCORED (blank labels or no model key: said clearly, never fails CI),
 * 1 scored FAIL, 2 bad input. The model run needs OLLAMA_API_KEY in the environment (never printed). The freeze
 * options exist ONLY here; the runner has no window override.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createOllamaLlm, type Llm } from './clients.js';
import { DEFAULT_MODEL, DEFAULT_TIMEOUT_MS } from './config.js';
import { EVAL_ATTEMPTS, evaluateEntity, formatReport, loadSnapshot, parseLabels, score, type EntityResult } from './eval-lib.js';
import { freezeSql, type FreezeBasis } from './freeze.js';

const EVAL_DIR = fileURLToPath(new URL('../eval/', import.meta.url));

function flag(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`${name} needs a value`);
  return v;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, out: (s: string) => void, llmOverride?: Llm): Promise<number> {
  try {
    if (argv.includes('--print-freeze-sql')) {
      out(freezeSql({
        basis: (flag(argv, '--basis') ?? 'created_at') as FreezeBasis,
        hours: Number(flag(argv, '--hours') ?? 72),
        until: flag(argv, '--until') ?? new Date().toISOString(),
        slugs: flag(argv, '--slugs')?.split(',').map((s) => s.trim()).filter(Boolean),
      }));
      return 0;
    }
    const snapshot = loadSnapshot(flag(argv, '--snapshot') ?? `${EVAL_DIR}snapshot.json`);
    const labels = parseLabels(readFileSync(flag(argv, '--labels') ?? `${EVAL_DIR}labels.csv`, 'utf8'));
    const unknown = [...labels.byslug.keys()].filter((s) => !snapshot.entities.some((e) => e.slug === s));
    if (unknown.length) throw new Error(`labels.csv has slugs that are not in the snapshot: ${unknown.join(', ')}`);

    const model = flag(argv, '--model') ?? env.LATEST_UPDATES_LLM_MODEL?.trim() ?? DEFAULT_MODEL;
    const attempts = Number(flag(argv, '--attempts') ?? EVAL_ATTEMPTS);
    const timeoutMs = Number(flag(argv, '--timeout-ms') ?? DEFAULT_TIMEOUT_MS);
    const apiKey = env.OLLAMA_API_KEY?.trim();
    const llm = llmOverride ?? (apiKey ? createOllamaLlm({ apiKey, model, timeoutMs }) : null);

    let results: EntityResult[] | null = null;
    if (llm) {
      results = [];
      for (const e of snapshot.entities) results.push(await evaluateEntity(e, llm, attempts));
    }
    const scored = results ? score(results, labels) : null;
    out(formatReport({ entities: snapshot.entities.length, model: results ? model : null, results, score: scored, labels, skippedWhy: 'OLLAMA_API_KEY is not set' }));
    const jsonPath = flag(argv, '--json');
    if (jsonPath && results) writeFileSync(jsonPath, JSON.stringify({ model, results, score: scored }, null, 2));
    return scored?.scored && !scored.pass ? 1 : 0;
  } catch (e) {
    out(`eval: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2), process.env, (s) => { console.log(s); }).then((code) => { process.exitCode = code; });
}
