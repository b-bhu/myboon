import { defineConfig } from 'vitest/config';

// Unit tests only, all with injected fakes (no throwaway database, no live
// network, no live Hermes), so files can run in parallel.
export default defineConfig({});
