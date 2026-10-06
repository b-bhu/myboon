import { resolveSolanaRpcUrl, resolveSolanaRpcWsUrl } from '@/lib/rpc';

const env = (process.env.EXPO_PUBLIC_PACIFIC_ENV as 'mainnet' | 'testnet') || 'mainnet';

export const PACIFIC_ENV = env;

export const PACIFIC_REST =
  env === 'testnet'
    ? 'https://test-api.pacifica.fi/api/v1'
    : 'https://api.pacifica.fi/api/v1';

export const PACIFIC_WS =
  env === 'testnet'
    ? 'wss://test-ws.pacifica.fi/ws'
    : 'wss://ws.pacifica.fi/ws';

export const SOLANA_RPC = resolveSolanaRpcUrl(env === 'testnet' ? 'devnet' : 'mainnet');
export const SOLANA_RPC_WS = resolveSolanaRpcWsUrl(env === 'testnet' ? 'devnet' : 'mainnet');

// USDC-P on devnet, USDC on mainnet
export const USDC_MINT =
  env === 'testnet'
    ? 'USDPqRbLidFGufty2s3oizmDEKdqx7ePTqzDMbf5ZKM'
    : 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export const USDC_DECIMALS = 6;

export const USDC_LABEL = env === 'testnet' ? 'USDC-P' : 'USDC';

// On-chain deposit program addresses
export const PACIFIC_PROGRAM_ID =
  env === 'testnet'
    ? 'peRPsYCcB1J9jvrs29jiGdjkytxs8uHLmSPLKKP9ptm'
    : 'PCFA5iYgmqK6MqPhWNKg7Yv7auX7VZ4Cx7T1eJyrAMH';

export const PACIFIC_CENTRAL_STATE =
  env === 'testnet'
    ? '2zPRq1Qvdq5A4Ld6WsH7usgCge4ApZRYfhhf5VAjfXxv'
    : '9Gdmhq4Gv1LnNMp7aiS1HSVd7pNnXNMsbuXALCQRmGjY';

export const PACIFIC_VAULT =
  env === 'testnet'
    ? '5SDFdHZGTZbyRYu54CgmRkCGnPHC5pYaN27p7XGLqnBs'
    : '72R843XwZxqWhsJceARQQTTbYtWy6Zw9et2YV4FpRHTa';

export const PACIFIC_MIN_DEPOSIT = 10;

export const PACIFIC_BUILDER_CODE = process.env.EXPO_PUBLIC_PACIFIC_BUILDER_CODE || '';
