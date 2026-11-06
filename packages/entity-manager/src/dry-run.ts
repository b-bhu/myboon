/**
 * #571 dry run: read-only. Decides fixture (or DB) handoffs and prints counts + examples; writes nothing.
 * Source: DB pending rows when ENTITY_MANAGER_DATABASE_URL is set and reachable (select only, no claim),
 * otherwise fixtures/handoffs.jsonl. LLM: real Ollama (+ Jev) when OLLAMA_API_KEY is set, else an
 * offline stub labelled as such.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseAnalystHandoff, type AnalystHandoff } from '@myboon/contracts';

import { createJev, createOllamaLlm, type Llm } from './clients.js';
import { decide, emOutcome, signalImage, type EntityRow, type RecentItem } from './decide.js';
import { createPool, loadEntity, loadRecentItems } from './worker.js';

type Case = { handoff: AnalystHandoff; entity: EntityRow | null; items: RecentItem[] };

const words = (t: string) => new Set(t.toLowerCase().match(/[a-z0-9$]+/g) ?? []);
/** Offline stub: word overlap with a recent item -> duplicate; opinion words -> park; else story. */
const stubLlm: Llm = async (m) => {
  const u = m[1]!.content;
  const title = /\ntitle: (.*)\n/.exec(u.split('SIGNAL:')[1] ?? '')?.[1] ?? '';
  const sw = words(title);
  for (const [, id, it] of u.matchAll(/id: (\S+) \| date: \S+ \| title: ([^|]+)/g)) {
    const iw = words(it!);
    const overlap = [...iw].filter((w) => sw.has(w)).length / Math.max(iw.size, 1);
    if (overlap >= 0.4) return JSON.stringify({ decision: 'duplicate', reason: 'Same event as a recent item.', duplicate_of: id });
  }
  if (/\b(analysts? say|opinion|sign of|could|might)\b/i.test(title)) return JSON.stringify({ decision: 'park', reason: 'Commentary on an existing development, nothing new.', duplicate_of: null });
  return JSON.stringify({ decision: 'story', reason: 'New fact for this entity.', duplicate_of: null, title: title.slice(0, 90), summary: title });
};

async function fromDb(url: string): Promise<Case[]> {
  const pool = createPool(url);
  try {
    const r = await pool.query<{ handoff: unknown }>(
      "select handoff from atlas.decisions where em_status = 'pending' order by created_at, id limit 25");
    const out: Case[] = [];
    for (const row of r.rows) {
      const h = parseAnalystHandoff(row.handoff);
      const entity = h.entity ? await loadEntity(pool, h.entity.slug) : null;
      out.push({ handoff: h, entity, items: entity ? await loadRecentItems(pool, entity.id) : [] });
    }
    return out;
  } finally {
    await pool.end();
  }
}

function fromFixture(): Case[] {
  const path = fileURLToPath(new URL('../fixtures/handoffs.jsonl', import.meta.url));
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => {
    const r = JSON.parse(l) as { handoff: unknown; entity: EntityRow | null; items: RecentItem[] };
    return { handoff: parseAnalystHandoff(r.handoff), entity: r.entity, items: r.items };
  });
}

let source = 'fixture';
let cases: Case[] = [];
const dbUrl = process.env.ENTITY_MANAGER_DATABASE_URL?.trim();
if (dbUrl && process.env.EM_DRY_RUN_SOURCE !== 'fixture') {
  try {
    cases = await Promise.race([fromDb(dbUrl), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('db timeout')), 10_000))]);
    source = 'db';
    if (!cases.length) { source = 'fixture (db has 0 pending)'; cases = fromFixture(); }
  } catch (e) {
    source = `fixture (db unreachable: ${(e as Error).message})`;
    cases = fromFixture();
  }
} else cases = fromFixture();

const key = process.env.OLLAMA_API_KEY?.trim();
const jevToken = process.env.JEV_API_TOKEN?.trim();
const llm = key ? createOllamaLlm({ apiKey: key, model: process.env.ENTITY_MANAGER_LLM_MODEL?.trim() || 'glm-5.3-flash' }) : stubLlm;
const jev = key && jevToken ? createJev({ apiToken: jevToken }) : undefined;

const counts: Record<string, number> = { story: 0, parked: 0, duplicate: 0, skipped_no_entity: 0, failed: 0 };
const examples: Record<string, unknown> = {};
for (const c of cases) {
  if (!c.handoff.entity || !c.entity) { counts.skipped_no_entity!++; examples.skipped_no_entity ??= { signal_id: c.handoff.signal_id, text: c.handoff.signal.text }; continue; }
  try {
    const d = await decide(c.entity, c.items, c.handoff, { llm, jev });
    const k = emOutcome(d.decision);
    counts[k]!++;
    examples[k] ??= {
      signal_id: c.handoff.signal_id, entity: c.entity.slug, signal_text: c.handoff.signal.text, ...d,
      would_write: k === 'story' ? { item_key: `${c.handoff.signal_id}:${c.entity.slug}`, image_url: signalImage(c.handoff), item_signals_role: 'origin' }
        : k === 'parked' ? { entity_context: { reason: d.reason, sentiment: null } } : { em_duplicate_of: (d as { duplicate_of?: string }).duplicate_of },
    };
  } catch (e) {
    counts.failed!++;
    examples.failed ??= { signal_id: c.handoff.signal_id, error: (e as Error).message };
  }
}
console.log(`entity-manager dry run (read-only, nothing written) at ${new Date().toISOString()}`);
console.log(`source: ${source}; cases: ${cases.length}; llm: ${key ? 'ollama' + (jev ? ' + jev' : '') : 'OFFLINE STUB (no OLLAMA_API_KEY)'}`);
console.log('counts:', JSON.stringify(counts));
console.log('examples:');
console.log(JSON.stringify(examples, null, 2));
process.exit(0);
