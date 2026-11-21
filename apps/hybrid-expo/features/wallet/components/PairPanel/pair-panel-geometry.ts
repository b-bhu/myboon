/**
 * PairPanel pure geometry — the shared Swap/Move two-column piece (#732).
 *
 * Sizes come from the locked design (wallet.html at 37e0a51, "Swap and Move:
 * two columns", wiki, Decision Log D54). Lists are 231px there, not the mock's
 * older `.rows { height: 258px }` rule — the two-column layout overrides the
 * mock to 231px in the 430px panel.
 *
 * Plain functions, so the dial snap and the wire clamp are testable without
 * React Native.
 */

export const DIAL_WIDTH_PX = 100;
export const DIAL_HEIGHT_PX = 34;
/** One dial item is 36px apart; the item centred on the gold tick is selected. */
export const DIAL_ITEM_PX = 36;
/** Side padding that lets the first and last dial items reach the centre. */
export const DIAL_SIDE_PAD_PX = (DIAL_WIDTH_PX - DIAL_ITEM_PX) / 2;
/** The mock fades the dial edges over this much of its width (mask at 24%/76%). */
export const DIAL_FADE_PX = 24;
/** Two columns with a 20px wire gutter between them (mock `.bay` grid). */
export const WIRE_GUTTER_PX = 20;
/** The column header above each list ("header 36" in the locked tokens). */
export const HEADER_HEIGHT_PX = 36;
export const LIST_HEIGHT_PX = 231;
export const ROW_HEIGHT_PX = 38;
export const ROW_GAP_PX = 2;
/** Row pitch: one 38px row plus the 2px list gap. */
export const ROW_PITCH_PX = ROW_HEIGHT_PX + ROW_GAP_PX;
/** A scrolled-out row's anchor sits at least this far below the list's top edge. */
export const WIRE_TOP_INSET_PX = 14;
/** …and at least this far above the list's bottom edge (mock `.bay` clamp). */
export const WIRE_BOTTOM_INSET_PX = 4;

/** The dial index a raw scroll offset snaps to: rounding picks the centred
 * item, then both ends clamp into the list (mock `Math.round(cur / DW) * DW`). */
export function centredDialIndex(offsetPx: number, itemCount: number, itemPx = DIAL_ITEM_PX): number {
  if (itemCount <= 0) return 0;
  return Math.max(0, Math.min(itemCount - 1, Math.round(offsetPx / itemPx)));
}

/** The scroll offset that centres the dial item at `index`. */
export function dialCentredOffsetPx(index: number, itemPx = DIAL_ITEM_PX): number {
  return index * itemPx;
}

/** Unclamped y of a row's centre in its list's own scroll space. */
export function rowCentreY(rowIndex: number, scrollTopPx: number, pitchPx = ROW_PITCH_PX): number {
  return rowIndex * pitchPx + pitchPx / 2 - scrollTopPx;
}

/**
 * One wire end: the row centre, clamped to the visible edge of that end's
 * list when the selected row has scrolled out of view (mock `clamp`).
 */
export function wireAnchorY(rowCentreYPx: number, viewportHeightPx = LIST_HEIGHT_PX): number {
  return Math.max(WIRE_TOP_INSET_PX, Math.min(viewportHeightPx - WIRE_BOTTOM_INSET_PX, rowCentreYPx));
}
