const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { runInNewContext } = require('node:vm');

const source = readFileSync(join(__dirname, 'verify-production-endpoints.mjs'), 'utf8');
function run(baseUrl, lines) {
  return runInNewContext(source, {
    process: { env: { RELEASE_API_BASE_URL: baseUrl } }, URL, AbortController, setTimeout, clearTimeout,
    console: { log: (...items) => lines.push(items.join(' ')), error: (...items) => lines.push(items.join(' ')) },
    // Fail the first read safely; this test never reaches a network or server.
    fetch: async () => ({ ok: false, status: 503, text: async () => '{}' }),
  });
}

test('release endpoint validation omits credentials from URL errors', () => {
  for (const url of [
    'https://user:fixture-sensitive-value@example.test',
    'https://example.test/?api-key=fixture-sensitive-value',
    'invalid-fixture-sensitive-value',
  ]) {
    assert.throws(() => run(url, []), (error) => {
      assert.equal(error.message.includes('fixture-sensitive-value'), false);
      return true;
    });
  }
});

test('release check logs only the origin when the API has a path prefix', async () => {
  const lines = [];
  await run('https://example.test/fixture-sensitive-value', lines);
  assert.ok(lines.some((line) => line.includes('https://example.test')));
  assert.equal(lines.join('\n').includes('fixture-sensitive-value'), false);
});
