/**
 * #690 guided-backfill preview, read-only: runs the same pick logic as the entity-manager markets
 * pass over the unchecked candidate entities (or --slugs) and prints the proposals as a table.
 * It never writes to the database — the only write is the reviewed JSON file for markets:apply.
 * DB: ENTITY_MANAGER_DATABASE_URL (entity_worker, select only). LLM: real Ollama when
 * OLLAMA_API_KEY is set, else an offline stub labelled as such.
 *
 * Usage: pnpm --filter @myboon/entity-manager markets:preview [--limit N] [--slugs a,b,c] [--out <path>]
 *   --limit N      how many unchecked candidates (default 50)
 *   --slugs a,b,c  preview exactly these entities instead of the candidate query
 *   --out <path>   where to write the JSON (default ./markets-preview.json)
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { createOllamaLlm, type Llm } from './clients.js';
import { fetchHyperliquidMarkets } from './hyperliquid.js';
import { loadMarketCandidates, pickMarkets, type MarketCandidate, type Q } from './markets-worker.js';
import { createPool, loadRecentItems } from './worker.js';

export type PreviewMarket = { symbol: string; reason: string | null; setBy: 'model' | 'manual'; pinned: boolean };
export type PreviewEntry = { slug: string; entityId: string; markets: PreviewMarket[] };

/**
 * Offline stub (no OLLAMA_API_KEY): up to 3 live symbols whose base name (xyz: prefix stripped)
 * appears in the subject's name or item titles. Enough to review the pipeline shape; labelled a
 * stub in the output so stub rows are never mistaken for real model proposals.
 */
export const stubMarketsLlm: Llm = async (messages) => {
  const user = messages[1]!.content;
  const li = user.indexOf('LIVE SYMBOLS');
  if (li < 0) return '{"markets":[]}';
  const context = user.slice(0, li);
  const names = user.slice(li).split('\n').slice(1);
  const picks = names
    .filter((n) => {
      if (!n) return false;
      const base = n.startsWith('xyz:') ? n.slice(4) : n;
      return base && context.toLowerCase().includes(base.toLowerCase());
    })
    .slice(0, 3);
  return JSON.stringify({ markets: picks.map((s) => ({ symbol: s, reason: 'stub preview: name appears in the context' })) });
};

async function loadBySlugs(db: Q, slugs: string[]): Promise<MarketCandidate[]> {
  const r = await db.query<MarketCandidate>(
    "select id, slug, name, type, summary from atlas.entities where status = 'active' and slug = any($1::text[])",
    [slugs],
  );
  return r.rows;
}

export type PreviewDeps = {
  db: pg.Pool | Q;
  llm: Llm;
  limit: number;
  slugs?: string[];
  /** defaults to the live Hyperliquid list; tests inject a fixed one */
  list?: () => Promise<ReadonlySet<string>>;
};

/** Same pick path as the run's markets pass, but select-only: it never issues a write. */
export async function runPreview(deps: PreviewDeps): Promise<PreviewEntry[]> {
  const symbols = await (deps.list ?? fetchHyperliquidMarkets)();
  const candidates: MarketCandidate[] = deps.slugs?.length ? await loadBySlugs(deps.db, deps.slugs) : await loadMarketCandidates(deps.db, deps.limit);
  const out: PreviewEntry[] = [];
  for (const entity of candidates) {
    const items = await loadRecentItems(deps.db, entity.id);
    const { picks } = await pickMarkets(entity, { llm: deps.llm, items, symbols });
    out.push({
      slug: entity.slug,
      entityId: entity.id,
      markets: picks.map((p): PreviewMarket => ({ symbol: p.symbol, reason: p.reason, setBy: 'model', pinned: false })),
    });
  }
  return out;
}

export function previewTable(entries: PreviewEntry[]): string[] {
  const lines: string[] = [];
  for (const e of entries) {
    if (!e.markets.length) {
      lines.push(`${e.slug}\tnone`);
      continue;
    }
    for (const [i, m] of e.markets.entries()) lines.push(`${e.slug}\t${i + 1}\t${m.symbol}\t${m.reason ?? ''}`);
  }
  return lines;
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const usage = 'usage: markets:preview [--limit N] [--slugs a,b,c] [--out path]';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  for (const [i, a] of argv.entries()) if (a === '--help' || a === '-h') console.log(usage), process.exit(0);
  const outPath = resolve(arg(argv, '--out') ?? 'markets-preview.json');
  const limit = Number(arg(argv, '--limit') ?? 50);
  if (!Number.isInteger(limit) || limit <= 0) {
    console.error(`markets-preview: --limit must be a positive integer; ${usage}`);
    process.exitCode = 1;
    return;
  }
  const slugs = arg(argv, '--slugs')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const dbUrl = process.env.ENTITY_MANAGER_DATABASE_URL?.trim();
  if (!dbUrl) {
    console.error('markets-preview: ENTITY_MANAGER_DATABASE_URL is required');
    process.exitCode = 1;
    return;
  }
  const key = process.env.OLLAMA_API_KEY?.trim();
  const llm = key
    ? createOllamaLlm({ apiKey: key, model: process.env.ENTITY_MANAGER_LLM_MODEL?.trim() || 'glm-5.3-flash' })
    : stubMarketsLlm;
  const pool = createPool(dbUrl);
  try {
    const symbols = await fetchHyperliquidMarkets();
    const entries = await runPreview({ db: pool, llm, limit, slugs, list: async () => symbols });
    if (slugs?.length) {
      for (const s of slugs) if (!entries.some((e) => e.slug === s)) console.log(`${s}\t(not found or not active)`);
    }
    for (const line of previewTable(entries)) console.log(line);
    writeFileSync(outPath, `${JSON.stringify(entries, null, 2)}\n`);
    console.log(
      `markets:preview (read-only, nothing written to the database) candidates: ${entries.length}; `
        + `llm: ${key ? 'ollama' : 'OFFLINE STUB (no OLLAMA_API_KEY)'}; wrote ${outPath}`,
    );
  } finally {
    await pool.end();
  }
}

/** Only run the script when invoked directly (tests import the functions). */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((e: unknown) => {
    console.error(`markets-preview: ${(e as Error).message}`);
    process.exit(1);
  });
}
