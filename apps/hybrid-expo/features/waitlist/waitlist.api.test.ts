import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWaitlistRequest,
  joinWaitlist,
  validateEmail,
  validateXHandle,
} from './waitlist.api';

test('email validation trims, lowercases and rejects malformed addresses', () => {
  assert.equal(validateEmail('  A@B.co '), true);
  for (const bad of ['', 'a', 'a@b', '@b.co', 'a b@c.co', 'a@b .co']) {
    assert.equal(validateEmail(bad), false, bad);
  }
});

test('X handle is optional, drops one leading @, and follows X rules', () => {
  assert.equal(validateXHandle(''), true);
  assert.equal(validateXHandle('  '), true);
  assert.equal(validateXHandle('@bivhu_'), true);
  assert.equal(validateXHandle('a'.repeat(15)), true);
  assert.equal(validateXHandle('a'.repeat(16)), false);
  assert.equal(validateXHandle('bad-handle'), false);
  assert.equal(validateXHandle('@@x'), false);
});

test('request body matches the contract and omits an empty handle', () => {
  assert.deepEqual(buildWaitlistRequest(' Me@X.io ', '@bivhu_'), {
    email: 'me@x.io', xHandle: 'bivhu_', source: 'app-v1.0.5',
  });
  assert.deepEqual(buildWaitlistRequest('me@x.io', ''), { email: 'me@x.io', source: 'app-v1.0.5' });
});

function mockFetch(status: number, body: unknown, calls: { url: string; init?: RequestInit }[] = []) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as never;
}

test('201 (new or repeat email) is success and posts to {API_BASE}/waitlist', async () => {
  const original = process.env.EXPO_PUBLIC_API_BASE_URL;
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test/';
  const calls: { url: string; init?: RequestInit }[] = [];
  try {
    assert.deepEqual(await joinWaitlist('a@b.co', 'x_1', mockFetch(201, { ok: true }, calls)), { ok: true });
    assert.equal(calls[0].url, 'https://api.example.test/waitlist');
    assert.equal(calls[0].init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { email: 'a@b.co', xHandle: 'x_1', source: 'app-v1.0.5' });
  } finally {
    if (original === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
    else process.env.EXPO_PUBLIC_API_BASE_URL = original;
  }
});

test('server errors map to the contract codes', async () => {
  assert.deepEqual(await joinWaitlist('a@b.co', '', mockFetch(400, { error: 'invalid_email' })), { ok: false, code: 'invalid_email' });
  assert.deepEqual(await joinWaitlist('a@b.co', 'x', mockFetch(400, { error: 'invalid_x_handle' })), { ok: false, code: 'invalid_x_handle' });
  assert.deepEqual(await joinWaitlist('a@b.co', '', mockFetch(429, { error: 'rate_limited' })), { ok: false, code: 'rate_limited' });
  assert.deepEqual(await joinWaitlist('a@b.co', '', mockFetch(500, {})), { ok: false, code: 'server_error' });
});

test('network failure is reported as offline', async () => {
  const failing = (async () => { throw new TypeError('Network request failed'); }) as never;
  assert.deepEqual(await joinWaitlist('a@b.co', '', failing), { ok: false, code: 'offline' });
});

test('invalid input never hits the network', async () => {
  const calls: { url: string }[] = [];
  assert.deepEqual(await joinWaitlist('nope', '', mockFetch(201, {}, calls)), { ok: false, code: 'invalid_email' });
  assert.deepEqual(await joinWaitlist('a@b.co', 'bad-handle', mockFetch(201, {}, calls)), { ok: false, code: 'invalid_x_handle' });
  assert.equal(calls.length, 0);
});
