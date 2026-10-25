// Read-only atlas search for the #442 analyst eval, over Supabase/PostgREST.
// GET only (no POST/PATCH/DELETE/rpc): /rest/v1/shelves and /rest/v1/items with the
// atlas profile. The service-role key is read from env and never echoed.

export interface AtlasShelf {
  id: string;
  slug: string;
  name: string | null;
  type: string | null;
  aliases: string[] | null;
  summary: string | null;
}

export interface AtlasItem {
  id: string;
  item_key: string;
  title: string | null;
  summary: string | null;
  main_shelf_id: string | null;
}

export interface AtlasShelfRef {
  id: string;
  slug: string;
}

export interface AtlasSearchResult {
  shelves: AtlasShelf[];
  items: AtlasItem[];
}

export interface AtlasEnv {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  /** Index signature so Node's process.env is directly assignable under strict typings. */
  [key: string]: string | undefined;
}

export interface AtlasFetchOptions {
  fetchImpl?: typeof fetch;
  env?: AtlasEnv;
}

const SHELF_COLUMNS = 'id,slug,name,type,aliases,summary';
const ITEM_COLUMNS = 'id,item_key,title,summary,main_shelf_id';
const ROW_LIMIT = 8;

/** Strips PostgREST filter syntax characters so a query cannot break the request. */
export function sanitizeAtlasQuery(raw: string): string {
  return raw.replace(/[,()*"{}\\]/g, '').trim();
}

function atlasClient(env: AtlasEnv): { baseUrl: string; serviceRoleKey: string } {
  const baseUrl = env.SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!baseUrl || !serviceRoleKey) {
    throw new Error('search_atlas: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment');
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), serviceRoleKey };
}

function atlasHeaders(serviceRoleKey: string): Record<string, string> {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Accept-Profile': 'atlas',
  };
}

async function atlasGet<T>(path: string, url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    throw new Error(`search_atlas: GET ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      // body unreadable; status alone is enough
    }
    throw new Error(`search_atlas: GET ${path} -> HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new Error(`search_atlas: GET ${path} returned non-JSON body: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function orExpr(query: string, columns: string[], withAliases: boolean): string {
  const clauses = columns.map((col) => `${col}.ilike.*${query}*`);
  if (withAliases) clauses.push(`aliases.cs.{"${query}"}`);
  return `(${clauses.join(',')})`;
}

function asRows<T>(body: unknown): T[] {
  return Array.isArray(body) ? (body as T[]) : [];
}

function buildUrl(baseUrl: string, table: 'shelves' | 'items', values: Record<string, string>): string {
  const params = new URLSearchParams(values);
  return `${baseUrl}/rest/v1/${table}?${params}`;
}

/** Full-text-ish search over atlas shelves and items. Two GETs per call, in parallel. */
export async function searchAtlas(query: string, opts: AtlasFetchOptions = {}): Promise<AtlasSearchResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const q = sanitizeAtlasQuery(query);
  if (q === '') return { shelves: [], items: [] };
  const { baseUrl, serviceRoleKey } = atlasClient(opts.env ?? process.env);
  const init: RequestInit = { method: 'GET', headers: atlasHeaders(serviceRoleKey) };

  const shelvesUrl = buildUrl(baseUrl, 'shelves', {
    select: SHELF_COLUMNS,
    or: orExpr(q, ['name', 'slug'], true),
    limit: String(ROW_LIMIT),
  });
  const itemsUrl = buildUrl(baseUrl, 'items', {
    select: ITEM_COLUMNS,
    or: orExpr(q, ['title', 'summary'], false),
    limit: String(ROW_LIMIT),
  });

  const [shelvesBody, itemsBody] = await Promise.all([
    atlasGet<unknown>('shelves', shelvesUrl, init, fetchImpl),
    atlasGet<unknown>('items', itemsUrl, init, fetchImpl),
  ]);
  return { shelves: asRows<AtlasShelf>(shelvesBody), items: asRows<AtlasItem>(itemsBody) };
}

/** Resolves shelf ids to {id, slug} for the scorer; empty input makes no request. */
export async function getShelvesByIds(ids: readonly string[], opts: AtlasFetchOptions = {}): Promise<AtlasShelfRef[]> {
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (unique.length === 0) return [];
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const { baseUrl, serviceRoleKey } = atlasClient(opts.env ?? process.env);
  const url = buildUrl(baseUrl, 'shelves', {
    select: 'id,slug',
    id: `in.(${unique.join(',')})`,
  });
  const init: RequestInit = { method: 'GET', headers: atlasHeaders(serviceRoleKey) };
  const body = await atlasGet<unknown>('shelves', url, init, fetchImpl);
  return asRows<AtlasShelfRef>(body);
}