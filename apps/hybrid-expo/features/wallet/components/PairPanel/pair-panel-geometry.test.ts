/**
 * Pure tests for PairPanel geometry (#732). Plain functions only — no UI.
 * Named in the issue: the dial's snap picks the centred chain (rounding and
 * clamping at both ends), and the wire clamps to the list edge when the
 * selected row is scrolled out of view.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  centredDialIndex,
  dialCentredOffsetPx,
  DIAL_ITEM_PX,
  LIST_HEIGHT_PX,
  ROW_PITCH_PX,
  listTopForIndex,
  rowCentreY,
  WIRE_BOTTOM_INSET_PX,
  WIRE_TOP_INSET_PX,
  wireAnchorY,
} from './pair-panel-geometry';

test('dial snap: rounding picks the centred chain', () => {
  // A dial resting on a chain sits at an exact multiple of the item width.
  assert.equal(centredDialIndex(0, 5), 0);
  assert.equal(centredDialIndex(DIAL_ITEM_PX, 5), 1);
  assert.equal(centredDialIndex(DIAL_ITEM_PX * 3, 5), 3);
  // Between items: fractional offsets round to the nearer item (mock Math.round).
  assert.equal(centredDialIndex(DIAL_ITEM_PX * 1.5, 5), 2);
  assert.equal(centredDialIndex(DIAL_ITEM_PX * 2.4, 5), 2);
  assert.equal(centredDialIndex(DIAL_ITEM_PX * 1.4, 5), 1);
  // A snapped index centres on its own exact offset.
  assert.equal(dialCentredOffsetPx(0), 0);
  assert.equal(dialCentredOffsetPx(4), DIAL_ITEM_PX * 4);
});

test('dial snap: clamps at both ends', () => {
  // Overscrolling past the first item can never select less than index 0.
  assert.equal(centredDialIndex(-DIAL_ITEM_PX * 3, 5), 0);
  assert.equal(centredDialIndex(-DIAL_ITEM_PX * 0.4, 5), 0);
  // …nor more than the last item, whatever the drag does.
  assert.equal(centredDialIndex(DIAL_ITEM_PX * 9, 3), 2);
  assert.equal(centredDialIndex(10000, 5), 4);
  // An empty dial keeps its zero index instead of crashing.
  assert.equal(centredDialIndex(DIAL_ITEM_PX * 2, 0), 0);
});

test('list top: a changed selection scrolls to row top − 44, clamped at 0', () => {
  // Row 0 and 1 sit above the 44px offset, so the list stays at its top edge.
  assert.equal(listTopForIndex(0), 0);
  assert.equal(listTopForIndex(1), 0);
  // Row 2 onward scrolls to row top − 44 (mock `seeSelected`).
  assert.equal(listTopForIndex(2), 2 * ROW_PITCH_PX - 44);
  assert.equal(listTopForIndex(5), 5 * ROW_PITCH_PX - 44);
});

test('wire anchor: a visible selected row is drawn unclamped', () => {
  // Row 2 at rest sits 2 rows deep; its centre is 2*40 + 20 = 100.
  const visible = rowCentreY(2, 0);
  assert.equal(visible, 100);
  assert.equal(wireAnchorY(visible), 100);
  // Partially scrolled but still on screen: anchor follows the scroll exactly.
  assert.equal(wireAnchorY(rowCentreY(3, ROW_PITCH_PX / 2)), 120);
});

test('wire anchor: clamps to the list edge when the selected row scrolls out of view', () => {
  // Scrolled deep enough that the selected row has gone past the top edge.
  const aboveTop = rowCentreY(0, ROW_PITCH_PX * 6); // 20 - 240 = -220
  assert.equal(wireAnchorY(aboveTop), WIRE_TOP_INSET_PX);
  // At rest with the selected row beyond the 231px viewport's bottom edge.
  const belowBottom = rowCentreY(8, 0); // 8*40 + 20 = 340
  assert.ok(belowBottom > LIST_HEIGHT_PX);
  assert.equal(wireAnchorY(belowBottom), LIST_HEIGHT_PX - WIRE_BOTTOM_INSET_PX);
  // Both bounds hold for any overshoot, not just the fixtures above.
  assert.equal(wireAnchorY(-10), WIRE_TOP_INSET_PX);
  assert.equal(wireAnchorY(LIST_HEIGHT_PX), LIST_HEIGHT_PX - WIRE_BOTTOM_INSET_PX);
});
