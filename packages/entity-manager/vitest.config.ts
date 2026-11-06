import { defineConfig } from 'vitest/config';

// The *.db.test.ts files each create a throwaway database on one shared Postgres
// server, and the atlas migrations create cluster-wide roles (atlas_analyst), so
// concurrent files race on pg_authid. Run test files one at a time.
export default defineConfig({
  test: { fileParallelism: false },
});
