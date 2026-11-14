/**
 * One run: pick the eligible entities (oldest first, capped), ask the editor about each, apply the write bar in
 * code, and record exactly one decision per (entity, newest item).
 *
 *   model hold            -> `hold` run row
 *   model skip            -> `skip` run row
 *   model write, bar fails -> `hold` run row listing the failed checks
 *   model write, bar holds -> `published` run row + latest_updates row (visibility from env) + its items
 *   timeout / bad JSON     -> `error` run row and nothing else; the 3rd failed attempt writes `hold`
 *
 * A published / hold / skip row is final for the pair: the candidate query leaves it out on every later tick, so
 * the model is not called again until a newer item arrives. Every entity commits on its own, so a kill loses at
 * most the entity in flight. The run stops starting entities once the budget is spent.
 */
import type { RunConfig } from './config.js';
import { askEditor } from './editor.js';
import { runWriteBar } from './checks.js';
import type { Llm } from './clients.js';
import type { Candidate, Store } from './store.js';
import type { Bundle } from './types.js';

export type RunSummary = {
  candidates: number;
  published: number;
  hold: number;
  skip: number;
  error: number;
  retries_exhausted: number;
  already_decided: number;
  no_bundle: number;
  failed: number;
  budget_stopped: number;
};

export type RunDeps = {
  store: Store;
  llm: Llm;
  config: RunConfig;
  now?: () => Date;
  /** Milliseconds clock for the budget; injectable for tests. */
  clock?: () => number;
  log?: (line: string) => void;
};

const emptySummary = (): RunSummary => ({ candidates: 0, published: 0, hold: 0, skip: 0, error: 0, retries_exhausted: 0, already_decided: 0, no_bundle: 0, failed: 0, budget_stopped: 0 });

async function handle(deps: RunDeps, c: Candidate, now: Date, summary: RunSummary): Promise<void> {
  const { store, llm, config } = deps;
  const bundle: Bundle | null = await store.loadBundle(c, { now, windowHours: config.windowHours });
  if (!bundle) {
    summary.no_bundle += 1;
    return;
  }
  const outcome = await askEditor(bundle, llm);
  let write: Parameters<Store['record']>[0];
  if (outcome.kind === 'error') {
    write = { entityId: c.entityId, newestItemId: c.newestItemId, decision: 'error', reason: `${outcome.code}: ${outcome.message}`, checkFailures: [] };
  } else if (outcome.model.decision !== 'write') {
    write = { entityId: c.entityId, newestItemId: c.newestItemId, decision: outcome.model.decision, reason: outcome.model.reason, checkFailures: [] };
  } else {
    const failures = runWriteBar(outcome.model.draft, bundle);
    write = failures.length > 0
      ? { entityId: c.entityId, newestItemId: c.newestItemId, decision: 'hold', reason: `write bar failed: ${[...new Set(failures.map((f) => f.check))].join(', ')}`, checkFailures: failures }
      : {
          entityId: c.entityId, newestItemId: c.newestItemId, decision: 'published', reason: outcome.model.reason, checkFailures: [],
          publish: { draft: outcome.model.draft, itemIds: bundle.new_items.map((i) => i.id), model: config.model, visibility: config.visibility },
        };
  }
  const result = await store.record(write);
  if (result.outcome === 'already_decided') {
    summary.already_decided += 1;
    return;
  }
  if (result.decision === 'published') summary.published += 1;
  else if (result.decision === 'skip') summary.skip += 1;
  else if (result.decision === 'error') summary.error += 1;
  else {
    summary.hold += 1;
    if (write.decision === 'error') summary.retries_exhausted += 1;
  }
}

export async function runOnce(deps: RunDeps): Promise<RunSummary> {
  const clock = deps.clock ?? Date.now;
  const log = deps.log ?? ((line: string) => { console.error(line); });
  const started = clock();
  const now = (deps.now ?? (() => new Date()))();
  const summary = emptySummary();

  const candidates = (await deps.store.listCandidates({ now, windowHours: deps.config.windowHours, limit: deps.config.maxPerRun })).slice(0, deps.config.maxPerRun);
  summary.candidates = candidates.length;

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (clock() - started >= deps.config.runBudgetMs) return;
      const c = candidates[next];
      if (!c) return;
      next += 1;
      try {
        await handle(deps, c, now, summary);
      } catch (e) {
        summary.failed += 1;
        // The message only (no connection strings): the row is retried on the next tick because nothing was written.
        log(JSON.stringify({ level: 'error', event: 'latest_updates_entity_failed', entity: c.slug, error: e instanceof Error ? e.message.slice(0, 300) : 'unknown' }));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(deps.config.concurrency, Math.max(candidates.length, 1)) }, worker));
  summary.budget_stopped = Math.max(0, candidates.length - next);
  return summary;
}
