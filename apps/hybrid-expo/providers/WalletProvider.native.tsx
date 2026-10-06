import React from 'react';
import { MobileWalletProvider } from '@wallet-ui/react-native-web3js';
import { PACIFIC_ENV, SOLANA_RPC, SOLANA_RPC_WS } from '@/features/perps/pacific.config';

const cluster = PACIFIC_ENV === 'testnet' ? 'devnet' : 'mainnet-beta';
const chain = `solana:${cluster === 'devnet' ? 'devnet' : 'mainnet-beta'}` as const;
const endpoint = SOLANA_RPC;
const commitmentOrConfig = { commitment: 'confirmed' as const, wsEndpoint: SOLANA_RPC_WS };

const identity = {
  name: 'myboon',
  uri: 'https://myboon.xyz',
  icon: 'favicon.png',
};

export function WalletProvider({ children }: { children: React.ReactNode }) {
  return (
    <MobileWalletProvider
      chain={chain}
      endpoint={endpoint}
      commitmentOrConfig={commitmentOrConfig}
      identity={identity}
    >
      {children}
    </MobileWalletProvider>
  );
}
