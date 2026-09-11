const DEFAULT_API_BASE_URL = 'https://api.myboon.tech';
const REQUEST_TIMEOUT_MS = 20_000;

function productionApiBaseUrl() {
  const value = (process.env.RELEASE_API_BASE_URL ?? DEFAULT_API_BASE_URL).trim();
  const parsed = new URL(value);
  const hostname = parsed.hostname.toLowerCase();
  const localHostnames = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

  if (parsed.protocol !== 'https:' || localHostnames.has(hostname)) {
    throw new Error(`Release API must be a public HTTPS endpoint, received ${value}`);
  }

  return value.replace(/\/$/, '');
}

const API_BASE_URL = productionApiBaseUrl();

async function request(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function check(label, run) {
  try {
    const result = await run();
    console.log(`✓ ${label}`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✗ ${label} — ${message}`);
    throw error;
  }
}

async function run() {
  console.log(`Production endpoint check → ${API_BASE_URL}\n`);

  await check('API health', async () => {
    const body = await request('/health');
    assert(body?.status === 'ok', 'expected { status: "ok" }');
  });

  const narratives = await check('Feed narratives', async () => {
    const body = await request('/narratives?limit=1&offset=0');
    assert(Array.isArray(body), 'expected an array');
    return body;
  });
  if (narratives.length > 0) {
    await check('Narrative detail', async () => {
      const updateKey = narratives[0]?.updateKey;
      assert(typeof updateKey === 'string' && updateKey.length > 0, 'missing updateKey');
      await request(`/narratives/${encodeURIComponent(updateKey)}`);
    });
  }

  const storyPayload = await check('Developing stories', async () => {
    const body = await request('/stories');
    assert(Array.isArray(body?.stories), 'expected a stories array');
    return body;
  });
  if (storyPayload.stories.length > 0) {
    await check('Story timeline', async () => {
      const storySlug = storyPayload.stories[0]?.storySlug;
      assert(typeof storySlug === 'string' && storySlug.length > 0, 'missing storySlug');
      const body = await request(`/stories/${encodeURIComponent(storySlug)}?limit=1&offset=0`);
      assert(body?.story && Array.isArray(body?.events), 'expected story and events');
    });
  }

  await check('Token identity catalog', async () => {
    const body = await request('/tokens/catalog');
    assert(body && typeof body === 'object' && body.identities, 'expected token identities');
  });

  await check('Spot and swap token discovery', async () => {
    const body = await request('/swap/tokens?limit=1');
    assert(Array.isArray(body?.items), 'expected an items array');
  });

  await check('Spot and swap token search', async () => {
    const body = await request('/swap/tokens/search?query=SOL');
    assert(Array.isArray(body?.items), 'expected an items array');
  });

  await check('Pacifica markets', async () => {
    const body = await request('/perps/pacifica/markets');
    assert(Array.isArray(body) && body.length > 0, 'expected live markets');
  });

  await check('Phoenix service health', async () => {
    const body = await request('/perps/phoenix/health');
    assert(body?.status === 'ok', 'Phoenix is not healthy');
  });

  await check('Phoenix markets', async () => {
    const body = await request('/perps/phoenix/markets');
    assert(Array.isArray(body) && body.length > 0, 'expected live markets');
  });

  await check('Phoenix BTC candles', async () => {
    const body = await request('/perps/phoenix/candles?symbol=BTC-PERP&interval=15m&count=5&enableExternalSource=true');
    const candles = Array.isArray(body) ? body : body?.data;
    assert(Array.isArray(candles) && candles.length > 0, 'expected candle data');
  });

  const markets = await check('Polymarket discovery', async () => {
    const body = await request('/polymarket/markets');
    assert(Array.isArray(body), 'expected a markets array');
    return body;
  });
  if (markets.length > 0) {
    await check('Polymarket detail', async () => {
      const slug = markets[0]?.slug;
      assert(typeof slug === 'string' && slug.length > 0, 'missing market slug');
      await request(`/polymarket/markets/${encodeURIComponent(slug)}`);
    });
  }

  await check('Polymarket sports', async () => {
    const body = await request('/polymarket/sports/epl');
    assert(Array.isArray(body), 'expected a sports array');
  });

  await check('Polymarket CLOB proxy', async () => {
    const body = await request('/clob/v2/health');
    assert(body?.ok === true, 'CLOB proxy is not healthy');
  });

  console.log('\nAll production read endpoints passed.');
}

run().catch(() => {
  process.exitCode = 1;
});
