/**
 * Realistic sample data for Feed prototype screens. Only render through
 * MockOnly / withMock (feed-mocks.ts) so real builds never expose sample rows.
 */
export type FeedFixtureKeyNumber = {
  label: string;
  value: string | number;
};

export type FeedFixtureEventMove = {
  asset: string;
  move: number;
};

export type FeedFixtureWalletStat = {
  address: string;
  pnl7d: number;
  winRate: number;
  rank: number;
};

export const FEED_FIXTURES: {
  storyCatchUp: string[];
  storyKeyNumbers: FeedFixtureKeyNumber[];
  eventLastTime: FeedFixtureEventMove[];
  walletStats: FeedFixtureWalletStat[];
  tokenSparklines: Record<string, number[]>;
} = {
  storyCatchUp: [
    'Fed minutes point to a slower pace of cuts',
    'Bitcoin ETFs logged a third straight day of net inflows',
    'Solana DEX volume cooled to a one-month low',
    'Meteora opened two new LST vaults with double-digit APRs',
    'ETH staking inflows picked up ahead of the upgrade',
  ],
  storyKeyNumbers: [
    { label: 'NET P&L · 7D', value: 2148.75 },
    { label: 'WIN RATE · 30D', value: '58.2%' },
    { label: 'ACTIVE POSITIONS', value: 6 },
  ],
  eventLastTime: [
    { asset: 'SOL', move: 3.1 },
    { asset: 'BTC', move: -0.4 },
    { asset: 'ETH', move: 1.2 },
    { asset: 'JUP', move: -2.7 },
  ],
  walletStats: [
    {
      address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      pnl7d: 2148.75,
      winRate: 0.582,
      rank: 42,
    },
    {
      address: '9WzDXwBbmkg8ZTbNMqUxvQ3yrhpyHmmqNSjCjmJJfS2d',
      pnl7d: -312.4,
      winRate: 0.417,
      rank: 977,
    },
    {
      address: '4Nd1mBQtrMJVYVfKf2PJy9TZU8Upif4dTpFBZXPZKbuF',
      pnl7d: 8621.1,
      winRate: 0.731,
      rank: 3,
    },
  ],
  tokenSparklines: {
    SOL: [186.4, 188.2, 187.0, 190.9, 189.5, 192.3, 191.0, 194.8, 196.2, 195.1, 197.6, 199.4],
    BTC: [71240, 70980, 71150, 70600, 70310, 70580, 70120, 70990, 70870, 71130, 70940, 70960],
    ETH: [2610, 2618, 2604, 2632, 2641, 2628, 2652, 2644, 2660, 2672, 2654, 2676],
    JUP: [0.82, 0.81, 0.815, 0.8, 0.79, 0.785, 0.77, 0.76, 0.775, 0.752, 0.748, 0.735],
  },
};