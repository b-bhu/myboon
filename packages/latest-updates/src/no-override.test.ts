/**
 * Source pins for the must-preserve rules in #631: the runner has no window-basis override, writes only the three
 * new tables, never updates or deletes, and does not import the eval-only code.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CANDIDATES_SQL } from './store.js';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const RUNTIME = ['store.ts', 'runner.ts', 'entry.ts', 'run.ts', 'config.ts', 'editor.ts', 'checks.ts', 'periods.ts', 'text.ts', 'clients.ts', 'types.ts'];
const read = (f: string) => readFileSync(`${SRC}${f}`, 'utf8');

describe('the runner has no window override and only ever reads occurred_at for the window', () => {
  it('the candidate query windows on occurred_at, never created_at', () => {
    expect(CANDIDATES_SQL).toContain('i.occurred_at >= $1::timestamptz - make_interval(hours => $2::int)');
    expect(CANDIDATES_SQL).toContain('i.occurred_at <= $1::timestamptz');
    expect(CANDIDATES_SQL).toContain('i.occurred_at is not null');
    expect(CANDIDATES_SQL).not.toMatch(/i\.created_at\s*(>=|<=|<|>)/);
  });
  it('no runtime file imports the eval-only modules or reads a basis from env', () => {
    for (const f of RUNTIME) {
      const text = read(f);
      expect(text, f).not.toMatch(/from '\.\/(freeze|eval|eval-lib)\.js'/);
      expect(text, f).not.toMatch(/LATEST_UPDATES_(BASIS|WINDOW_BASIS|WINDOW_FIELD)/);
    }
  });
  it('the window length is the only window knob in config', () => {
    expect(read('config.ts')).toMatch(/LATEST_UPDATES_WINDOW_HOURS/);
    expect(read('config.ts')).not.toMatch(/created_at/);
  });
});

describe('the runner is insert-only on the three new tables', () => {
  it('has no UPDATE or DELETE statement and writes only to the three tables', () => {
    for (const f of RUNTIME) {
      const text = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(text, f).not.toMatch(/\b(update\s+atlas\.|delete\s+from|truncate\s|drop\s+table|alter\s+table)/i);
      for (const m of text.matchAll(/insert\s+into\s+(atlas\.\w+)/gi)) {
        expect(['atlas.latest_update_runs', 'atlas.latest_updates', 'atlas.latest_update_items'], `${f}: ${m[0]}`).toContain(m[1]!.toLowerCase());
      }
    }
  });
  it('never touches stories or the legacy tables', () => {
    for (const f of RUNTIME) {
      expect(read(f), f).not.toMatch(/atlas\.stories|atlas\.story_items|published_narratives/);
    }
  });
  it('does not print secrets: no env value reaches a log call', () => {
    const entry = read('entry.ts');
    expect(entry).not.toMatch(/console\.\w+\([^)]*(process\.env|DATABASE_URL|API_KEY)/);
  });
  it('every file in src is either runtime, eval-only or a test', () => {
    const known = new Set([...RUNTIME, 'freeze.ts', 'eval.ts', 'eval-lib.ts', 'fixtures.ts']);
    for (const f of readdirSync(SRC)) if (!f.endsWith('.test.ts')) expect(known.has(f), `${f} is not classified`).toBe(true);
  });
});
