// Root ESLint for the backend packages (#897), first step: warnings only.
// Targets packages/*/src, excluding tests. Apps keep their own configs
// (hybrid-expo's eslint.config.js is untouched by this file).
//
// Every rule brought in by the typescript-eslint recommended preset is
// lowered to 'warn', so `pnpm lint` always exits 0: findings are reported,
// nothing fails. The rules named by the issue are also set explicitly below
// so they survive preset reshuffles; the rest keep the preset's options at
// warn severity.
import tseslint from 'typescript-eslint';

// Test files never enter any config block (a bare ignores block is a global
// ignore, so the presets can't reach them and report at their error severity).
const testIgnores = { ignores: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/*.test.tsx'] };

// 'error' -> 'warn', preserving any rule options; other severities pass through.
const toWarn = (rules = {}) =>
  Object.fromEntries(
    Object.entries(rules).map(([rule, setting]) => [
      rule,
      Array.isArray(setting)
        ? [setting[0] === 'error' ? 'warn' : setting[0], ...setting.slice(1)]
        : setting === 'error'
          ? 'warn'
          : setting,
    ]),
  );

// All rules from the recommended preset, every 'error' lowered to 'warn'.
const presetRules = Object.assign(
  {},
  ...tseslint.configs.recommended
    .filter((block) => block.rules)
    .map((block) => toWarn(block.rules)),
);

export default tseslint.config(
  testIgnores,
  ...tseslint.configs.recommended,
  {
    files: ['packages/*/src/**/*.{ts,tsx}'],
    rules: {
      ...presetRules,
      // The four rules this unit turns on (#897).
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-empty': 'warn',
    },
  },
);
