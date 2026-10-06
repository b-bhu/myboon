import DLMM, {
  MAX_BINS_PER_POSITION,
  TOKEN_ACCOUNT_FEE_BN,
  getPositionRentExemption,
  MAX_BIN_PER_LIMIT_ORDER,
  StrategyType,
  toAmountsBothSideByStrategy,
  autoFillXByStrategy,
  autoFillYByStrategy,
  isSupportLimitOrder,
  type LbPosition,
  type PlaceLimitOrderParams,
} from '@meteora-ag/dlmm'
import {
  DlmmDirectSwapQuoteRoute,
  Zap,
  estimateDlmmDirectSwap,
} from '@meteora-ag/zap-sdk'
import { Connection, Keypair, PublicKey, type Transaction } from '@solana/web3.js'
import BN from 'bn.js'
import Decimal from 'decimal.js'
import { METEORA_DLMM_PROGRAM_IDS } from './config.js'
import { MeteoraClientError } from './errors.js'
import { createMeteoraPoolLoader } from './pool-loader.js'
import {
  assertPoolStateCompatible,
  assertPreviewUsable,
  createLimitOrderPreview,
  createPositionPreview,
  createZapInPreview,
  resolveExecutionDefaults,
} from './execution.js'
import {
  assertAtomicAmount,
  assertBinRange,
  assertBps,
  assertFinitePositiveDecimal,
  assertPublicKey,
  decimalToAtomicAmount,
  strategyToSdkValue,
} from './validation.js'
import type {
  MeteoraBuildAddLiquidityInput,
  MeteoraBuildCreatePositionInput,
  MeteoraBuildLimitOrderActionInput,
  MeteoraBuildPlaceLimitOrderInput,
  MeteoraBuildPositionActionInput,
  MeteoraBuildRemoveLiquidityInput,
  MeteoraAutoFillQuote,
  MeteoraAutoFillRequest,
  MeteoraClientConfig,
  MeteoraCreatePositionPreview,
  MeteoraCreatePositionCostEstimate,
  MeteoraCreatePositionRequest,
  MeteoraExecutionDefaults,
  MeteoraExecutionPoolState,
  MeteoraLimitOrderPreview,
  MeteoraLimitOrderRequest,
  MeteoraRangeQuote,
  MeteoraPoolBinLiquidity,
  MeteoraTransactionBundle,
  MeteoraStrategyBinAllocation,
  MeteoraStrategy,
  MeteoraTransactionPlan,
  MeteoraTransactionPlanStep,
  MeteoraZapInPreview,
  MeteoraZapInRequest,
} from './types.js'

type DlmmPool = Awaited<ReturnType<typeof DLMM.create>>

/**
 * Exact official strategy allocation for the dev fixture's legacy SPL test
 * mints. It is intentionally pure: no wallet, RPC, signing, or submission.
 * Production allocations use the pool's actual mints in `getStrategyAllocation`.
 */
export function getMeteoraLegacyMintStrategyAllocation(input: {
  activeBinId: number
  binStep: number
  minBinId: number
  maxBinId: number
  amountXAtomic: string
  amountYAtomic: string
  strategy: MeteoraStrategy
}): MeteoraStrategyBinAllocation[] {
  const legacyMint = { tlvData: new Uint8Array() } as never
  const clock = { epoch: new BN(0) } as never
  return toAmountsBothSideByStrategy(
    input.activeBinId,
    input.binStep,
    input.minBinId,
    input.maxBinId,
    new BN(input.amountXAtomic),
    new BN(input.amountYAtomic),
    new BN(0),
    new BN(0),
    strategyToSdkValue(input.strategy) as StrategyType,
    legacyMint,
    legacyMint,
    clock,
  ).map((amount) => ({
    binId: amount.binId,
    xAtomic: amount.amountX.toString(),
    yAtomic: amount.amountY.toString(),
  }))
}

export class MeteoraSdkClient {
  readonly connection: Connection
  readonly programId: string
  private readonly network: 'mainnet-beta' | 'devnet'
  private readonly executionDefaults: MeteoraExecutionDefaults
  private readonly zap: Zap
  private readonly positionCostEstimates = new Map<string, Promise<MeteoraCreatePositionCostEstimate>>()
  private readonly pools = createMeteoraPoolLoader<DlmmPool>((poolAddress) => (
    DLMM.create(this.connection, assertPublicKey(poolAddress, 'poolAddress'), { cluster: this.network })
  ))

  constructor(config: MeteoraClientConfig) {
    if (!config.rpcUrl) {
      throw new MeteoraClientError('RPC_NOT_CONFIGURED', 'rpcUrl is required for Meteora SDK operations')
    }
    this.network = config.network ?? 'mainnet-beta'
    this.programId = METEORA_DLMM_PROGRAM_IDS[this.network]
    this.connection = new Connection(
      config.rpcUrl,
      config.rpcWsUrl ? { commitment: 'confirmed', wsEndpoint: config.rpcWsUrl } : 'confirmed',
    )
    this.executionDefaults = resolveExecutionDefaults(config.execution)
    this.zap = new Zap(this.connection)
  }

