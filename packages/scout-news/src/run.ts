/**
 * CLI entry: run the scout once against a real database, then exit.
 * DATABASE_URL is read from the environment and NEVER logged.
 */
import { Pool } from 'pg';

import { runScoutOnce } from './scout.js';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error('scout-news: DATABASE_URL is required');
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    connectionTimeoutMillis: 10_000,
    application_name: 'myboon_scout_news',
  });
  try {
    await runScoutOnce({ pool });
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // Connection errors can carry host details but never the URL's credentials;
  // log the message only, never the connection string.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`scout-news: run failed: ${message}`);
  process.exitCode = 1;
});