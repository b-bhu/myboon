/**
 * Venue-generic action contract — the order/quote side of the venue adapter.
 *
 * Complements `venue.contract.ts` (which owns market *listing*) with what a
 * venue needs to render inside one shared trade/action sheet. The SHELL never
 * knows what a venue means by "confirm": each adapter states its accent, the
 * swipe label, the validation, the quote rows and the submit call. Execution
 * modules (phoenix.execution, perps.signed-api, polymarket.signing,
 * meteora.execution) stay untouched — adapters call exactly the entry points
 * today's screens call, so a change how any venue signs is out of scope here.
 *
 * PURE — no react, no react-native, so this stays `tsx --test`-able.
 */

import type { VenueAdapter } from '@/features/markets/venue.contract';

/** Venues that ship an action panel today. Orca is list-only. */
export type ActionVenueId = Exclude<VenueAdapter['venueId'], 'orca'>;

export type ActionVenueKind = VenueAdapter['kind'];

/** Accent used for confirm swipe + primary tint. Never decorative (DESIGN.md §1). */
export type ActionAccent = 'pos' | 'neg' | 'accent';

/** Tones for quote key-value rows: matches MarketListRow's CellTone. */
export type ActionSummaryTone = 'neutral' | 'dim' | 'pos' | 'neg';

/**
 * The amount the shell owns. Adapters parse the value once via
 * `parseActionAmount` (stored on `amountValue`) instead of re-parsing text.
 */
export interface ActionAmountState {
  amountText: string;
  /** Parsed amount, > 0, or null when empty/invalid. */
  amountValue: number | null;
}

/** One quote/preview key-value row, e.g. { key: 'EST. FEE', value: '$0.07' }. */
export interface ActionSummaryRow {
  key: string;
  value: string;
  tone?: ActionSummaryTone;
}

/**
 * Live quote/preview state. `loading` shows placeholders; `unavailableReason`
 * non-null means the quote cannot be shown right now (stale book, closed
 * market) and replaces the rows.
 */
export interface ActionQuote {
  rows: readonly ActionSummaryRow[];
  loading: boolean;
  unavailableReason: string | null;
}

/** Blocking validation: non-null means confirm stays inert. */
export interface ActionValidation {
  title: string;
  detail: string | null;
}

/**
 * What a submit call produces. The shell maps these to sheet behavior:
 * `submitted` → haptic-less close + venue refresh; `partial` → close with
 * message (Pacifica's TP/SL set can fail after the fill); `rejected` → sheet
 * stays open with the message so the user can retry or back out.
 */
export interface ActionSubmitOutcome {
  status: 'submitted' | 'partial' | 'rejected';
  message: string;
  /** When false the shell stays open even on submitted (Meteora keeps recovery visible). */
  closeAfter?: boolean;
}

/** Everything a body/adapter needs: parsed amount + screen-provided extras. */
export interface ActionPanelContext<TExtra> {
  amount: ActionAmountState;
  extra: TExtra;
}

export interface ActionConfirmSpec {
  label: string;
  accent: ActionAccent;
}

/**
 * One venue's contribution to the panel. Bodies handle their own extra inputs
 * (side, limit price, strategy…); everything the shell renders comes from here.
 *
 * Adapters are wired per-screen by thin `*.action.tsx` modules that compose
 * these (phoenix.action, pacifica.action, polymarket.action, meteora.action).
 */
export interface ActionVenueAdapter<TBody, TExtra> {
  venueId: ActionVenueId;
  kind: ActionVenueKind;
  /** Venue name for the sheet header pill, e.g. 'Phoenix'. */
  label: string;
  /** Mono caption above the amount, e.g. 'YOU PAY' / 'AMOUNT (USD)' / 'COLLATERAL'. */
  amountLabel: (body: TBody) => string;
  /** '$' or null — before the amount text. */
  amountPrefix: (body: TBody) => string | null;
  /** Trailing unit, e.g. 'PYUSD', 'USDC', or null. */
  amountSuffix: (body: TBody) => string | null;
  /** Confirm call-to-action, e.g. 'Swipe to long · $50'. */
  confirm: (body: TBody, amount: ActionAmountState) => ActionConfirmSpec;
  /** Blocking validation, recomputed on every render. */
  validate: (body: TBody, context: ActionPanelContext<TExtra>) => ActionValidation | null;
  /** Live quote/preview rows; called on body/amount/context changes. */
  quote: (body: TBody, context: ActionPanelContext<TExtra>) => Promise<ActionQuote> | ActionQuote;
  /**
   * The actual order/position action. MUST be the same call path today's
   * screen uses (guardrails, pending-order bookkeeping, refreshes included).
   */
  submit: (body: TBody, context: ActionPanelContext<TExtra>) => Promise<ActionSubmitOutcome>;
}

/**
 * Shell-side amount parsing: `$`, `,`, spaces are separators; a trailing '-'
 * or non-numeric input is invalid (null). Returns > 0 or null — zero/negatives
 * never count as amounts so "MAX" and confirm gates read naturally.
 */
export function parseActionAmount(raw: string): number | null {
  const text = raw.replace(/[$,\s]/g, '').replace(/^(-|\+)+/, '');
  if (text === '' || !/^\d*\.?\d*$/.test(text) || !/\d/.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

/**
 * Formats the amount the way the shell's mono big-number expects: no grouping,
 * trims trailing zeros, keeps a leading zero. Returns '' for null.
 */
export function formatActionAmount(
  value: number | null,
  opts: { maxDecimals?: number } = {},
): string {
  if (value == null || !Number.isFinite(value)) return '';
  const maxDecimals = Math.max(0, Math.min(8, opts.maxDecimals ?? 4));
  let text = value.toFixed(maxDecimals);
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  return text === '' ? '0' : text;
}