  clearPoolCache(): void {
    this.pools.clear()
    this.positionCostEstimates.clear()
  }

  async quoteRange(
    poolAddress: string,
    requestedMinPrice: string,
    requestedMaxPrice: string,
  ): Promise<MeteoraRangeQuote> {
    const minPrice = assertFinitePositiveDecimal(requestedMinPrice, 'requestedMinPrice')
    const maxPrice = assertFinitePositiveDecimal(requestedMaxPrice, 'requestedMaxPrice')
    if (minPrice.gte(maxPrice)) {
      throw new MeteoraClientError('INVALID_ARGUMENT', 'requestedMinPrice must be below requestedMaxPrice')
    }

    const pool = await this.getFreshPool(poolAddress)
    const activeBin = await pool.getActiveBin()
    const minBinId = pool.getBinIdFromPrice(minPrice.toNumber(), true)
    const maxBinId = pool.getBinIdFromPrice(maxPrice.toNumber(), false)
    assertBinRange(minBinId, maxBinId)
    this.assertPositionWidth(minBinId, maxBinId)

    const activePrice = new Decimal(activeBin.pricePerToken)
    const step = new Decimal(1).plus(new Decimal(pool.lbPair.binStep).div(10_000))
    const executableMinPrice = activePrice.mul(step.pow(minBinId - activeBin.binId))
    const executableMaxPrice = activePrice.mul(step.pow(maxBinId - activeBin.binId))

    return {
      poolAddress,
      activeBinId: activeBin.binId,
      activePrice: activePrice.toString(),
      requestedMinPrice: minPrice.toString(),
      requestedMaxPrice: maxPrice.toString(),
      minBinId,
      maxBinId,
      executableMinPrice: executableMinPrice.toString(),
      executableMaxPrice: executableMaxPrice.toString(),
      binCount: maxBinId - minBinId + 1,
    }
  }

