/**
 * Create a named LOCAL database and apply the atlas schema to it (CI's scout_test).
 * Usage: tsx packages/atlas-schema/scripts/prepare-db.ts <admin-url> <db-name>
 * Refuses non-local hosts. Fails if the database already exists.
 */
import pg from 'pg';
import { applyAtlasSchema, assertLocalUrl, ensureSupabaseRoles } from '../src/index.js';

const [adminUrl, name] = process.argv.slice(2);
if (!adminUrl || !name || !/^[a-z_][a-z0-9_]*$/.test(name)) {
  console.error('usage: prepare-db.ts <admin-url> <db-name>');
  process.exit(2);
}
assertLocalUrl(adminUrl);
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
try {
  await ensureSupabaseRoles(admin);
  await admin.query(`create database ${name}`);
} finally {
  await admin.end();
}
const u = new URL(adminUrl);
u.pathname = `/${name}`;
await applyAtlasSchema(u.toString());
console.log(`prepared ${name}`);
