/**
 * CLI entry: run the scout once against Supabase (service_role), then exit.
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are read from the environment
 * and NEVER logged.
 */
import { createSupabaseClient, requireSupabaseEnv } from '@myboon/shared/supabase-client';

import { runScoutOnce } from './scout.js';
import { runGatedScout } from '@myboon/shared/v4-runtime';

async function main(): Promise<void> {
  const { supabaseUrl, supabaseKey } = requireSupabaseEnv(process.env);
  const db = createSupabaseClient(supabaseUrl, supabaseKey);
  await runScoutOnce({ db });
}

// SCOUT_ENABLED gate (#444): off exits 0 before any client is created.
runGatedScout({ run: main }).catch((error: unknown) => {
  // PostgREST errors carry a message; log the message only, never a URL or key.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`scout-news: run failed: ${message}`);
  process.exitCode = 1;
});