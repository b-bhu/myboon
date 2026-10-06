import React, { useMemo } from 'react';
import { ConnectionProvider, WalletProvider as SolanaWalletProvider } from '@solana/wallet-adapter-react';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { useStandardWalletAdapters } from '@solana/wallet-standard-wallet-adapter-react';
import { SOLANA_RPC, SOLANA_RPC_WS } from '@/features/perps/pacific.config';

const endpoint = SOLANA_RPC;
const config = { commitment: 'confirmed' as const, wsEndpoint: SOLANA_RPC_WS };

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const fallbackWallets = useMemo(() => [new PhantomWalletAdapter()], []);
  const wallets = useStandardWalletAdapters(fallbackWallets);

  return (
    <ConnectionProvider endpoint={endpoint} config={config}>
      <SolanaWalletProvider wallets={wallets} autoConnect>
        {children}
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}
