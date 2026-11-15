/**
 * Meteora — shared action panel body, PURE core (the venue adapter factory).
 *
 * Faithful port of the wiring `MeteoraPoolPhaseTwoScreen.tsx` uses for its
 * 'position' tab. The venue is side-less on the surface (fundingMode 'both',
 * singleTokenSide 'x'); the underlying position form still carries the
 * 'position' | 'limit' split — this body only ever builds a
 * MeteoraPositionDraft, which is what ships today. Nothing forecloses
 * wiring the limit tab later.
 *
 * Same rules as every other body: execution modules stay untouched. The
 * adapter here IS the one the screen uses (meteoraPhaseTwoAdapter, the
 * guarded fallback: previews compute, execute throws where the platform
 * cannot sign). One deliberate deviation is noted at `submit`: the screen
 * executes the cached preview from state; the shell re-prepares right
 * before execute so a stale preview can never fire. preparePosition is
 * read-only/idempotent, execute is the same entry point today's screen
 * calls.
 *
 * Side-less default: the shell amount is the X deposit; an optional Y
 * override switches to manual two-token funding. Y empty → autoFill.
 *
 * PURE — no react, no react-native, so this stays `tsx --test`-able.
 * `meteora.action.tsx` re-exports everything here and adds the Inputs
 * panel.
 */

import type {
  ActionAmountState,
  ActionSummaryRow,
  ActionVenueAdapter,
} from '@/features/markets/action/action.contract';
import {
  EMPTY_POSITION_DRAFT,
  type MeteoraExecuteResult,
  type MeteoraExecutionUpdate,
  type MeteoraPhaseTwoAdapter,
  type MeteoraPhaseTwoPreview,
  type MeteoraPositionDraft,
  type MeteoraPrepareContext,
} from '@/features/meteora/meteora.form';
import { meteoraPhaseTwoAdapter } from '@/features/meteora/meteora.form-execution';
import { validateMeteoraPositionDraft } from '@/features/meteora/meteora.position-validation';

/** Everything the shell's amount field does not cover. */
export interface MeteoraActionBody {
  /**
   * Y-side override. '' (default) = auto-fill: both sides funded from the
   * shell amount. Non-empty = manual two-token funding.
   */
  amountYText: string;
}

export const EMPTY_METEORA_ACTION_BODY: MeteoraActionBody = {
  amountYText: '',
};

/**
 * The screen's prepare-context verbatim. The screen already builds this
 * exact object for every preparePosition call — MeteoraActionDeps hands the
 * builder here instead of re-deriving wallet/connection/freshness fields.
 */
export interface MeteoraActionDeps {
  /** Screen's existing prepare-context builder; null when wallet is missing. */
  prepareContext: () => MeteoraPrepareContext | null;
  /** Screen-computed freshness verdict (its existing stale-pool gate). */
  poolFresh: boolean;
  /** X symbol for the amount caption/suffix, from the pool at mount. */
  amountSymbol: string | null;
  /** Screen's refresh call, run after a confirmed submit. */
  refresh: () => void;
  /**
   * The screen's existing range/preset state as a draft partial — the fields
   * it already sets when building a position draft (preset,
   * requestedMinPrice/MaxPrice, strategy). EMPTY_POSITION_DRAFT is preset
   * 'manual' with empty prices, which validates as 'Enter minimum price',
   * so the range MUST come from the screen's state for both defaults and
   * parity with the range UI.
   */
  positionDraftBase: () => Partial<MeteoraPositionDraft>;
  /** Screen's progress hook, forwarded to execute unchanged. */
  onProgress?: (update: MeteoraExecutionUpdate) => void;
  /** Test seam; defaults to meteoraPhaseTwoAdapter. */
  adapter?: MeteoraPhaseTwoAdapter;
}

export const buildMeteoraActionDraft = (
  body: MeteoraActionBody,
  amount: ActionAmountState,
  positionDraftBase: () => Partial<MeteoraPositionDraft>,
): MeteoraPositionDraft => {
  const amountYText = body.amountYText.trim();
  const autoFill = amountYText === '';
  return {
    ...EMPTY_POSITION_DRAFT,
    ...positionDraftBase(),
    amountX: amount.amountText.trim(),
    amountY: autoFill ? '' : amountYText,
    autoFill,
  };
};

const blockingWarning = (preview: MeteoraPhaseTwoPreview) =>
  preview.warnings.find((w) => w.blocking) ?? null;

