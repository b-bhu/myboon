import type { WalletSummary } from './types.js'

/**
 * One full valid `WalletSummary` (#722): reused by the API tests and the
 * app's mock data. It is typed as `WalletSummary`, so a shape drift here
 * fails `pnpm --filter @myboon/shared typecheck`.
 */
export const walletSummaryFixture: WalletSummary = {
  solana: '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAspL7ojmnbG7nLq',
  evm: '0xf70da97812cb96acdf810712aa562c6119a4bd4d',
  fetchedAt: '2026-07-21T12:00:00Z',
  apps: {
    polymarket: {
      status: 'ok',
      valueUsd: 8231.75,
      summary: {
        cashUsd: 1250.5,
        openPositionsValueUsd: 6750,
        readyToCollectUsd: 231.25,
        totalPnlUsd: 980.75,
        openPositionCount: 7,
      },
    },
    phoenix: {
      status: 'ok',
      valueUsd: 43012.4,
      summary: {
        equityUsd: 43012.4,
        collateralUsd: 39500,
        unrealizedPnlUsd: 512.2,
        positionCount: 2,
        positions: [
          { symbol: 'BTC', size: 0.42, unrealizedPnlUsd: 401.1 },
          { symbol: 'ETH', size: 4.5, unrealizedPnlUsd: 111.1 },
        ],
      },
    },
    pacifica: {
      status: 'ok',
      valueUsd: 12855.9,
      summary: {
        equityUsd: 12855.9,
        availableToSpendUsd: 9621.4,
        unrealizedPnlUsd: null,
        positionCount: 1,
        positions: [{ symbol: 'SOL', size: 120, unrealizedPnlUsd: -54.3 }],
      },
    },
    meteora: {
      status: 'ok',
      valueUsd: 10562.35,
      summary: {
        poolCount: 2,
        totalPools: 3,
        hasMore: true,
        unclaimedFeesUsd: 18.4,
        totalPnlUsd: 402.18,
        pools: [
          { name: 'SOL/USDC', valueUsd: 8421.75, unclaimedFeesUsd: 12.3, outOfRange: false },
          { name: 'JUP/USDC', valueUsd: 2140.6, unclaimedFeesUsd: 6.1, outOfRange: null },
        ],
      },
    },
    spot: {
      status: 'ok',
      valueUsd: 5322.75,
      summary: {
        tokenCount: 2,
        tokens: [
          {
            mint: 'So11111111111111111111111111111111111111112',
            symbol: 'SOL',
            iconUrl: 'https://example.invalid/icons/sol.png',
            valueUsd: 5310.25,
          },
          { mint: 'ExampleMint111111111111111111111111111111111', symbol: null, iconUrl: null, valueUsd: 12.5 },
        ],
      },
    },
  },
}
