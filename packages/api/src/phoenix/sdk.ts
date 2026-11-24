/** Phoenix SDK helpers: instruction serialization, order sides and flags, conditional-order builders (#831). */

import { Direction, OrderFlags, Side, StopLossOrderKind, baseUnitsToBaseLotsWithMarketParams, priceUsdToTicksWithMarketParams } from '@ellipsis-labs/rise'
import type { Authority, BaseLots, Symbol as PhoenixSymbol, TriggerOrderParams } from '@ellipsis-labs/rise'
import { asRecordLoose, asStringRaw } from './parse.js'
import type {
  PhoenixInstructionBuilderResult,
  PhoenixSdkClient,
} from './types.js'

export function sdkAuthority(input: string): Authority {
  return input as Authority
}

export function sdkSymbol(input: string): PhoenixSymbol {
  return input as PhoenixSymbol
}

export function roleIsSigner(role: unknown): boolean {
  return role === 2 || role === 3 || role === 'READONLY_SIGNER' || role === 'WRITABLE_SIGNER'
}

export function roleIsWritable(role: unknown): boolean {
  return role === 1 || role === 3 || role === 'WRITABLE' || role === 'WRITABLE_SIGNER'
}

export function serializeInstructionData(data: unknown): number[] {
  if (data instanceof Uint8Array) return Array.from(data)
  if (Array.isArray(data)) return data.map((value) => Number(value))
  if (data && typeof data === 'object' && 'length' in data) {
    return Array.from(data as ArrayLike<number>)
  }
  return []
}

export function serializeSdkInstruction(raw: unknown) {
  const ix = asRecordLoose(raw) ?? {}
  const accounts = Array.isArray(ix.accounts) ? ix.accounts : []
  return {
    programId: asStringRaw(ix.programAddress) ?? asStringRaw(ix.programId),
    keys: accounts.map((rawAccount) => {
      const account = asRecordLoose(rawAccount) ?? {}
      const role = account.role
      return {
        pubkey: asStringRaw(account.address) ?? asStringRaw(account.pubkey),
        isSigner: account.isSigner === true || roleIsSigner(role),
        isWritable: account.isWritable === true || roleIsWritable(role),
      }
    }),
    data: serializeInstructionData(ix.data),
  }
}

export function sdkInstructionsFromRaw(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw.map(serializeSdkInstruction)

  const rawRecord = asRecordLoose(raw)
  if (Array.isArray(rawRecord?.instructions)) {
    return rawRecord.instructions.map(serializeSdkInstruction)
  }
  if (rawRecord && (Array.isArray(rawRecord.accounts) || 'programAddress' in rawRecord || 'programId' in rawRecord)) {
    return [serializeSdkInstruction(raw)]
  }

  return []
}

export function sdkInstructionBuilderResponse(
  action: string,
  endpoint: string,
  raw: unknown,
): PhoenixInstructionBuilderResult {
  const rawRecord = asRecordLoose(raw)
  const instructions = sdkInstructionsFromRaw(raw)

  return {
    venueId: 'phoenix',
    action,
    mode: 'solana_instruction_builder',
    endpoint,
    instructions,
    raw: {
      instructionCount: instructions.length,
      named: rawRecord && asRecordLoose(rawRecord.named) ? Object.keys(asRecordLoose(rawRecord.named) ?? {}) : [],
    },
  }
}

export function sdkSideFromInput(input: unknown): Side | null {
  const normalized = String(input ?? '').trim().toLowerCase()
  if (normalized === 'long' || normalized === 'bid' || normalized === 'side.bid') return Side.Bid
  if (normalized === 'short' || normalized === 'ask' || normalized === 'side.ask') return Side.Ask
  return null
}

export function parseOrderFlag(input: unknown): OrderFlags {
  return input === true ? OrderFlags.ReduceOnly : OrderFlags.None
}

export function sdkPositionSideFromInput(input: unknown): 'long' | 'short' | null {
  const normalized = String(input ?? '').trim().toLowerCase()
  if (normalized === 'long' || normalized === 'bid') return 'long'
  if (normalized === 'short' || normalized === 'ask') return 'short'
  return null
}