export function createMeteoraActionAdapter(
  deps: MeteoraActionDeps,
): ActionVenueAdapter<MeteoraActionBody, void> {
  const adapter = () => deps.adapter ?? meteoraPhaseTwoAdapter;
  // Set by quote(), read by tests; submit re-prepares so this is advisory.
  let lastPreview: MeteoraPhaseTwoPreview | null = null;

  return {
    venueId: 'meteora',
    kind: 'lp',
    label: 'Meteora',
    amountLabel: () =>
      deps.amountSymbol ? `AMOUNT (${deps.amountSymbol})` : 'AMOUNT',
    amountPrefix: () => null,
    amountSuffix: () => deps.amountSymbol,

    confirm: () => ({
      label: 'Swipe to add liquidity',
      accent: 'accent',
    }),

    validate(body, context) {
      const amount = context.amount.amountValue;
      if (amount === null || amount <= 0) {
        return {
          title: 'Enter an amount',
          detail: 'Enter the amount to deposit.',
        };
      }
      if (!deps.poolFresh) {
        return {
          title: 'Refresh pool data',
          detail: 'Pool pricing is stale. Pull to refresh, then try again.',
        };
      }
      const ctx = deps.prepareContext();
      if (!ctx) {
        return {
          title: 'Connect your wallet',
          detail: 'Connect a wallet to add liquidity.',
        };
      }
      const draft = buildMeteoraActionDraft(body, context.amount, deps.positionDraftBase);
      const result = validateMeteoraPositionDraft({
        draft,
        tokenX: ctx.pool.tokenX,
        tokenY: ctx.pool.tokenY,
      });
      if (!result.valid) {
        return {
          title: result.blockerLabel ?? 'Fix the form',
          detail:
            result.amountXError ??
            result.amountYError ??
            result.rangeError ??
            null,
        };
      }
      return null;
    },

    async quote(body, context) {
      const amount = context.amount.amountValue;
      if (amount === null || amount <= 0) {
        return { rows: [], loading: false, unavailableReason: null };
      }
      if (!deps.poolFresh) {
        return {
          rows: [],
          loading: false,
          unavailableReason: 'Pool data is stale — pull to refresh.',
        };
      }
      const ctx = deps.prepareContext();
      if (!ctx) {
        return {
          rows: [],
          loading: false,
          unavailableReason: 'Connect a wallet to preview.',
        };
      }
      try {
        const preview = await adapter().preparePosition(
          ctx,
          buildMeteoraActionDraft(body, context.amount, deps.positionDraftBase),
        );
        lastPreview = preview;
        const rows: ActionSummaryRow[] = [];
        if (preview.currentPrice) {
          rows.push({
            key: 'ENTRY PRICE',
            value: preview.currentPrice,
            tone: 'dim',
          });
        }
        if (preview.executableMinPrice && preview.executableMaxPrice) {
          rows.push({
            key: 'EXECUTABLE RANGE',
            value: `${preview.executableMinPrice} – ${preview.executableMaxPrice}`,
          });
        }
        if (preview.costs) {
          for (const cost of preview.costs) {
            rows.push({
              key: cost.label.toUpperCase(),
              value: cost.value,
              tone: 'dim',
            });
          }
        }
        const blocking = blockingWarning(preview);
        if (blocking) {
          rows.push({ key: 'WARNING', value: blocking.message, tone: 'neg' });
        }
        if (rows.length === 0) {
          return {
            rows: [],
            loading: false,
            unavailableReason: 'Preview unavailable.',
          };
        }
        return { rows, loading: false, unavailableReason: null };
      } catch {
        return {
          rows: [],
          loading: false,
          unavailableReason: 'Preview unavailable — adjust and retry.',
        };
      }
    },

    async submit(body, context) {
      const amount = context.amount.amountValue;
      if (amount === null || amount <= 0) {
        return { status: 'rejected', message: 'Enter an amount first.' };
      }
      const ctx = deps.prepareContext();
      if (!ctx) {
        return {
          status: 'rejected',
          message: 'Connect a wallet to add liquidity.',
        };
      }
      const adapterImpl = adapter();
      const draft = buildMeteoraActionDraft(body, context.amount, deps.positionDraftBase);
      try {
        // Deliberate deviation (documented in the head): the screen fires the
        // cached preview; the shell re-prepares so execute never sees a stale
        // one. preparePosition is read-only; execute is the screen's entry.
        const preview = await adapterImpl.preparePosition(ctx, draft);
        lastPreview = preview;
        const blocking = blockingWarning(preview);
        if (blocking) {
          return { status: 'rejected', message: blocking.message };
        }
        if (!preview.canExecute) {
          return {
            status: 'rejected',
            message:
              'Preview is not executable — adjust the amount and try again.',
          };
        }
        const result: MeteoraExecuteResult = await adapterImpl.execute(
          ctx,
          preview,
          deps.onProgress,
        );
        if (result.state === 'cancelled') {
          return { status: 'rejected', message: result.message };
        }
        if (result.state === 'partial') {
          deps.refresh();
          // Sheet stays open: the position may need a top-up/retry (recovery).
          return { status: 'partial', message: result.message, closeAfter: false };
        }
        deps.refresh();
        // Meteora keeps recovery visible per the contract — no closeAfter,
        // the shell default keeps the sheet up with progress + explorer.
        return {
          status: 'submitted',
          message: result.message,
          closeAfter: false,
        };
      } catch (error) {
        return {
          status: 'rejected',
          message:
            error instanceof Error && error.message
              ? error.message
              : 'Could not execute — try again.',
        };
      }
    },
  };
}
