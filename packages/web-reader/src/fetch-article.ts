/**
 * #582 plain HTTP GET for article pages: one page, no browser. Manual redirect
 * hops (capped), a per-hop timeout, a byte cap and a light public-host guard.
 * Like collectors' safe-public-http this never follows a redirect blindly, but
 * it is name/IP-literal containment only — DNS-rebinding pinning stays out of
 * scope for this worker (bounded best-effort reader, not a research tool).
 */
import { isIP } from 'node:net';

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;

export const USER_AGENT = 'myboon-web-reader/0.1 (+https://myboon.app)';

export interface FetchedPage {
  /** Final URL after redirects. */
  url: string;
  status: number;
  contentType: string | null;
  /** Decoded response body, capped at maxBytes. */
  text: string;
}

export type FetchPageResult =
  | { ok: true; page: FetchedPage }
  | { ok: false; reason: string };

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export interface FetchPageOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Test seam; defaults to global fetch. */
  fetchImpl?: FetchImpl;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal'];

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const value = ip.toLowerCase();
  if (value === '::' || value === '::1') return true;
  return /^f[cd]/.test(value) || /^fe[89ab]/.test(value); // fc00::/7 ULA, fe80::/10 link-local
}

/** IPv4-mapped literals after '::ffff:' — WHATWG URL serializes them in hex (::ffff:a00:1). */
function isPrivateIPv4Mapped(tail: string): boolean {
  const groups = tail.split(':');
  const asHexPairs = (parts: string[]): number[] | null => {
    const hi = Number.parseInt(parts[0], 16);
    const lo = Number.parseInt(parts[1], 16);
    if (Number.isNaN(hi) || Number.isNaN(lo) || hi > 0xffff || lo > 0xffff) return null;
    return [hi >> 8, hi & 255, lo >> 8, lo & 255];
  };
  let bytes: number[] | null = null;
  if (groups.length === 2) {
    bytes = asHexPairs(groups);
  } else if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) {
    bytes = tail.split('.').map(Number);
  }
  if (!bytes || bytes.length !== 4 || bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
    return isPrivateIPv6(tail);
  }
  return isPrivateIPv4(bytes.join('.'));
}

/** Light public-host guard: localhost names and private IP literals only. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^\[(.*)\]$/, '$1');
  if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  const family = isIP(host);
  if (family === 4) return isPrivateIPv4(host);
  if (family === 6) {
    // IPv4-mapped literals (::ffff:10.0.0.1) reuse the IPv4 ranges.
    if (host.startsWith('::ffff:')) return isPrivateIPv4Mapped(host.slice('::ffff:'.length));
    return isPrivateIPv6(host);
  }
  return false;
}

function assertPublicHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('invalid url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported url scheme');
  if (url.username || url.password) throw new Error('url must not include credentials');
  if (isPrivateHost(url.hostname)) throw new Error('url host is not public');
  return url;
}

export function mediaTypeOf(contentType: string | null | undefined): string | null {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? null;
}

/** Textual responses only; a missing content type is allowed and sniffed at extraction. */
function isTextual(contentType: string | null): boolean {
  const media = mediaTypeOf(contentType);
  if (media === null) return true;
  return media.startsWith('text/')
    || media === 'application/xhtml+xml'
    || media === 'application/xml';
}

function fail(reason: string): FetchPageResult {
  return { ok: false, reason };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Rejects the race when the impl ignores the abort signal; the abort still reaches a real fetch. */
function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  let settled = false;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (!settled) {
        controller.abort();
        reject(new Error(`timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    timer.unref();
  });
  const work = run(controller.signal);
  work.catch(() => { /* if the timeout wins the race, swallow this branch's late rejection */ });
  return Promise.race([work, timeoutPromise]).finally(() => {
    settled = true;
    if (timer) clearTimeout(timer);
  });
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers?.get('content-length') ?? NaN);
  if (Number.isInteger(declared) && declared > maxBytes) {
    throw new Error(`response exceeded ${maxBytes} bytes`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* cancel failure must not mask the size error */ }
        throw new Error(`response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } else {
    const bytes = new TextEncoder().encode(await response.text());
    if (bytes.byteLength > maxBytes) throw new Error(`response exceeded ${maxBytes} bytes`);
    chunks.push(bytes);
    total = bytes.byteLength;
  }
  const concatenated = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    concatenated.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(concatenated);
}

/**
 * Fetch one page. Never throws: failures come back as { ok: false, reason } so
 * the caller can fall through to the Hermes path.
 */
export async function fetchPage(rawUrl: string, o: FetchPageOptions = {}): Promise<FetchPageResult> {
  const timeoutMs = o.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxBytes = o.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = o.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const fetchImpl = o.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init));
  try {
    let url = assertPublicHttpUrl(rawUrl).toString();
    let redirects = 0;
    while (true) {
      const response = await withTimeout(
        (signal) => fetchImpl(url, {
          redirect: 'manual',
          signal,
          headers: {
            'user-agent': USER_AGENT,
            accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
          },
        }),
        timeoutMs,
      );
      const contentType = response.headers?.get('content-type') ?? null;
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers?.get('location');
        if (!location) return fail(`redirect ${response.status} without location`);
        redirects += 1;
        if (redirects > maxRedirects) return fail(`too many redirects (>${maxRedirects})`);
        url = assertPublicHttpUrl(new URL(location, url).toString()).toString();
        continue;
      }
      if (response.status < 200 || response.status >= 300) return fail(`http ${response.status}`);
      if (!isTextual(contentType)) return fail(`unsupported content type ${mediaTypeOf(contentType) ?? '(none)'}`);
      const text = await readCapped(response, maxBytes);
      return { ok: true, page: { url, status: response.status, contentType, text } };
    }
  } catch (error) {
    return fail(errorMessage(error));
  }
}
