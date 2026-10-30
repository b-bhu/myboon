/**
 * #391 the analyst pool must trust the Supabase root CA with full TLS
 * verification. node-pg treats an URL `sslmode` as a fallback that replaces the
 * `ssl` object, so any `ssl*` search param is stripped from the URL and the
 * verification settings are supplied only here — `rejectUnauthorized` is never
 * turned off, and local hosts connect without TLS.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Bundled public Supabase Root 2021 CA, next to this package. */
export const SUPABASE_ROOT_CA_PATH = fileURLToPath(new URL('../certs/supabase-prod-ca-2021.crt', import.meta.url));

/**
 * The PEM the analyst pool trusts: `ANALYST_DATABASE_CA_FILE` when set,
 * otherwise the bundled Supabase root CA. Read errors name the env var without
 * echoing the path or file contents; non-PEM files are rejected.
 */
export function loadAnalystDatabaseCa(env: Record<string, string | undefined>): string {
  const path = env.ANALYST_DATABASE_CA_FILE?.trim() || SUPABASE_ROOT_CA_PATH;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`ANALYST_DATABASE_CA_FILE could not be read: ${(e as Error).message}`);
  }
  if (!text.includes('-----BEGIN CERTIFICATE-----') || !text.includes('-----END CERTIFICATE-----')) {
    throw new Error('ANALYST_DATABASE_CA_FILE does not contain a PEM certificate (-----BEGIN/END CERTIFICATE-----)');
  }
  return text;
}

// Hosts where TLS is skipped: loopback and an empty host.
const LOCAL_HOSTS = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Pool options for the analyst: the URL minus every `ssl*` search param (they
 * would replace the `ssl` object) plus explicit TLS — full verification against
 * the given CA for remote hosts, no TLS for local ones.
 */
export function analystPoolConfig(databaseUrl: string, ca: string): { connectionString: string; ssl: false | { rejectUnauthorized: true; ca: string } } {
  const url = new URL(databaseUrl);
  for (const key of [...new Set([...url.searchParams.keys()].filter((k) => /^ssl/i.test(k)))]) {
    url.searchParams.delete(key);
  }
  return {
    connectionString: url.toString(),
    ssl: LOCAL_HOSTS.has(url.hostname) ? false : { rejectUnauthorized: true, ca },
  };
}