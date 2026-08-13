/**
 * Token identity: the pure core.
 *
 * The `TokenIdentity` shape and the ref grammar, with ZERO imports — no react,
 * no react-native, no `lib/api`. This exists as its own module for one reason:
 * the venue row mapper modules (the per-venue `.rows.ts` files) are unit tested
 * under `tsx --test`, which crashes the moment react-native enters the graph.
 * `lib/token-identity.ts` legitimately needs React hooks and `lib/api`, so the
 * two-line pure builders live here and both sides import them.
 *
 * Do NOT re-inline copies of `mintRef`/`perpRef` into a rows file to dodge an
 * import error. The ref grammar is a wire contract shared with the server
 * (`packages/api/src/tokens/types.ts`); duplicated copies drift silently, and a
 * drifted prefix means every icon stops resolving with nothing failing loudly.
 * Import from here instead.
 *
 * See docs/modules/wallet/specs/token_identity.md.
 */

/**
 * Frozen response contract — the server builds against this exact shape.
 * Note there is deliberately no price field, and there must never be one:
 * identity owns what a token IS, never what it is worth. See the spec's
 * "What this service does not own".
 */
export interface TokenIdentity {
  key: string;
  assetId: string | null;
  symbol: string;
  name: string;
  iconUrl: string | null;
  decimals: number | null;
  mint: string | null;
  verified: boolean;
  category: 'crypto' | 'stablecoin' | 'equity' | 'commodity' | 'unknown';
  fallbackLetter: string;
  source: 'snapshot' | 'venue' | 'helius' | 'static';
}

/** Build a ref for an SPL mint. */
export function mintRef(mint: string): string {
  return `mint:${mint}`;
}

/**
 * Build a ref for a perp market symbol, kept exactly as given — case and any
 * `-PERP` suffix preserved. Case matters: the denominated markets (`kPEPE`,
 * `kBONK`, `kSHIB`) resolve against an exact-cased icon host, so uppercasing a
 * symbol anywhere on the way to an icon URL breaks them.
 */
export function perpRef(venueSymbol: string): string {
  return `perp:${venueSymbol}`;
}
