/**
 * Shared wallet `Move` types: the app-facing contract for a Relay quote and an
 * intent status, served by the MyBoon API, which holds the Relay key (Decision
 * Log D55: the key never ships in the app). Field facts come from the #724
 * Relay spike (docs + live read-only quotes, 2026-11-21):
 *
 * - `timeEstimate` is in seconds.
 * - The fee split a quote shows is `relayer` (execution), the app fee (set per
 *   quote in bps) and the swap cost; origin gas is paid by the wallet in the
 *   source chain's native token.
 * - `GET /intents/status/v3` answers `waiting`, `depositing`, `pending`,
 *   `submitted`, `success`, `failure`, `refund` and `unknown`; only `success`
 *   and `refund` are final, and `failure` can go back to `pending` (retry).
 *
 * Fields the spike did not confirm are deliberately absent. All amounts are
 * decimal strings, never numbers, so large base-unit values survive the trip
 * between app and API unchanged.
 */

/** One side of a Move: which chain, which currency and how much. */
export interface WalletMoveQuoteLeg {
  /** Relay chain id (Solana `792703809`, Base `8453` at launch). */
  chainId: number
  /** The currency Relay quotes: a token address (base58 on Solana, hex on EVM) or a native-currency symbol. */
  currency: string
  /** Base-unit amount, decimal string. */
  amount: string
  /** USD value, decimal string. */
  amountUsd: string
}

/**
 * A quote's fee split as the Move slider shows it: execution, app, swap cost.
 * `execution` and `app` are charged in the input token; Relay reports their
 * USD value alongside, and the origin gas is a separate wallet cost.
 */
export interface WalletMoveQuoteFees {
  /** Relay execution fee in USD (`fees.relayer`: the flat fee plus the destination fill gas). */
  executionUsd: string
  /** App fee in USD, when the quote set one in `appFees` (bps of the input). */
  appUsd?: string
  /** Swap cost in USD: the value given up between the input side and the receive side of the quote. */
  swapUsd: string
  /** Origin gas the wallet pays, in the source chain's native token (`fees.gas`, lamports on Solana), when the quote prices it. */
  gas?: string
}

/**
 * The app-facing Move quote: the route (source and destination legs), the fee
 * split, the time estimate and the signing step. `POST /wallet/move/quote`
 * maps this from Relay's `POST /quote/v2`.
 */
export interface WalletMoveQuote {
  /** Relay request id; the app sends it back to poll status. */
  requestId: string
  /** Where the move starts. */
  source: WalletMoveQuoteLeg
  /** Where the move lands — for a Polymarket deposit this is the deposit wallet on Polygon. */
  destination: WalletMoveQuoteLeg
  fees: WalletMoveQuoteFees
  /** Estimated total move time in seconds (Relay `details.timeEstimate`). */
  timeEstimateSeconds: number
  /**
   * Relay's signing data for this quote, passed through untouched for the app
   * to review and sign. The API never parses or alters it.
   */
  step: unknown
}

/**
 * Result of a Move quote request. Routes outside the launch scope — Solana and
 * Base — come back as `route_not_supported` with a plain reason instead of a
 * quote.
 */
export type WalletMoveQuoteResult =
  | { result: 'quoted'; quote: WalletMoveQuote }
  | {
      result: 'route_not_supported'
      /** The rejected route. */
      sourceChainId: number
      destinationChainId: number
      /** Plain, app-displayable reason. */
      reason: string
    }

/** The eight Relay intent status values (`GET /intents/status/v3`, #724 spike). */
export type WalletMoveRelayStatus =
  | 'waiting'
  | 'depositing'
  | 'pending'
  | 'submitted'
  | 'success'
  | 'failure'
  | 'refund'
  | 'unknown'

/**
 * User-facing move state: `WalletMoveRelayStatus` mapped down.
 *
 * - `pending` covers `waiting`, `depositing`, `pending`, `submitted`,
 *   `unknown` (an id Relay does not know yet polls as `unknown`) and
 *   `failure`, which can go back to `pending` (retry) and is therefore not
 *   final on its own.
 * - `done` covers `success`.
 * - `failed` covers `refund` (funds returned to the source) and `failure`
 *   once Relay reports a failed refund (`refundFailReason`): nothing left to
 *   retry.
 */
export type WalletMoveState = 'pending' | 'done' | 'failed'

/** Polling response for one Move: `GET /wallet/move/status/:requestId`. */
export interface WalletMoveStatus {
  /** Relay request id this status is for. */
  requestId: string
  /** Mapped user-facing state. */
  state: WalletMoveState
  /** Raw Relay status behind `state` — the step the move is on right now. */
  relayStatus: WalletMoveRelayStatus
  /** True when polling can stop: `success` and `refund` are Relay's only final statuses, plus a `failure` with `refundFailReason`. */
  final: boolean
  /** Destination fill transaction hashes, when Relay reports them. */
  txHashes: string[]
  /** Set on `failure` when Relay reports a failed refund — the only non-`refund` status that still ends the move. */
  refundFailReason?: string
}
