import type {
  SpotDataApiClient,
  SpotTokenBalance,
} from '@myboon/shared/spot';

type WalletBalanceClient = Pick<SpotDataApiClient, 'getWalletBalances'>;

export interface MeteoraBalanceTokenInput {
  address: string;
  decimals: number;
}

export interface MeteoraBalanceTokens {
  tokenX: MeteoraBalanceTokenInput;
  tokenY: MeteoraBalanceTokenInput;
}

export interface MeteoraWalletBalance {
  atomic: bigint;
  display: string;
}

export interface MeteoraWalletBalances {
  x: MeteoraWalletBalance;
  y: MeteoraWalletBalance;
}

/**
 * Formats an unsigned atomic token amount without converting through Number.
 * Trailing fractional zeroes are omitted while zero remains "0".
 */
export function formatWalletAtomicAmount(amount: string, decimals: number): string {
  assertUnsignedAtomicAmount(amount, 'amount');
  assertDecimals(decimals, 'decimals');
  const normalized = BigInt(amount).toString();
  if (decimals === 0) return normalized;

  const padded = normalized.padStart(decimals + 1, '0');
  const splitAt = padded.length - decimals;
  const whole = padded.slice(0, splitAt);
  const fraction = padded.slice(splitAt).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * Reads and aggregates the exact two pool-token balances from the injected
 * Spot balance client. The raw atomic strings remain the source of truth.
 */
export async function readMeteoraWalletBalances(
  client: WalletBalanceClient,
  walletAddress: string,
  tokens: MeteoraBalanceTokens,
): Promise<MeteoraWalletBalances> {
  if (!walletAddress) throw new Error('walletAddress is required');
  assertTokenInput(tokens.tokenX, 'tokenX');
  assertTokenInput(tokens.tokenY, 'tokenY');
  if (
    tokens.tokenX.address === tokens.tokenY.address
    && tokens.tokenX.decimals !== tokens.tokenY.decimals
  ) {
    throw new Error('tokenX and tokenY use different decimals for the same mint');
  }

  const result = await client.getWalletBalances(walletAddress);
  if (!result || !result.data || !result.freshness) {
    throw new Error('Invalid wallet balance response');
  }
  if (result.freshness.state === 'stale') {
    throw new Error('Wallet balance response is stale');
  }
  if (result.freshness.state !== 'live' && result.freshness.state !== 'fresh') {
    throw new Error('Invalid wallet balance freshness');
  }
  if (result.data.wallet !== walletAddress) {
    throw new Error('Wallet balance response belongs to a different wallet');
  }
  if (!Array.isArray(result.data.tokens)) {
    throw new Error('Invalid wallet token balances');
  }

  const sums = new Map<string, bigint>();
  for (const token of result.data.tokens) {
    validateTokenRow(token);
    sums.set(token.mint, (sums.get(token.mint) ?? 0n) + BigInt(token.amount));
  }

  return {
    x: balanceForToken(sums, result.data.tokens, tokens.tokenX),
    y: balanceForToken(sums, result.data.tokens, tokens.tokenY),
  };
}

function balanceForToken(
  sums: Map<string, bigint>,
  rows: SpotTokenBalance[],
  token: MeteoraBalanceTokenInput,
): MeteoraWalletBalance {
  const matchingRows = rows.filter((row) => row.mint === token.address);
  for (const row of matchingRows) {
    if (row.decimals !== token.decimals) {
      throw new Error(`Unexpected decimals for ${token.address}`);
    }
  }
  const atomic = sums.get(token.address) ?? 0n;
  return {
    atomic,
    display: formatWalletAtomicAmount(atomic.toString(), token.decimals),
  };
}

function validateTokenRow(token: SpotTokenBalance): void {
  if (!token || typeof token.mint !== 'string' || !token.mint) {
    throw new Error('Invalid token mint in wallet balance response');
  }
  assertUnsignedAtomicAmount(token.amount, `amount for ${token.mint}`);
  assertDecimals(token.decimals, `decimals for ${token.mint}`);
}

function assertTokenInput(token: MeteoraBalanceTokenInput, name: string): void {
  if (!token || typeof token.address !== 'string' || !token.address) {
    throw new Error(`${name}.address is required`);
  }
  assertDecimals(token.decimals, `${name}.decimals`);
}

function assertUnsignedAtomicAmount(value: string, name: string): void {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`Invalid unsigned integer ${name}`);
  }
}

function assertDecimals(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${name}`);
  }
}
