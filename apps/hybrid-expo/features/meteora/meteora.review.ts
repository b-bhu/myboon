import type { MeteoraPoolDetail, MeteoraStrategy } from '@myboon/shared/meteora';
import type { MeteoraPhaseTwoPreview } from './meteora.form';
import type { MeteoraPreviewCost } from './meteora.form';

export interface MeteoraPositionReview {
  pool: MeteoraPoolDetail;
  preview: MeteoraPhaseTwoPreview;
  inputKey: string;
  walletAddress: string;
  amountX: string;
  amountY: string;
  strategy: MeteoraStrategy;
  inverted: boolean;
  addMode: boolean;
  costs?: MeteoraPreviewCost[];
  transactionCount?: number;
}

/** Consent applies only to the exact quote and inputs shown in the review. */
export function isMeteoraReviewCurrent(
  review: MeteoraPositionReview | null,
  preview: MeteoraPhaseTwoPreview | null,
  context: {
    inputKey: string;
    poolAddress: string | null;
    walletAddress: string | null;
    ready: boolean;
    nowMs?: number;
  },
): boolean {
  if (!review || !preview || !context.ready) return false;
  return review.preview === preview
    && review.inputKey === context.inputKey
    && review.pool.address === context.poolAddress
    && !!context.walletAddress
    && review.walletAddress === context.walletAddress
    && preview.walletAddress === context.walletAddress
    && preview.canExecute
    && !preview.warnings.some((warning) => warning.blocking)
    && Date.parse(preview.expiresAt) > (context.nowMs ?? Date.now());
}
