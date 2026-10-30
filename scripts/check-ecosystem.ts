/**
 * #391 PM2 ecosystem guard for the gated V4 apps.
 *
 * Verifies, with MYBOON_V4_RUNTIME_ENABLED=1 forced on:
 *  - both V4 apps (myboon-scout, myboon-analyst) are registered, with their
 *    cwd and entry point present on disk;
 *  - the myboon-analyst env block covers every non-secret config key that
 *    packages/analyst/src/config.ts reads optionally, plus ANALYST_ENABLED.
 *
 * Run:  pnpm exec tsx scripts/check-ecosystem.ts
 *
 * Prints one line per failure and exits 1. Never prints environment values —
 * only key names and paths.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

type EcosystemApp = {
  name: string;
  script?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
};

const V4_NAMES = ['myboon-scout', 'myboon-analyst'];
const ANALYST_NAME = 'myboon-analyst';
// requireString keys in config.ts; they must never sit in the tracked env.
const ANALYST_SECRET_KEYS = ['ANALYST_DATABASE_URL', 'OLLAMA_API_KEY', 'JEV_API_TOKEN'];
const ANALYST_CONFIG_PATH = path.join(here(), '..', 'packages', 'analyst', 'src', 'config.ts');

function here(): string {
  const entry = process.argv[1];
  if (!entry) {
    console.error('ecosystem check failed: cannot resolve script directory (no process.argv[1])');
    process.exit(1);
  }
  return path.dirname(fs.realpathSync(entry));
}

function main(): void {
  const failures: string[] = [];

  process.env.MYBOON_V4_RUNTIME_ENABLED = '1';
  // Resolve the .cjs from this script's directory so the check follows the
  // checkout it lives in, not the caller's cwd.
  const require = createRequire(path.join(here(), 'check-ecosystem.ts'));
  const config = require('../ecosystem.config.cjs') as { apps?: EcosystemApp[] };
  const apps = Array.isArray(config?.apps) ? config.apps : [];

  for (const name of V4_NAMES) {
    const app = apps.find((candidate) => candidate.name === name);
    if (!app) {
      failures.push(`${name}: missing from ecosystem apps`);
      continue;
    }
    const cwd = app.cwd ?? '';
    if (!fs.existsSync(cwd)) {
      failures.push(`${name}: cwd does not exist: ${cwd}`);
      continue;
    }
    const scriptPath = path.join(cwd, app.script ?? '');
    if (!fs.existsSync(scriptPath)) {
      failures.push(`${name}: script does not exist: ${scriptPath}`);
    }
  }

  const configText = fs.readFileSync(ANALYST_CONFIG_PATH, 'utf8');
  const keys = new Set<string>();
  for (const match of configText.matchAll(/(?:optionalString|optionalPositiveInt)\(\s*env,\s*'([A-Za-z0-9_]+)'/g)) {
    keys.add(match[1]);
  }
  for (const match of configText.matchAll(/env\['([A-Za-z0-9_]+)'\]/g)) {
    keys.add(match[1]);
  }
  const analystKeys = [...keys].filter((key) => !ANALYST_SECRET_KEYS.includes(key)).sort();

  if (analystKeys.length === 0) {
    failures.push('packages/analyst/src/config.ts: no optional config keys extracted');
  }

  const analystApp = apps.find((candidate) => candidate.name === ANALYST_NAME);
  if (analystApp) {
    const analystEnv = analystApp.env ?? {};
    for (const key of analystKeys) {
      if (analystEnv[key] === undefined) {
        failures.push(`${ANALYST_NAME} env: missing ${key}`);
      }
    }
    if (analystEnv['ANALYST_ENABLED'] === undefined) {
      failures.push(`${ANALYST_NAME} env: missing ANALYST_ENABLED`);
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`ecosystem check failed: ${failure}`);
    process.exit(1);
  }

  console.log(`ecosystem check ok: ${apps.length} apps, analyst keys: ${analystKeys.join(', ')}`);
}

main();