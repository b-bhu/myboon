/**
 * #391 PM2 ecosystem guard for the gated V4 apps.
 *
 * Verifies, with MYBOON_V4_RUNTIME_ENABLED=1 forced on:
 *  - the gated V4 apps (myboon-scout, myboon-analyst, myboon-entity-manager,
 *    myboon-entity-manager-retry, myboon-web-reader, myboon-latest-updates)
 *    are registered, with their cwd and entry points present on disk;
 *  - the myboon-analyst env block covers every non-secret config key that
 *    packages/analyst/src/config.ts reads optionally, plus ANALYST_ENABLED;
 *  - the myboon-entity-manager env block declares ENTITY_MANAGER_ENABLED (#593).
 *  - the myboon-latest-updates env block declares LATEST_UPDATES_ENABLED (#634).
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

const V4_NAMES = [
  'myboon-scout',
  'myboon-analyst',
  'myboon-entity-manager',
  'myboon-entity-manager-retry',
  'myboon-web-reader',
  'myboon-latest-updates',
];
const ANALYST_NAME = 'myboon-analyst';
const ENTITY_MANAGER_NAME = 'myboon-entity-manager';
const LATEST_UPDATES_NAME = 'myboon-latest-updates';
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

  // #593 the entity manager: the gate flag must be declared in the tracked
  // env (same style as the ANALYST_ENABLED check). Secrets stay out of this file.
  const entityManagerApp = apps.find((candidate) => candidate.name === ENTITY_MANAGER_NAME);
  if (entityManagerApp) {
    const entityManagerEnv = entityManagerApp.env ?? {};
    if (entityManagerEnv['ENTITY_MANAGER_ENABLED'] === undefined) {
      failures.push(`${ENTITY_MANAGER_NAME} env: missing ENTITY_MANAGER_ENABLED`);
    }
  }

  // #634 latest updates: the gate flag must be declared in the tracked env
  // (same style as the ENTITY_MANAGER_ENABLED check). Secrets stay out of this file.
  const latestUpdatesApp = apps.find((candidate) => candidate.name === LATEST_UPDATES_NAME);
  if (latestUpdatesApp) {
    const latestUpdatesEnv = latestUpdatesApp.env ?? {};
    if (latestUpdatesEnv['LATEST_UPDATES_ENABLED'] === undefined) {
      failures.push(`${LATEST_UPDATES_NAME} env: missing LATEST_UPDATES_ENABLED`);
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`ecosystem check failed: ${failure}`);
    process.exit(1);
  }

  console.log(`ecosystem check ok: ${apps.length} apps, analyst keys: ${analystKeys.join(', ')}`);
}

main();