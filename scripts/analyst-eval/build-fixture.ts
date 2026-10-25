// Builds fixtures/signals.json from rows read (read-only) with fixtures/select-signals.sql.
// Usage: tsx scripts/analyst-eval/build-fixture.ts <rows.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSignal, rawHash, signalId, SIGNAL_SCHEMA_VERSION } from '../../packages/contracts/src/index.js';

interface Row {
  memory_id: string; entity_id: string; source: string; source_ref_id: string;
  title: string; summary: string | null; event_at: string; observed_at: string;
}

const rows = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as Row[];
const signals = rows.map((row) => parseSignal({
  schema_version: SIGNAL_SCHEMA_VERSION,
  signal_id: signalId(row.source, row.source_ref_id),
  source: row.source,
  source_id: row.source_ref_id,
  occurred_at: row.event_at,
  fetched_at: row.observed_at,
  type: 'news',
  priority: 0,
  text: row.title,
  numbers: {},
  link: /^https?:\/\//.test(row.source_ref_id) ? row.source_ref_id : null,
  raw_ids: { memory_id: row.memory_id, legacy_entity_id: row.entity_id },
  unusual_score: null,
  excerpt: row.summary ? row.summary.slice(0, 500) : null,
  raw_hash: rawHash(JSON.stringify(row)),
}));
if (signals.length !== 50) throw new Error(`expected 50 signals, got ${signals.length}`);
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/signals.json'), `${JSON.stringify(signals, null, 2)}\n`);
console.log(`wrote ${signals.length} signals`);
