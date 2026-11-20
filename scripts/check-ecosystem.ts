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
 *  - #695: ENTITY_MANAGER_MARKETS_ENABLED (myboon-entity-manager) and
 *    STORIES_SOURCE (myboon-api) are persisted in the tracked env, keep their
 *    defaults ('true' / 'atlas') when the shell is silent, and follow the
 *    shell when it sets them — checked by clearing the require cache and
 *    re-requiring the file.
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
const API_NAME = 'myboon-api';
// #695 the two flags this guard must keep persisted in the tracked env.
const MARKETS_FLAG_KEY = 'ENTITY_MANAGER_MARKETS_ENABLED';
const STORIES_SOURCE_KEY = 'STORIES_SOURCE';
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
    // #695: the markets pass must survive a tracked-file restart, so the key is
    // declared here with a process.env fallback (see the persistence checks below).
    if (entityManagerEnv[MARKETS_FLAG_KEY] === undefined) {
      failures.push(`${ENTITY_MANAGER_NAME} env: missing ${MARKETS_FLAG_KEY}`);
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

  // #695: /stories keeps its atlas source across a tracked-file restart only if
  // the key is declared in the api env block (secrets stay out of this file).
  const apiApp = apps.find((candidate) => candidate.name === API_NAME);
  if (apiApp) {
    const apiEnv = apiApp.env ?? {};
    if (apiEnv[STORIES_SOURCE_KEY] === undefined) {
      failures.push(`${API_NAME} env: missing ${STORIES_SOURCE_KEY}`);
    }
  }

  // #695 persistence values: clear the require cache and re-require the file
  // twice — once with both keys unset in the shell (the blocks must keep their
  // safe defaults) and once with each key overridden (the blocks must follow
  // the override so `pm2 restart --update-env` can still switch them).
  // Failure lines name keys only; no environment values are printed.
  const appsOf = (reloaded: { apps?: EcosystemApp[] }): EcosystemApp[] =>
    Array.isArray(reloaded?.apps) ? reloaded.apps : [];
  const envOf = (apps: EcosystemApp[], name: string): Record<string, string | undefined> =>
    apps.find((candidate) => candidate.name === name)?.env ?? {};
  const reloadEcosystem = (): EcosystemApp[] => {
    delete require.cache[require.resolve('../ecosystem.config.cjs')];
    return appsOf(require('../ecosystem.config.cjs') as { apps?: EcosystemApp[] });
  };

  delete process.env[MARKETS_FLAG_KEY];
  delete process.env[STORIES_SOURCE_KEY];
  const defaultApps = reloadEcosystem();
  if (envOf(defaultApps, ENTITY_MANAGER_NAME)[MARKETS_FLAG_KEY] !== 'true') {
    failures.push(`${ENTITY_MANAGER_NAME} env: ${MARKETS_FLAG_KEY} must default to 'true' when the shell does not set it`);
  }
  if (envOf(defaultApps, API_NAME)[STORIES_SOURCE_KEY] !== 'atlas') {
    failures.push(`${API_NAME} env: ${STORIES_SOURCE_KEY} must default to 'atlas' when the shell does not set it`);
  }

  process.env[MARKETS_FLAG_KEY] = 'false';
  process.env[STORIES_SOURCE_KEY] = 'legacy';
  const overrideApps = reloadEcosystem();
  if (envOf(overrideApps, ENTITY_MANAGER_NAME)[MARKETS_FLAG_KEY] !== 'false') {
    failures.push(`${ENTITY_MANAGER_NAME} env: ${MARKETS_FLAG_KEY} must follow the shell override`);
  }
  if (envOf(overrideApps, API_NAME)[STORIES_SOURCE_KEY] !== 'legacy') {
    failures.push(`${API_NAME} env: ${STORIES_SOURCE_KEY} must follow the shell override`);
  }

  // Leave the process clean: both keys unset, file re-required on a clear cache.
  delete process.env[MARKETS_FLAG_KEY];
  delete process.env[STORIES_SOURCE_KEY];
  reloadEcosystem();

  if (failures.length > 0) {
    for (const failure of failures) console.error(`ecosystem check failed: ${failure}`);
    process.exit(1);
  }

  console.log(`ecosystem check ok: ${apps.length} apps, analyst keys: ${analystKeys.join(', ')}`);
}

main();