export async function resolvePositionConditionalSize(
  client: PhoenixSdkClient,
  symbol: PhoenixSymbol,
  builder: {
    baseUnits: string | null
    sizeBaseLots: BaseLots | null
    sizePercent: number | null
  },
): Promise<{ sizeBaseLots: BaseLots | null; sizePercent: number | null }> {
  if (builder.sizeBaseLots !== null) {
    return { sizeBaseLots: builder.sizeBaseLots, sizePercent: null }
  }

  if (builder.baseUnits === null) {
    return { sizeBaseLots: null, sizePercent: builder.sizePercent }
  }

  await client.exchange.ready()
  const market = client.exchange.market(symbol)
  if (!market) throw new Error(`Unknown Phoenix market symbol '${symbol}'`)

  return {
    sizeBaseLots: baseUnitsToBaseLotsWithMarketParams(builder.baseUnits, {
      baseLotsDecimals: market.baseLotsDecimals,
    }),
    sizePercent: null,
  }
}

export async function positionConditionalTriggers(
  client: PhoenixSdkClient,
  symbol: PhoenixSymbol,
  positionSide: 'long' | 'short',
  takeProfitPriceUsd: string | null,
  stopLossPriceUsd: string | null,
): Promise<{
  greaterTriggerOrder: TriggerOrderParams | null
  lessTriggerOrder: TriggerOrderParams | null
}> {
  await client.exchange.ready()
  const market = client.exchange.market(symbol)
  if (!market) throw new Error(`Unknown Phoenix market symbol '${symbol}'`)

  const marketParams = {
    tickSize: market.tickSize,
    baseLotsDecimals: market.baseLotsDecimals,
  }
  const tradeSide = positionSide === 'long' ? Side.Ask : Side.Bid
  const buildTrigger = (direction: Direction, priceUsd: string): TriggerOrderParams => {
    const triggerPrice = priceUsdToTicksWithMarketParams(priceUsd, marketParams)
    const executionPriceUsd = iocExecutionPriceWithSlippage(priceUsd, tradeSide)
    const executionPrice = priceUsdToTicksWithMarketParams(executionPriceUsd, marketParams)
    return {
      triggerDirection: direction,
      tradeSide,
      orderKind: StopLossOrderKind.IOC,
      triggerPrice,
      executionPrice,
    }
  }

  let greaterTriggerOrder: TriggerOrderParams | null = null
  let lessTriggerOrder: TriggerOrderParams | null = null

  if (takeProfitPriceUsd !== null) {
    if (positionSide === 'long') {
      greaterTriggerOrder = buildTrigger(Direction.GreaterThan, takeProfitPriceUsd)
    } else {
      lessTriggerOrder = buildTrigger(Direction.LessThan, takeProfitPriceUsd)
    }
  }

  if (stopLossPriceUsd !== null) {
    if (positionSide === 'long') {
      lessTriggerOrder = buildTrigger(Direction.LessThan, stopLossPriceUsd)
    } else {
      greaterTriggerOrder = buildTrigger(Direction.GreaterThan, stopLossPriceUsd)
    }
  }

  return { greaterTriggerOrder, lessTriggerOrder }
}

export function iocExecutionPriceWithSlippage(priceUsd: string, tradeSide: Side): string {
  const price = Number.parseFloat(priceUsd)
  const buffered = tradeSide === Side.Ask ? price * 0.9 : price * 1.1
  return buffered.toFixed(8).replace(/\.?0+$/, '')
}

export async function phoenixAccountExists(client: PhoenixSdkClient, address: string): Promise<boolean | null> {
  if (!client.rpc.available) return null

  try {
    await client.rpc.accounts.fetchAccount(address as never)
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/not found|does not exist|account does not exist|could not find|404/i.test(message)) {
      return false
    }
    console.warn('[api] Phoenix conditional account existence check failed:', message)
    return null
  }
}

export async function buildMissingConditionalOrdersAccountIxs(
  client: PhoenixSdkClient,
  builder: {
    authority: Authority
    positionAuthority?: Authority
    traderPdaIndex: number
    traderSubaccountIndex: number
  },
): Promise<unknown[]> {
  const traderAccount = await client.pda.getTraderAddress({
    authority: builder.authority,
    traderPdaIndex: builder.traderPdaIndex,
    subaccountIndex: builder.traderSubaccountIndex,
  })
  const conditionalOrdersAccount = await client.pda.getConditionalOrdersAddress({ traderAccount })
  const exists = await phoenixAccountExists(client, conditionalOrdersAccount)

  if (exists !== false) return []

  const createIx = await client.ixs.buildCreateConditionalOrdersAccount({
    authority: builder.authority,
    positionAuthority: builder.positionAuthority,
    traderPdaIndex: builder.traderPdaIndex,
    traderSubaccountIndex: builder.traderSubaccountIndex,
  })

  return [createIx]
}
