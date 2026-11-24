import { asRecord, parseNonNegativeInteger, parseNullableInt } from './parse.js'
import { mergePhoenixTraderState } from './triggers.js'
import { upstreamErrorPayload, upstreamProxyStatusCode } from './upstream.js'
import type { PhoenixUpstream } from './upstream.js'

async function getPhoenixTraderStateV1(upstream: PhoenixUpstream, authority: string, traderPdaIndex: number): Promise<unknown | null> {
  try {
    return await upstream.fetchJson<unknown>(
      `/v1/trader/state/${encodeURIComponent(authority)}?traderPdaIndex=${traderPdaIndex}`,
    )
  } catch (err) {
    console.warn(`[api] Phoenix v1 trader state ${authority} unavailable:`, err instanceof Error ? err.message : err)
    return null
  }
}

export type PhoenixTraderStatePayload = {
  venueId: 'phoenix'
  action: 'get_trader_state'
  authority: string
  pdaIndex: number
  slot: number | null
  slotIndex: number | null
  traders: unknown[]
  triggerSource: 'v1' | 'legacy'
  raw: { legacy: unknown; v1: unknown }
}

export type PhoenixTraderStateResponse =
  | { status: 200; body: PhoenixTraderStatePayload }
  | { status: 400 | 404 | 409 | 422 | 429 | 502 | 504; body: { error: string; code?: string; upstreamStatus?: number } }

// Serves GET /perps/phoenix/trader/:authority/state?pdaIndex=0 and lets the wallet summary call the same
// logic directly. Returns exactly the status + JSON body the route used to build inline, error mapping unchanged.
export async function getPhoenixTraderState(
  upstream: PhoenixUpstream,
  authority: string | null | undefined,
  pdaIndexQuery: string | null | undefined,
): Promise<PhoenixTraderStateResponse> {
  if (!authority) return { status: 400, body: { error: 'Missing or invalid authority' } }

  const pdaIndex = parseNonNegativeInteger(pdaIndexQuery ?? '0')
  if (pdaIndex === null) {
    return { status: 400, body: { error: 'Invalid pdaIndex', code: 'INVALID_PDA_INDEX' } }
  }

  const params = new URLSearchParams({ pdaIndex: String(pdaIndex) })
  try {
    const [raw, v1Raw] = await Promise.all([
      upstream.fetchJson<unknown>(`/trader/${encodeURIComponent(authority)}/state?${params.toString()}`),
      getPhoenixTraderStateV1(upstream, authority, pdaIndex),
    ])
    const rawRecord = asRecord(raw)
    const v1Record = asRecord(v1Raw)
    const merged = mergePhoenixTraderState(raw, v1Raw)
    return {
      status: 200,
      body: {
        venueId: 'phoenix',
        action: 'get_trader_state',
        authority,
        pdaIndex,
        slot: parseNullableInt(v1Record?.slot) ?? parseNullableInt(rawRecord?.slot),
        slotIndex: parseNullableInt(v1Record?.slotIndex) ?? parseNullableInt(rawRecord?.slotIndex),
        traders: merged.traders,
        triggerSource: merged.triggerSource,
        raw: {
          legacy: raw,
          v1: v1Raw,
        },
      },
    }
  } catch (err) {
    console.error(`[api] Phoenix trader state ${authority} unavailable:`, err instanceof Error ? err.message : err)
    return {
      status: upstreamProxyStatusCode(err),
      body: upstreamErrorPayload(err, 'Phoenix trader state unavailable'),
    }
  }
}
