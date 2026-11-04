/**
 * #567 read-only dry run of type-first matching. For each signal id (read from atlas.signals) or raw
 * article text, runs the analyst session with the real LLM and decision tool and the #566 lookup, and
 * prints one JSON line per signal: mentions with top-3 types, the chosen type (obvious or decided), the
 * candidates per try, and the final pick or none. Nothing is written: no sink, no claim, and every
 * connection runs with default_transaction_read_only = on.
 *
 * Usage (env as the analyst: ANALYST_DATABASE_URL, OLLAMA_API_KEY, JEV_API_TOKEN; never printed):
 *   pnpm --filter @myboon/analyst exec tsx src/dry-run-matching.ts --ids <id1,id2,...>
 *   pnpm --filter @myboon/analyst exec tsx src/dry-run-matching.ts --recent 20
 *   pnpm --filter @myboon/analyst exec tsx src/dry-run-matching.ts --text "Binance exploit drains hot wallet"
 * Add --force-keep to skip the keep/ignore gate (the keep question is answered keep without a call).
 */
import { Pool } from 'pg';

import { parseAnalystConfig } from './config.js';
import { decideTimed } from './process.js';
import { analystPoolConfig, loadAnalystDatabaseCa } from './db-pool.js';
import { defaultDeciders } from './runner.js';
import { createOllamaLlm, runSession, type Ask, type EntityMissEntry, type MatchTrace, type SignalInput } from './session.js';
import { pgCandidateLookup } from './signal-worker.js';

type Args = { ids: string[]; texts: string[]; recent: number | null; forceKeep: boolean };

export function parseArgs(argv: string[]): Args {
  const a: Args = { ids: [], texts: [], recent: null, forceKeep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === '--ids') a.ids.push(...(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    else if (v === '--text') a.texts.push(argv[++i] ?? '');
    else if (v === '--recent') a.recent = Number(argv[++i]);
    else if (v === '--force-keep') a.forceKeep = true;
    else throw new Error(`unknown argument ${v}`);
  }
  if (a.ids.length === 0 && a.texts.length === 0 && !a.recent) throw new Error('give --ids, --text or --recent');
  return a;
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const c = parseAnalystConfig(process.env);
  const pool = new Pool({ ...analystPoolConfig(c.databaseUrl, loadAnalystDatabaseCa(process.env)), max: 2 });
  pool.on('connect', (client) => { void client.query('set default_transaction_read_only = on'); });
  try {
    const llm = createOllamaLlm({ apiKey: c.ollamaApiKey, model: c.llmModel, timeoutMs: c.timeoutMs });
    const { primary, fallback } = defaultDeciders(c);
    const ask: Ask = async (input) => {
      if (args.forceKeep && input.choices.includes('keep')) return { choice: 'keep', probabilities: { keep: 1 }, provider: 'jev' };
      const kase = { question: input.question, choices: input.choices, shortlist: input.shortlist, itemIds: input.shortlist.map((s) => s.slug), state: input.state };
      try {
        const r = (await decideTimed(primary, kase, c.timeoutMs)).answer;
        return { choice: r.choice, probabilities: r.probabilities, provider: 'jev' };
      } catch {
        const r = (await decideTimed(fallback, kase, c.timeoutMs)).answer;
        return { choice: r.choice, probabilities: r.probabilities, provider: 'clef' };
      }
    };

    const signals: SignalInput[] = args.texts.map((text, i) => ({ signal_id: `text-${i + 1}`, text }));
    if (args.ids.length > 0 || args.recent) {
      const { rows } = args.ids.length > 0
        ? await pool.query<SignalInput>('select signal_id, text, source, link from atlas.signals where signal_id = any($1::text[])', [args.ids])
        : await pool.query<SignalInput>('select signal_id, text, source, link from atlas.signals where text is not null order by occurred_at desc limit $1', [args.recent]);
      signals.push(...rows.map((r) => ({ ...r, text: r.text ?? '' })));
    }

    const lookup = pgCandidateLookup(pool);
    const totals = { signals: 0, matched: 0, none: 0, fallback_matched: 0, ignored: 0, unclear: 0, failed: 0 };
    for (const signal of signals) {
      const traces: MatchTrace[] = [];
      const misses: EntityMissEntry[] = [];
      let allMentions: unknown[] = [];
      totals.signals += 1;
      try {
        const out = await runSession(signal, { llm, ask, lookup, trace: (t) => traces.push(t), onMentions: (m) => { allMentions = m; }, missLog: (m) => misses.push(m) });
        const pick = traces.find((t) => t.pick)?.pick ?? null;
        if (out.decision === 'ignore') totals.ignored += 1;
        else if (out.decision === 'unclear') totals.unclear += 1;
        else if (pick) {
          totals.matched += 1;
          if (traces.some((t) => t.pick && t.tries.at(-1)?.type === 'any')) totals.fallback_matched += 1;
        } else totals.none += 1;
        console.log(JSON.stringify({
          signal_id: signal.signal_id, text: signal.text.slice(0, 160), decision: out.decision, all_mentions: allMentions,
          mentions: traces.map((t) => ({ mention: t.mention, types: t.types, type_decision: t.type_decision, chosen_type: t.chosen_type, tries: t.tries, pick: t.pick?.slug ?? null })),
          final: pick ? `${pick.slug} (${pick.type})` : 'none', misses: misses.length, reason: out.decision === 'keep' ? undefined : out.reason,
        }));
      } catch (e) {
        totals.failed += 1;
        console.log(JSON.stringify({ signal_id: signal.signal_id, error: e instanceof Error ? e.message : String(e), all_mentions: allMentions, traces, misses }));
      }
    }
    console.log(JSON.stringify({ event: 'dry_run_totals', ...totals }));
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith('dry-run-matching.ts') || process.env.DRY_RUN_MATCHING_MAIN === '1') {
  main().catch((e: unknown) => {
    console.error(`dry-run: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
