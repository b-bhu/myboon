import { describe, expect, test } from 'vitest';

import { fetchPage, isPrivateHost, type FetchImpl } from './fetch-article.js';

function htmlResponse(html: string, init: ResponseInit = {}): Response {
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...init.headers } });
}

/** A fetch stub that replays one response per hop and records the requested urls. */
function sequenceFetch(...responses: Response[]): FetchImpl & { urls: string[] } {
  const urls: string[] = [];
  let at = 0;
  const stub = ((url: string, _init: RequestInit) => {
    urls.push(url);
    const response = responses[Math.min(at, responses.length - 1)];
    at += 1;
    return Promise.resolve(response);
  }) as FetchImpl;
  const stubWithUrls = stub as FetchImpl & { urls: string[] };
  stubWithUrls.urls = urls;
  return stubWithUrls;
}

describe('fetchPage (#582)', () => {
  test('success: html page comes back with the final url and capped text', async () => {
    const impl = sequenceFetch(htmlResponse('<html><body>hi</body></html>'));
    const result = await fetchPage('https://example.test/a', { fetchImpl: impl });
    expect(result).toEqual({
      ok: true,
      page: { url: 'https://example.test/a', status: 200, contentType: 'text/html; charset=utf-8', text: '<html><body>hi</body></html>' },
    });
  });

  test('follows redirects one hop at a time, checking each target', async () => {
    const impl = sequenceFetch(
      new Response(null, { status: 302, headers: { location: 'https://example.test/b' } }),
      htmlResponse('final page'),
    );
    const result = await fetchPage('https://example.test/a', { fetchImpl: impl });
    expect(result.ok).toBe(true);
    expect(impl.urls).toEqual(['https://example.test/a', 'https://example.test/b']);
    expect(result.ok && result.page.url).toBe('https://example.test/b');
  });

  test('caps redirect hops', async () => {
    const redirect = () => new Response(null, { status: 301, headers: { location: 'https://example.test/next' } });
    const impl = sequenceFetch(redirect(), redirect(), redirect());
    const result = await fetchPage('https://example.test/a', { maxRedirects: 2, fetchImpl: impl });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('redirect');
  });

  test('http failures come back as plain fail (never throw)', async () => {
    const result = await fetchPage('https://example.test/dead', {
      fetchImpl: sequenceFetch(new Response('gone', { status: 404 })),
    });
    expect(result).toMatchObject({ ok: false, reason: 'http 404' });
  });

  test('a redirect hop to a private host is rejected', async () => {
    const impl = sequenceFetch(new Response(null, { status: 301, headers: { location: 'http://169.254.169.254/meta' } }));
    const result = await fetchPage('https://example.test/a', { fetchImpl: impl });
    expect(result).toMatchObject({ ok: false, reason: 'url host is not public' });
  });

  test('private hosts, loopback and credentials are rejected up front', async () => {
    for (const url of [
      'http://localhost/x',
      'http://sub.localhost/x',
      'http://127.0.0.1/x',
      'http://10.1.2.3/x',
      'http://192.168.0.5/x',
      'http://172.16.9.9/x',
      'http://[::1]/x',
      'http://[fd00::1]/x',
      'http://[::ffff:10.0.0.1]/x',
      'http://user:pw@example.test/x',
      'ftp://example.test/x',
    ]) {
      const result = await fetchPage(url, { fetchImpl: sequenceFetch(htmlResponse('x')) });
      expect(result.ok, url).toBe(false);
    }
  });

  test('non-textual content types fail', async () => {
    const impl = sequenceFetch(new Response('binary', { status: 200, headers: { 'content-type': 'image/png' } }));
    const result = await fetchPage('https://example.test/a', { fetchImpl: impl });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('content type');
  });

  test('response bodies are capped', async () => {
    const big = 'x'.repeat(3000);
    const impl = sequenceFetch(htmlResponse(big));
    const result = await fetchPage('https://example.test/a', { maxBytes: 1000, fetchImpl: impl });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('bytes');
  });

  test('an impl that ignores the abort signal still times out', async () => {
    const neverSettles: FetchImpl = () => new Promise<Response>(() => undefined);
    const result = await fetchPage('https://example.test/slow', { timeoutMs: 100, fetchImpl: neverSettles });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('timed out');
  });

  test('unparseable urls fail safely', async () => {
    const result = await fetchPage('::: not a url', { fetchImpl: sequenceFetch(htmlResponse('x')) });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('invalid url');
  });
});

describe('isPrivateHost', () => {
  test('blocks local names and private ranges', () => {
    expect(isPrivateHost('localhost')).toBe(true);
    expect(isPrivateHost('ws.local')).toBe(true);
    expect(isPrivateHost('10.0.0.1')).toBe(true);
    expect(isPrivateHost('127.0.0.1')).toBe(true);
    expect(isPrivateHost('192.168.1.1')).toBe(true);
    expect(isPrivateHost('172.31.0.1')).toBe(true);
    expect(isPrivateHost('169.254.169.254')).toBe(true);
    expect(isPrivateHost('fe80::1')).toBe(true);
    expect(isPrivateHost('::1')).toBe(true);
  });

  test('public hosts pass', () => {
    expect(isPrivateHost('example.test')).toBe(false);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('2606:4700::6810:85e3')).toBe(false);
  });
});
