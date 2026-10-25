// Vitest config for the analyst-eval spike, invoked from the repo root:
//   packages/contracts/node_modules/.bin/vitest run --config scripts/analyst-eval/vitest.config.ts
// Plain object (no "vitest/config" import): scripts/ is not a pnpm workspace package,
// so that bare specifier would not resolve while esbuild loads this config.
export default {
  test: {
    environment: 'node',
    include: ['scripts/analyst-eval/*.test.ts', 'scripts/analyst-eval/tools/*.test.ts'],
  },
};