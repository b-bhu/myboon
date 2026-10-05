/** Meteora previews and pending records currently support Solana mainnet only. */
export function assertMeteoraWalletNetwork(network: 'mainnet-beta' | 'devnet'): void {
  if (network !== 'mainnet-beta') {
    throw new Error('Meteora requires a Solana mainnet wallet. Switch the app wallet network to mainnet before continuing.');
  }
}