  async buildCreatePosition(input: MeteoraBuildCreatePositionInput): Promise<MeteoraTransactionBundle> {
    const pool = await this.getFreshPool(input.poolAddress)
    const wallet = assertPublicKey(input.walletAddress, 'walletAddress')
    const position = Keypair.generate()
    const strategy = this.strategy(input)
    const transaction = await pool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: position.publicKey,
      totalXAmount: new BN(assertAtomicAmount(input.tokenXAtomic, 'tokenXAtomic')),
      totalYAmount: new BN(assertAtomicAmount(input.tokenYAtomic, 'tokenYAtomic')),
      strategy,
      user: wallet,
      slippage: this.slippagePercent(input.slippageBps),
    })

    return this.bundle('create_position', input.poolAddress, position.publicKey.toBase58(), [transaction], [position])
  }

  async buildAddLiquidity(input: MeteoraBuildAddLiquidityInput): Promise<MeteoraTransactionBundle> {
    const pool = await this.getFreshPool(input.poolAddress)
    const wallet = assertPublicKey(input.walletAddress, 'walletAddress')
    const position = assertPublicKey(input.positionAddress, 'positionAddress')
    const transaction = await pool.addLiquidityByStrategy({
      positionPubKey: position,
      totalXAmount: new BN(assertAtomicAmount(input.tokenXAtomic, 'tokenXAtomic')),
      totalYAmount: new BN(assertAtomicAmount(input.tokenYAtomic, 'tokenYAtomic')),
      strategy: this.strategy(input),
      user: wallet,
      slippage: this.slippagePercent(input.slippageBps),
    })

    return this.bundle('add_liquidity', input.poolAddress, input.positionAddress, [transaction])
  }

  async buildClaim(input: MeteoraBuildPositionActionInput): Promise<MeteoraTransactionBundle> {
    const pool = await this.getPool(input.poolAddress)
    const wallet = assertPublicKey(input.walletAddress, 'walletAddress')
    const position = await pool.getPosition(assertPublicKey(input.positionAddress, 'positionAddress'))
    const transactions = await pool.claimAllRewardsByPosition({ owner: wallet, position })
    return this.bundle('claim', input.poolAddress, input.positionAddress, transactions)
  }

  async buildRemoveLiquidity(input: MeteoraBuildRemoveLiquidityInput): Promise<MeteoraTransactionBundle> {
    assertBinRange(input.fromBinId, input.toBinId)
    const pool = await this.getPool(input.poolAddress)
    const wallet = assertPublicKey(input.walletAddress, 'walletAddress')
    const positionAddress = assertPublicKey(input.positionAddress, 'positionAddress')
    const transactions = await pool.removeLiquidity({
      user: wallet,
      position: positionAddress,
      fromBinId: input.fromBinId,
      toBinId: input.toBinId,
      bps: new BN(assertBps(input.removeBps, 'removeBps', 1, 10_000)),
      shouldClaimAndClose: input.claimAndClose ?? false,
    })
    return this.bundle('remove_liquidity', input.poolAddress, input.positionAddress, transactions)
  }

  async buildClosePosition(input: MeteoraBuildPositionActionInput): Promise<MeteoraTransactionBundle> {
    const pool = await this.getPool(input.poolAddress)
    const wallet = assertPublicKey(input.walletAddress, 'walletAddress')
    const position = await pool.getPosition(assertPublicKey(input.positionAddress, 'positionAddress'))
    const transaction = await pool.closePosition({ owner: wallet, position })
    return this.bundle('close_position', input.poolAddress, input.positionAddress, [transaction])
  }

  async buildPlaceLimitOrder(input: MeteoraBuildPlaceLimitOrderInput): Promise<MeteoraTransactionBundle> {
    if (input.params.bins.length > MAX_BIN_PER_LIMIT_ORDER.toNumber()) {
      throw new MeteoraClientError(
        'INVALID_LIMIT_ORDER',
        `Limit order exceeds Meteora's ${MAX_BIN_PER_LIMIT_ORDER.toString()}-bin protocol limit`,
      )
    }
    const pool = await this.getFreshPool(input.poolAddress)
    const wallet = assertPublicKey(input.walletAddress, 'walletAddress')
    const limitOrder = Keypair.generate()
    const transaction = await pool.placeLimitOrder({
      owner: wallet,
      payer: wallet,
      sender: wallet,
      limitOrder: limitOrder.publicKey,
      params: input.params as Omit<PlaceLimitOrderParams, 'padding'>,
    })
    return this.bundle(
      'place_limit_order',
      input.poolAddress,
      limitOrder.publicKey.toBase58(),
      [transaction],
      [limitOrder],
    )
  }

  async getExecutionPoolState(poolAddress: string): Promise<MeteoraExecutionPoolState> {
    const pool = await this.getFreshPool(poolAddress)
    return this.poolState(pool)
  }

  /**
   * Fetch a bounded, real liquidity window from DLMM. This intentionally uses
   * the SDK bin read rather than deriving a second chart series from a user's
   * deposit values.
   */
  async getBinsAroundActiveBin(
    poolAddress: string,
    binsToLeft: number,
    binsToRight: number,
  ): Promise<{ activeBinId: number; bins: MeteoraPoolBinLiquidity[] }> {
    if (!Number.isInteger(binsToLeft) || !Number.isInteger(binsToRight)
      || binsToLeft < 0 || binsToRight < 0 || binsToLeft + binsToRight > 256) {
      throw new MeteoraClientError('INVALID_ARGUMENT', 'Requested liquidity bin window must be between 0 and 256 bins')
    }
    const pool = await this.getFreshPool(poolAddress)
    const result = await pool.getBinsAroundActiveBin(binsToLeft, binsToRight)
    return {
      activeBinId: result.activeBin,
      bins: result.bins.map((bin) => ({
        binId: bin.binId,
        price: new Decimal(bin.pricePerToken).toString(),
        xAtomic: bin.xAmount.toString(),
        yAtomic: bin.yAmount.toString(),
      })),
    }
  }

  /** Read exactly the chart's selected canonical bin window. */
  /**
   * The exact allocator used by `initializePositionAndAddLiquidityByStrategy`.
   * If the active bin moved since the preview snapshot, return null rather
   * than presenting a misleading mixed-bin chart.
   */
  async getStrategyAllocation(
    preview: MeteoraCreatePositionPreview,
  ): Promise<MeteoraStrategyBinAllocation[] | null> {
    const pool = await this.getFreshPool(preview.poolState.poolAddress)
    const activeBin = await pool.getActiveBin()
    if (activeBin.binId !== preview.poolState.activeBinId) return null
    const amounts = toAmountsBothSideByStrategy(
      preview.poolState.activeBinId,
      preview.poolState.binStep,
      preview.range.minBinId,
      preview.range.maxBinId,
      new BN(preview.amounts.tokenXAtomic),
      new BN(preview.amounts.tokenYAtomic),
      activeBin.xAmount,
      activeBin.yAmount,
      strategyToSdkValue(preview.strategy) as StrategyType,
      pool.tokenX.mint,
      pool.tokenY.mint,
      pool.clock,
    )
    return amounts.map((amount) => ({
      binId: amount.binId,
      xAtomic: amount.amountX.toString(),
      yAtomic: amount.amountY.toString(),
    }))
  }

  async getBinsBetweenBounds(
    poolAddress: string,
    minBinId: number,
    maxBinId: number,
  ): Promise<{ activeBinId: number; activePrice: string; bins: MeteoraPoolBinLiquidity[] }> {
    if (!Number.isInteger(minBinId) || !Number.isInteger(maxBinId) || minBinId > maxBinId
      || maxBinId - minBinId + 1 > 128) {
      throw new MeteoraClientError('INVALID_ARGUMENT', 'Requested liquidity window must be an ordered range of at most 128 bins')
    }
    const pool = await this.getFreshPool(poolAddress)
    const state = await this.poolState(pool)
    const result = await pool.getBinsBetweenLowerAndUpperBound(minBinId, maxBinId)
    return {
      activeBinId: state.activeBinId,
      activePrice: state.activePrice,
      bins: result.bins.map((bin) => ({
        binId: bin.binId,
        price: new Decimal(bin.pricePerToken).toString(),
        xAtomic: bin.xAmount.toString(),
        yAtomic: bin.yAmount.toString(),
      })),
    }
  }

  async getExecutionCapabilities(poolAddress: string): Promise<{
    createPosition: true
    zapIn: true
    limitOrder: boolean
  }> {
    const pool = await this.getFreshPool(poolAddress)
    return {
      createPosition: true,
      zapIn: true,
      limitOrder: isSupportLimitOrder(pool.lbPair),
    }
  }

  async previewCreatePosition(
    request: MeteoraCreatePositionRequest,
    now = new Date(),
  ): Promise<MeteoraCreatePositionPreview> {
    const pool = await this.getFreshPool(request.poolAddress)
    return createPositionPreview(await this.poolState(pool), request, {
      defaults: this.executionDefaults,
      now,
    })
  }

  async quoteAutoFill(input: MeteoraAutoFillRequest): Promise<MeteoraAutoFillQuote> {
    const pool = await this.getFreshPool(input.poolAddress)
    const state = await this.poolState(pool)
    const range = createZapInPreview(state, {
      poolAddress: input.poolAddress,
      strategy: input.strategy,
      range: input.range,
      inputToken: input.inputToken,
      amount: input.amount,
    }).range
    if (range.minBinId > state.activeBinId || range.maxBinId < state.activeBinId) {
      throw new MeteoraClientError(
        'INVALID_DEPOSIT_COMBINATION',
        'Auto-Fill requires a range containing the current active bin',
      )
    }

    const activeBin = await pool.getActiveBin()
    const inputAtomic = new BN(
      input.inputToken === 'x'
        ? decimalToAtomicAmount(input.amount, state.tokenX.decimals, 'amount')
        : decimalToAtomicAmount(input.amount, state.tokenY.decimals, 'amount'),
    )
    const strategy = strategyToSdkValue(input.strategy) as StrategyType
    const tokenXAtomic = input.inputToken === 'x'
      ? inputAtomic
      : autoFillXByStrategy(
        state.activeBinId,
        state.binStep,
        inputAtomic,
        activeBin.xAmount,
        activeBin.yAmount,
        range.minBinId,
        range.maxBinId,
        strategy,
      )
    const tokenYAtomic = input.inputToken === 'y'
      ? inputAtomic
      : autoFillYByStrategy(
        state.activeBinId,
        state.binStep,
        inputAtomic,
        activeBin.xAmount,
        activeBin.yAmount,
        range.minBinId,
        range.maxBinId,
        strategy,
      )
    if (tokenXAtomic.isZero() || tokenYAtomic.isZero()) {
      throw new MeteoraClientError(
        'INVALID_DEPOSIT_COMBINATION',
        'The selected amount and range cannot produce a two-token Auto-Fill quote',
      )
    }

    return {
      poolState: state,
      range,
      inputToken: input.inputToken,
      tokenXAmount: atomicToDecimal(tokenXAtomic.toString(), state.tokenX.decimals),
      tokenYAmount: atomicToDecimal(tokenYAtomic.toString(), state.tokenY.decimals),
      tokenXAtomic: tokenXAtomic.toString(),
      tokenYAtomic: tokenYAtomic.toString(),
    }
  }

  async buildCreatePositionFromPreview(input: {
    walletAddress: string
    preview: MeteoraCreatePositionPreview
    now?: Date
  }): Promise<MeteoraTransactionBundle> {
    assertPreviewUsable(input.preview, input.now)
    const pool = await this.getFreshPool(input.preview.poolState.poolAddress)
    assertPoolStateCompatible(input.preview, await this.poolState(pool))
    const wallet = assertPublicKey(input.walletAddress, 'walletAddress')
    const position = Keypair.generate()
    const transaction = await pool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: position.publicKey,
      totalXAmount: new BN(input.preview.amounts.tokenXAtomic),
      totalYAmount: new BN(input.preview.amounts.tokenYAtomic),
      strategy: {
        minBinId: input.preview.range.minBinId,
        maxBinId: input.preview.range.maxBinId,
        strategyType: strategyToSdkValue(input.preview.strategy) as StrategyType,
        ...(input.preview.depositMode === 'single_sided'
          ? { singleSidedX: input.preview.amounts.tokenXAtomic !== '0' }
          : {}),
      },
      user: wallet,
      slippage: this.slippagePercent(input.preview.defaults.liquiditySlippageBps),
    })
    return this.bundle(
      'create_position',
      input.preview.poolState.poolAddress,
      position.publicKey.toBase58(),
      [transaction],
      [position],
      input.preview,
    )
  }

  /**
   * Read-only estimate for the review/MAX reserve. It constructs no signed
   * transaction and never submits one. The official SDK may perform an
   * unsigned compute-unit simulation while assembling its estimate. Account-creation rent is
   * intentionally not guessed here; the build message gives us a concrete
   * position rent and maximum base network fee only.
   */
  async estimateCreatePositionCosts(input: {
    walletAddress: string
    preview: MeteoraCreatePositionPreview
  }): Promise<MeteoraCreatePositionCostEstimate> {
    const [positionRentLamports, bundle, pool] = await Promise.all([
      getPositionRentExemption(this.connection, new BN(input.preview.range.binCount)),
      this.buildCreatePositionFromPreview(input),
      this.getFreshPool(input.preview.poolState.poolAddress),
    ])
    const quote = await pool.quoteCreatePosition({
      strategy: {
        minBinId: input.preview.range.minBinId,
        maxBinId: input.preview.range.maxBinId,
        strategyType: strategyToSdkValue(input.preview.strategy) as StrategyType,
        ...(input.preview.depositMode === 'single_sided'
          ? { singleSidedX: input.preview.amounts.tokenXAtomic !== '0' }
          : {}),
      },
    })
    const blockhash = await this.connection.getLatestBlockhash('confirmed')
    const payer = assertPublicKey(input.walletAddress, 'walletAddress')
    const fees = await Promise.all(bundle.transactions.map(async (transaction) => {
      transaction.recentBlockhash = blockhash.blockhash
      transaction.feePayer = payer
      const value = await this.connection.getFeeForMessage(transaction.compileMessage(), 'confirmed')
      return value.value
    }))
    const ataProgram = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
    const ataCreations = bundle.transactions.flatMap((transaction) => transaction.instructions)
      .filter((instruction) => instruction.programId.toBase58() === ataProgram).length
    // The SDK's token-account constant is exact for legacy SPL accounts. A
    // Token-2022 account may have extensions, so preserve an unavailable
    // result instead of understating its rent.
    const mintAccounts = ataCreations > 0
      ? await this.connection.getMultipleAccountsInfo([pool.tokenX.publicKey, pool.tokenY.publicKey], 'confirmed')
      : []
    const token2022 = mintAccounts.some((account) => account?.owner.toBase58() === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
    const tokenAccountRentLamports = ataCreations === 0 ? '0'
      : token2022 ? null : (BigInt(TOKEN_ACCOUNT_FEE_BN.toString()) * BigInt(ataCreations)).toString()
    return {
      positionRentLamports: String(positionRentLamports),
      positionReallocRentLamports: decimalSolToLamports(quote.positionReallocCost),
      binArrayRentLamports: decimalSolToLamports(quote.binArrayCost),
      bitmapExtensionRentLamports: decimalSolToLamports(quote.bitmapExtensionCost),
      tokenAccountRentLamports,
      maximumNetworkFeeLamports: fees.some((fee) => fee === null)
        ? null
        : fees.reduce((total, fee) => total + BigInt(fee ?? 0), 0n).toString(),
      transactionCount: bundle.transactions.length,
      complete: tokenAccountRentLamports !== null,
    }
  }

  /**
   * Build a minimal one-atomic-unit position solely to quote account rent and
   * fees for an editable range. It never becomes an executable UI preview.
   */
  async estimatePositionCostsForRange(input: {
    poolAddress: string
    walletAddress: string
    strategy: MeteoraCreatePositionRequest['strategy']
    minPrice: string
    maxPrice: string
    /** Empty forms conservatively quote two token accounts; edited drafts match their deposit shape. */
    depositMode?: 'two_token' | 'single_sided'
    inputToken?: 'x' | 'y'
    cacheKey?: string
  }): Promise<MeteoraCreatePositionCostEstimate> {
    const key = JSON.stringify(input)
    const existing = this.positionCostEstimates.get(key)
    if (existing) return existing
    let estimate: Promise<MeteoraCreatePositionCostEstimate>
    estimate = this.getExecutionPoolState(input.poolAddress).then((state) => {
      const preview = createPositionPreview(state, input.depositMode === 'single_sided'
        ? {
          poolAddress: input.poolAddress,
          strategy: input.strategy,
          range: { kind: 'manual', minPrice: input.minPrice, maxPrice: input.maxPrice },
          depositMode: 'single_sided',
          inputToken: input.inputToken ?? 'x',
          amount: atomicToDecimal('1', (input.inputToken ?? 'x') === 'x' ? state.tokenX.decimals : state.tokenY.decimals),
        }
        : {
          poolAddress: input.poolAddress,
          strategy: input.strategy,
          range: { kind: 'manual', minPrice: input.minPrice, maxPrice: input.maxPrice },
          depositMode: 'two_token',
          tokenXAmount: atomicToDecimal('1', state.tokenX.decimals),
          tokenYAmount: atomicToDecimal('1', state.tokenY.decimals),
        })
      return this.estimateCreatePositionCosts({ walletAddress: input.walletAddress, preview })
    }).then((result) => {
      // An unavailable fee or rent is retryable; keep concurrent reads joined
      // but do not make a later Retry reuse the same incomplete result.
      if ((!result.complete || result.maximumNetworkFeeLamports === null)
        && this.positionCostEstimates.get(key) === estimate) this.positionCostEstimates.delete(key)
      return result
    }).catch((cause) => {
      if (this.positionCostEstimates.get(key) === estimate) this.positionCostEstimates.delete(key)
      throw cause
    })
    this.positionCostEstimates.set(key, estimate)
    return estimate
  }

  async previewLimitOrder(
    request: MeteoraLimitOrderRequest,
    now = new Date(),
  ): Promise<MeteoraLimitOrderPreview> {
    const pool = await this.getFreshPool(request.poolAddress)
    return createLimitOrderPreview(await this.poolState(pool), request, {
      defaults: this.executionDefaults,
      now,
    })
  }

  async buildLimitOrderFromPreview(input: {
    walletAddress: string
    preview: MeteoraLimitOrderPreview
    now?: Date
  }): Promise<MeteoraTransactionBundle> {
    assertPreviewUsable(input.preview, input.now)
    const pool = await this.getFreshPool(input.preview.poolState.poolAddress)
    assertPoolStateCompatible(input.preview, await this.poolState(pool))
    const wallet = assertPublicKey(input.walletAddress, 'walletAddress')
    const limitOrder = Keypair.generate()
    const transaction = await pool.placeLimitOrder({
      owner: wallet,
      payer: wallet,
      sender: wallet,
      limitOrder: limitOrder.publicKey,
      params: {
        isAskSide: input.preview.side === 'sell',
        relativeBin: {
          activeId: input.preview.poolState.activeBinId,
          maxActiveBinSlippage: input.preview.defaults.maxActiveBinSlippage,
        },
        bins: [{
          id: input.preview.relativeBinId,
          amount: new BN(input.preview.inputTokenAtomic),
        }],
      },
    })
    return this.bundle(
      'place_limit_order',
      input.preview.poolState.poolAddress,
      limitOrder.publicKey.toBase58(),
      [transaction],
      [limitOrder],
      input.preview,
    )
  }

  async previewZapIn(
    request: MeteoraZapInRequest,
    now = new Date(),
  ): Promise<MeteoraZapInPreview> {
    const pool = await this.getFreshPool(request.poolAddress)
    const state = await this.poolState(pool)
    const basePreview = createZapInPreview(state, request, {
      defaults: this.executionDefaults,
      now,
    })
    try {
      const estimate = await this.estimateZap(pool, basePreview)
      return createZapInPreview(state, request, {
        defaults: this.executionDefaults,
        now,
        estimate: {
          route: estimate.quote === null
            ? 'none'
            : estimate.quote.route === DlmmDirectSwapQuoteRoute.Dlmm
              ? 'dlmm'
              : 'jupiter',
          swapAmountAtomic: estimate.swapAmount.toString(),
          expectedOutputAtomic: estimate.expectedOutput.toString(),
          minimumOutputAtomic: estimate.quote === null
            ? '0'
            : estimate.quote.route === DlmmDirectSwapQuoteRoute.Dlmm
              ? estimate.quote.originalQuote.minOutAmount.toString()
              : estimate.quote.originalQuote.otherAmountThreshold,
          priceImpactPct: estimate.quote === null
            ? '0'
            : estimate.quote.route === DlmmDirectSwapQuoteRoute.Dlmm
              ? estimate.quote.originalQuote.priceImpact.toString()
              : estimate.quote.originalQuote.priceImpactPct,
          postSwapXAtomic: estimate.postSwapX.toString(),
          postSwapYAtomic: estimate.postSwapY.toString(),
        },
      })
    } catch (cause) {
      if (cause instanceof MeteoraClientError) throw cause
      throw new MeteoraClientError(
        'ZAP_UNAVAILABLE',
        'Meteora could not produce a direct Zap In estimate for this pool token',
        null,
        cause,
      )
    }
  }

  async buildZapInFromPreview(input: {
    walletAddress: string
    preview: MeteoraZapInPreview
    now?: Date
  }): Promise<MeteoraTransactionBundle> {
    assertPreviewUsable(input.preview, input.now)
    const pool = await this.getFreshPool(input.preview.poolState.poolAddress)
    assertPoolStateCompatible(input.preview, await this.poolState(pool))
    const wallet = assertPublicKey(input.walletAddress, 'walletAddress')
    const position = Keypair.generate()
    try {
      const estimate = await this.estimateZap(pool, input.preview)
      const params = await this.zap.getZapInDlmmDirectParams({
        user: wallet,
        lbPair: pool.pubkey,
        inputTokenMint: input.preview.inputToken === 'x'
          ? pool.tokenX.publicKey
          : pool.tokenY.publicKey,
        amountIn: new BN(input.preview.inputTokenAtomic),
        maxActiveBinSlippage: input.preview.defaults.maxActiveBinSlippage,
        minDeltaId: input.preview.range.minBinId - input.preview.poolState.activeBinId,
        maxDeltaId: input.preview.range.maxBinId - input.preview.poolState.activeBinId,
        strategy: strategyToSdkValue(input.preview.strategy) as StrategyType,
        favorXInActiveId: input.preview.defaults.favorXInActiveId,
        maxAccounts: input.preview.defaults.maxAccounts,
        swapSlippageBps: input.preview.defaults.swapSlippageBps,
        maxTransferAmountExtendPercentage:
          input.preview.defaults.maxTransferAmountExtendPercentage,
        directSwapEstimate: estimate,
      })
      const response = await this.zap.buildZapInDlmmTransaction({
        ...params,
        position: position.publicKey,
      })
      const transactions = [
        ...(response.setupTransaction ? [response.setupTransaction] : []),
        ...response.swapTransactions,
        response.ledgerTransaction,
        response.zapInTransaction,
        response.cleanUpTransaction,
      ]
      const stepKinds: MeteoraTransactionPlanStep['kind'][] = [
        ...(response.setupTransaction ? ['setup' as const] : []),
        ...response.swapTransactions.map(() => 'swap' as const),
        'ledger',
        'execute',
        'cleanup',
      ]
      return this.bundle(
        'zap_in',
        input.preview.poolState.poolAddress,
        position.publicKey.toBase58(),
        transactions,
        [position],
        input.preview,
        stepKinds,
      )
    } catch (cause) {
      if (cause instanceof MeteoraClientError) throw cause
      throw new MeteoraClientError(
        'ZAP_UNAVAILABLE',
        'Meteora could not build the direct Zap In transaction plan',
        null,
        cause,
      )
    }
  }

  async buildCancelLimitOrder(input: MeteoraBuildLimitOrderActionInput): Promise<MeteoraTransactionBundle> {
    if (!input.binIds?.length) {
      throw new MeteoraClientError('INVALID_ARGUMENT', 'binIds are required to cancel a limit order')
    }
    const pool = await this.getPool(input.poolAddress)
    const wallet = assertPublicKey(input.walletAddress, 'walletAddress')
    const transaction = await pool.cancelLimitOrder({
      limitOrderPubkey: assertPublicKey(input.limitOrderAddress, 'limitOrderAddress'),
      owner: wallet,
      rentReceiver: wallet,
      binIds: input.binIds,
    })
    return this.bundle('cancel_limit_order', input.poolAddress, input.limitOrderAddress, [transaction])
  }

  async buildCloseLimitOrder(input: MeteoraBuildLimitOrderActionInput): Promise<MeteoraTransactionBundle> {
    const pool = await this.getPool(input.poolAddress)
    const wallet = assertPublicKey(input.walletAddress, 'walletAddress')
    const transaction = await pool.closeLimitOrderIfEmpty({
      limitOrder: assertPublicKey(input.limitOrderAddress, 'limitOrderAddress'),
      owner: wallet,
      rentReceiver: wallet,
    })
    return this.bundle('close_limit_order', input.poolAddress, input.limitOrderAddress, [transaction])
  }

  async getPosition(poolAddress: string, positionAddress: string): Promise<LbPosition> {
    const pool = await this.getPool(poolAddress)
    return pool.getPosition(assertPublicKey(positionAddress, 'positionAddress'))
  }

  async isExecutionResourceVisible(input: {
    action: string
    poolAddress: string
    resourceAddress: string | null
  }): Promise<boolean> {
    if (!input.resourceAddress) return false
    try {
      if (input.action === 'create_position' || input.action === 'zap_in') {
        await this.getPosition(input.poolAddress, input.resourceAddress)
        return true
      }
      const account = await this.connection.getAccountInfo(
        assertPublicKey(input.resourceAddress, 'resourceAddress'),
        'confirmed',
      )
      return account !== null
    } catch {
      return false
    }
  }

  private getPool(poolAddress: string): Promise<DlmmPool> {
    assertPublicKey(poolAddress, 'poolAddress')
    return this.pools.get(poolAddress).catch((cause) => {
      throw new MeteoraClientError('SDK_ERROR', 'Failed to load Meteora pool state', null, cause)
    })
  }

  private getFreshPool(poolAddress: string): Promise<DlmmPool> {
    assertPublicKey(poolAddress, 'poolAddress')
    return this.pools.getFresh(poolAddress).catch((cause) => {
      throw new MeteoraClientError('SDK_ERROR', 'Failed to refresh Meteora pool state', null, cause)
    })
  }

  private async poolState(pool: DlmmPool): Promise<MeteoraExecutionPoolState> {
    const activeBin = await pool.getActiveBin()
    return {
      poolAddress: pool.pubkey.toBase58(),
      activeBinId: activeBin.binId,
      activePrice: new Decimal(activeBin.pricePerToken).toString(),
      binStep: pool.lbPair.binStep,
      tokenX: {
        address: pool.tokenX.publicKey.toBase58(),
        symbol: 'X',
        decimals: pool.tokenX.mint.decimals,
      },
      tokenY: {
        address: pool.tokenY.publicKey.toBase58(),
        symbol: 'Y',
        decimals: pool.tokenY.mint.decimals,
      },
      refreshedAt: new Date().toISOString(),
    }
  }

  private estimateZap(
    pool: DlmmPool,
    preview: MeteoraZapInPreview,
  ) {
    const expectedMint = preview.inputToken === 'x' ? pool.tokenX.publicKey : pool.tokenY.publicKey
    const previewMint = preview.inputToken === 'x'
      ? preview.poolState.tokenX.address
      : preview.poolState.tokenY.address
    if (expectedMint.toBase58() !== previewMint) {
      throw new MeteoraClientError('TOKEN_NOT_IN_POOL', 'Zap input token no longer matches the selected pool')
    }
    return estimateDlmmDirectSwap({
      amountIn: new BN(preview.inputTokenAtomic),
      inputTokenMint: expectedMint,
      lbPair: pool.pubkey,
      connection: this.connection,
      swapSlippageBps: preview.defaults.swapSlippageBps,
      minDeltaId: preview.range.minBinId - preview.poolState.activeBinId,
      maxDeltaId: preview.range.maxBinId - preview.poolState.activeBinId,
      strategy: strategyToSdkValue(preview.strategy) as StrategyType,
    }).then(({ result }) => result)
  }

  private strategy(input: {
    minBinId: number
    maxBinId: number
    strategy: MeteoraBuildCreatePositionInput['strategy']
  }): { minBinId: number; maxBinId: number; strategyType: StrategyType } {
    assertBinRange(input.minBinId, input.maxBinId)
    this.assertPositionWidth(input.minBinId, input.maxBinId)
    return {
      minBinId: input.minBinId,
      maxBinId: input.maxBinId,
      strategyType: strategyToSdkValue(input.strategy) as StrategyType,
    }
  }

  private assertPositionWidth(minBinId: number, maxBinId: number): void {
    const binCount = maxBinId - minBinId + 1
    const maxBins = MAX_BINS_PER_POSITION.toNumber()
    if (binCount > maxBins) {
      throw new MeteoraClientError(
        'INVALID_ARGUMENT',
        `Position range exceeds Meteora's ${maxBins}-bin limit`,
      )
    }
  }

  private slippagePercent(slippageBps = 100): number {
    return assertBps(slippageBps, 'slippageBps', 0, 5_000) / 100
  }

  private bundle(
    action: MeteoraTransactionBundle['action'],
    poolAddress: string,
    resourceAddress: string | null,
    transactions: Transaction[],
    additionalSigners: Keypair[] = [],
    preview?: MeteoraCreatePositionPreview | MeteoraLimitOrderPreview | MeteoraZapInPreview,
    stepKinds?: MeteoraTransactionPlanStep['kind'][],
  ): MeteoraTransactionBundle {
    const createdAt = new Date().toISOString()
    const kinds = stepKinds ?? transactions.map(() => 'execute' as const)
    const plan: MeteoraTransactionPlan = {
      planId: `plan_${preview?.inputHash ?? createdAt}_${transactions.length}`,
      previewId: preview?.previewId ?? null,
      createdAt,
      expiresAt: preview?.expiresAt ?? null,
      steps: transactions.map((_, transactionIndex) => {
        const kind = kinds[transactionIndex] ?? 'execute'
        return {
          id: `${kind}_${transactionIndex + 1}`,
          kind,
          label: this.stepLabel(kind, action),
          transactionIndex,
          requiresWalletSignature: true,
        }
      }),
    }
    return { action, poolAddress, resourceAddress, transactions, additionalSigners, plan }
  }

  private stepLabel(
    kind: MeteoraTransactionPlanStep['kind'],
    action: MeteoraTransactionBundle['action'],
  ): string {
    if (kind === 'setup') return 'Prepare token accounts'
    if (kind === 'swap') return 'Balance pool tokens'
    if (kind === 'ledger') return 'Record Zap balances'
    if (kind === 'cleanup') return 'Close temporary accounts'
    if (action === 'zap_in') return 'Create position and add liquidity'
    if (action === 'place_limit_order') return 'Place limit order'
    if (action === 'create_position') return 'Create position and add liquidity'
    return action.replaceAll('_', ' ')
  }
}

function decimalSolToLamports(value: Decimal.Value): string {
  return new Decimal(value).mul(1_000_000_000).toDecimalPlaces(0, Decimal.ROUND_CEIL).toFixed(0)
}

function atomicToDecimal(value: string, decimals: number): string {
  if (decimals === 0) return value
  const padded = value.padStart(decimals + 1, '0')
  const whole = padded.slice(0, -decimals) || '0'
  const fraction = padded.slice(-decimals).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}
