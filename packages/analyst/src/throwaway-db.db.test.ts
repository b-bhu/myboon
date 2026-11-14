/**
 * Teardown of a throwaway LOCAL Postgres (ANALYST_TEST_ADMIN_URL; skipped when unset).
 * Regression for the unhandled 57P01 that failed the analyst job on main: pg's Pool.end() resolves
 * before its sockets are closed, and drop() used to force-terminate those sessions straight away.
 */
import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createThrowawayDatabase } from '@myboon/atlas-schema';

const ADMIN_URL = process.env.ANALYST_TEST_ADMIN_URL?.trim() ?? '';

describe.skipIf(ADMIN_URL === '')('throwaway database teardown (local Postgres)', () => {
  it('drop() waits for sessions that are still closing, so no unhandled 57P01 reaches the process', async () => {
    const uncaught: Error[] = [];
    const onUncaught = (e: Error) => { uncaught.push(e); };
    process.on('uncaughtException', onUncaught);
    try {
      const db = await createThrowawayDatabase(ADMIN_URL);
      const pool = new Pool({ connectionString: db.url, max: 4 });
      // Model a slow socket close (a busy CI runner): each client sends its Terminate 150 ms late.
      pool.on('connect', (client) => {
        const c = client as unknown as { end: (cb?: () => void) => unknown };
        const end = c.end.bind(c);
        c.end = (cb) => { setTimeout(() => end(cb), 150); return undefined; };
      });
      await Promise.all(Array.from({ length: 4 }, () => pool.query('select 1')));
      await pool.end(); // resolves while the four sockets are still open
      await db.drop();
      await new Promise((r) => setTimeout(r, 400)); // let any late socket error surface
      expect(uncaught.map((e) => (e as Error & { code?: string }).code ?? e.message)).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });
});
