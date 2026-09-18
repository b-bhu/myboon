# Reusable Market Chart v1 PRD

Status: implemented; automated verification complete; owner visual/manual validation pending
Date: 2026-09-05
Owner: myboon Apps
First integration: Phoenix perpetual market detail
Component working name: `MarketChart`

Scope freeze (2026-09-16): V1 ships the reusable OHLCV chart only. Story,
trade, wallet, holder, thesis, and other bubble/marker overlays are deferred to
the next phase. Any marker requirements or examples retained later in this
document are phase-two design notes, not V1 acceptance criteria. The shipping
V1 contract contains candles, line mode, volume, current price, axes, candle
inspection, history loading, and chart navigation.

Approved interaction mock: `docs/mockups/chart-component-lab.html`

One-page visual summary: `docs/modules/charts/PRDs/2026_09_05_market_chart_v1_visual_PRD.png`

Related product context: `docs/modules/wallet/PRDs/2026_08_12_wallet_completion_meme_trader_PRD.md` (`SPOT-P2-05 — Advanced chart interaction`)

How to read this document: the approved mock is the visual and interaction reference. This PRD is the scope, ownership, data-contract, and acceptance reference. If the two conflict, update the mock and this PRD in the same change rather than silently choosing one.

---

## 1. Executive summary

myboon needs one reusable, mid-level market chart for screens that already have time-series data and need a familiar way to display it. Version 1 turns the approved HTML/JavaScript mock into a React Native component for the Expo app. The implementation is complete on `codex/market-chart-v1`; this document also records the final contract and the remaining owner-run visual/manual checks.

The component is deliberately dumb. It receives normalized OHLCV data and presentation options. It renders those inputs and emits interaction events. It does not fetch, cache, subscribe, choose a venue, understand a token, or calculate a timeframe.

The first production consumer is Phoenix because Phoenix already exposes ordered OHLCV candles. Its detail screen will continue to own timeframe selection and data loading. The current Phoenix line chart will be replaced with `MarketChart`, first in candlestick mode and then with the line-mode toggle exposed by the screen.

Version 1 includes:

- candlestick and close-price line rendering;
- volume and current-price layers;
- pan, pinch-to-zoom, long-press inspection, and pinned selection;
- latest-edge following and double-tap reset;
- loading, empty, error, and ready presentation states;
- keyboard and screen-reader equivalents where the platform supports them;
- a stable normalized data contract that future Spot, Predict, and other screens can adopt without bringing venue logic into the chart.

Version 1 is not a TradingView clone. It adopts the interaction grammar users already know while excluding indicators, drawing tools, order placement, chart-managed data, and desktop terminal parity.

---

## 2. Product problem

myboon currently has multiple chart implementations that each solve a narrow screen problem:

- `features/perps/PhoenixPriceChart.tsx` receives OHLCV candles but renders only a close-price SVG line and owns its own fetching and timeframe controls;
- `features/perps/PacificaPriceChart.tsx` has another venue-specific path;
- Predict has `MultiLineChart.tsx`, `CycleChart.tsx`, and additional small chart implementations;
- marker selection, scrub behavior, formatting, errors, and accessibility vary by consumer.

This creates four problems.

1. A screen cannot request a standard candlestick chart without building one.
2. Rendering and venue/data concerns are coupled, so reuse requires copy-paste.
3. Interaction behavior differs between screens even when the visual is similar.
4. Future overlays—wallet trades, holder activity, theses, or stories—risk expanding each chart into another monolith.

The desired product is not “more charting features.” It is a stable rendering foundation whose boundaries let product teams add only the features their screen needs.

---

## 3. User and product jobs

### 3.1 Primary user

A myboon user who recognizes common TradingView-style chart interactions and wants to inspect how an asset or market changed over time without entering a professional terminal.

### 3.2 Primary user jobs

- See price direction and volatility at a glance.
- Switch between a precise candlestick view and a simpler line view.
- Inspect one historical candle and its OHLC values.
- Pan backward into history without being snapped back to the latest price.
- Return to the live edge in one action.
- Understand whether a highlighted event or trade happened at a specific time.
- Continue using the chart with touch, pointer, keyboard, or assistive technology.

### 3.3 Screen-owner jobs

- Choose the market, venue, timeframe, and query.
- Fetch and normalize the data.
- Choose which chart mode and layers are visible.
- Format values for the product context.
- Render controls around the chart.
- React to viewport, candle-selection, marker-selection, retry, and live-edge events.

### 3.4 Engineering job

Add a new chart capability as a small layer or configuration extension without rewriting coordinate, viewport, gesture, and selection behavior.

---

## 4. Goals

1. Ship the approved mock behavior as a React Native v1 component.
2. Keep venue, API, token, timeframe, and product-language decisions outside the component.
3. Make Phoenix the first real-data proof using its existing OHLCV endpoint.
4. Give every future consumer one normalized input contract.
5. Make candlestick and line modes share the same axes, viewport, selection, and layer system.
6. Preserve smooth interaction for the expected mobile candle counts.
7. Provide deterministic behavior when live data replaces or appends a candle.
8. Make chart interactions accessible without requiring a touch gesture.
9. Keep the architecture open to holder/trade/story overlays without including those product meanings in the core.

---

## 5. Non-goals for v1

- TradingView SDK integration or pixel parity.
- Technical indicators such as RSI, MACD, moving averages, or Bollinger Bands.
- User-authored drawings, trend lines, annotations, or saved layouts.
- Order entry, order modification, position management, or trading actions.
- Chart-owned API calls, polling, subscriptions, caching, or retry policy.
- Chart-owned timeframe, interval, market-cap/price, or venue controls.
- Automatic conversion between price, market cap, probability, or percentage.
- Automatic candle aggregation from trades or smaller intervals.
- Depth charts, order books, heat maps, or liquidation maps.
- Multi-pane indicators.
- Comparison of multiple assets in one chart.
- Full desktop keyboard/mouse terminal behavior.
- Server-side rendering.
- A new historical provider for Spot.
- Replacing every existing myboon chart in the first release.
- Arbitrary third-party plug-ins executing inside the chart.

---

## 6. Locked product decisions

| Question | V1 decision |
|---|---|
| Component level | Mid-level reusable market chart |
| Ownership | Consuming screen owns meaning and data; chart owns rendering and interaction |
| Data model | Normalized, ordered OHLCV candles |
| First consumer | Phoenix perpetual market detail |
| Initial chart modes | Candlestick and close-price line |
| Initial optional layers | Volume, current price, event/trade markers |
| Interaction reference | TradingView-familiar mobile behavior |
| Default state | Latest candles fitted at the live edge |
| Historical behavior | Preserve the viewport and expose that the user is away from live |
| Selection behavior | Long press activates; release leaves selection pinned |
| Reset behavior | Double tap returns to latest auto-fit and clears selection |
| Controls | Parent/screen renders mode, timeframe, and layer controls |
| Data loading | Parent/screen fetches, retries, caches, and streams |
| Rendering dependency | `react-native-svg` first; no new native drawing dependency for v1 |
| Extension style | Composable built-in layers; no inheritance hierarchy |
| Spot adoption | Deferred until an approved historical candle source exists |

---

## 7. Product principles

### 7.1 Render only

The component may hold ephemeral presentation state such as viewport, gesture phase, and pinned selection. It may not hold product or server state.

### 7.2 Parent owns meaning

`MarketChart` does not know whether a marker represents the current user, a whale, a story, a thesis, or a liquidation. It receives a marker with display fields and returns its identifier when selected.

### 7.3 Familiar before novel

Gestures match the mental model users bring from TradingView: drag to pan, pinch to zoom, long press to inspect, and double tap to reset.

### 7.4 Layers stay small

Candles, line, volume, current price, crosshair, axes, and markers remain independent rendering concerns. Adding one does not fork the chart engine.

### 7.5 No fabricated market data

Missing volume stays missing or zero according to the adapter contract. The chart never invents candles, smooths missing history into fake points, or interprets interval-change statistics as historical prices.

### 7.6 Degrade honestly

The chart shows an explicit loading, empty, or error state supplied by its parent. It does not preserve stale geometry behind an error without the parent intentionally passing stale data as ready.

---

## 8. Ownership boundary

### 8.1 The consuming screen owns

- asset, market, and venue identity;
- API selection and request parameters;
- timeframe labels and interval/count mapping;
- loading lifecycle and cancellation;
- refresh, retry, cache, and subscription strategy;
- conversion into `MarketCandle[]`;
- mode and layer controls;
- price, time, volume, and marker formatting;
- product copy for empty and error states;
- whether live updates are enabled;
- whether the screen exposes a separate reset-to-live control;
- analytics and business event names;
- action sheets or navigation opened from a marker;
- persistence, if a screen wants to remember a chosen mode or timeframe.

### 8.2 `MarketChart` owns

- scale calculation;
- plot bounds and axis geometry;
- visible-window calculation;
- candlestick and line drawing;
- volume, current-price, marker, axis, and crosshair layers;
- pan, pinch, long-press, scrub, tap, and double-tap arbitration;
- hit testing inside the plot;
- pinned candle and marker selection;
- live-edge detection;
- viewport preservation across candle updates;
- keyboard and accessibility actions;
- performance-oriented clipping and visible-item selection;
- presentation of the supplied loading, empty, and error state.

### 8.3 `MarketChart` must never import

- `phoenix.api.ts`;
- `pacifica.api.ts`;
- Jupiter, Polymarket, or venue-specific clients;
- wallet state;
- route state;
- market identity registries;
- query/cache libraries;
- trade execution code;
- product analytics SDKs.

---

## 9. Conceptual architecture

```text
PhoenixMarketDetailScreen
  └─ PhoenixPriceChart
       ├─ chooses symbol + timeframe + mode + visible layers
       ├─ fetches PhoenixCandle[] with cancellation
       ├─ adapts PhoenixCandle[] -> MarketCandle[]
       ├─ renders controls and state copy
       └─ renders MarketChart
       ├─ ChartFrame
       ├─ ViewportController
       ├─ GestureController
       ├─ Scale + geometry functions
       ├─ CandlestickLayer or LineLayer
       ├─ VolumeLayer
       ├─ CurrentPriceLayer
       ├─ MarkerLayer
       ├─ CrosshairLayer
       └─ AxisLayer
```

The visual order is deterministic:

1. grid;
2. volume;
3. primary price series (candles or line);
4. current-price rule and label;
5. event/trade markers;
6. crosshair and selected point;
7. axes and labels.

This order is an internal rendering contract. Consumers configure layers but do not reorder v1 internals.

---

## 10. Public component contract

The exact names may change during implementation, but the boundary must remain equivalent to the following.

```ts
export type MarketChartMode = 'candles' | 'line';

export interface MarketCandle {
  timeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
}

export interface MarketChartMarker {
  id: string;
  timeMs: number;
  label: string;
  detail?: string;
  imageUri?: string;
  initials?: string;
  tone?: 'positive' | 'negative' | 'neutral' | 'accent';
  accessibilityLabel: string;
}

export type MarketChartStatus =
  | { kind: 'ready' }
  | { kind: 'loading'; accessibilityLabel?: string }
  | { kind: 'empty'; title: string; description?: string }
  | {
      kind: 'error';
      title: string;
      description?: string;
      retryLabel?: string;
    };

export interface MarketChartLayers {
  volume?: boolean;
  currentPrice?: boolean;
  markers?: boolean;
}

export interface MarketChartSelection {
  candle: MarketCandle | null;
  candleIndex: number | null;
  marker: MarketChartMarker | null;
}

export interface MarketChartViewport {
  startTimeMs: number | null;
  endTimeMs: number | null;
  visibleStartIndex: number;
  visibleEndIndex: number;
  atLiveEdge: boolean;
}

export interface MarketChartProps {
  seriesKey: string;
  candles: readonly MarketCandle[];
  mode: MarketChartMode;
  status?: MarketChartStatus;
  layers?: MarketChartLayers;
  markers?: readonly MarketChartMarker[];
  height?: number;
  minimumVisibleCandles?: number;
  initialVisibleCandles?: number;
  formatPrice: (value: number) => string;
  formatAxisPrice?: (value: number) => string;
  formatTime: (timeMs: number) => string;
  formatVolume?: (value: number) => string;
  accessibilityLabel: string;
  onSelectionChange?: (selection: MarketChartSelection) => void;
  onViewportChange?: (viewport: MarketChartViewport) => void;
  onMarkerPress?: (marker: MarketChartMarker) => void;
  onRetry?: () => void;
  resetSignal?: number;
}
```

### 10.1 Contract rules

- `candles` is required and defaults to an empty array at the caller.
- `seriesKey` is required and changes only when market/interval identity changes, not for ordinary data refreshes.
- `mode` is controlled by the parent.
- Layer visibility is controlled by the parent.
- `status` defaults to `{ kind: 'ready' }`.
- `height` defaults to a component token suitable for a market detail screen.
- `initialVisibleCandles` defaults to 54, matching the approved mock.
- `minimumVisibleCandles` defaults to 14, matching the approved mock.
- `resetSignal` is incremented by the parent only when an external control requests the same reset as a double tap.
- Callbacks report presentation events; they do not imply analytics.
- Formatter functions are required where product context changes units or precision.
- `formatAxisPrice` defaults to `formatPrice` and lets a parent provide shorter right-axis labels without reducing inspector precision.
- The component does not mutate `candles` or `markers`.

### 10.2 Controlled versus internal state

Controlled by parent:

- data;
- mode;
- layer visibility;
- status;
- formatting;
- explicit reset request.

Internal and ephemeral:

- current viewport;
- gesture state;
- pinned candle timestamp identity;
- selected marker identifier;
- measured plot size;
- cached geometry for the current render.

The parent observes internal state through callbacks but does not need to mirror it on every gesture frame.

---

## 11. Normalized candle contract

### 11.1 Required invariants

Every candle passed as ready data must satisfy:

- `timeMs` is a finite Unix timestamp in milliseconds;
- OHLC values are finite numbers;
- `high >= max(open, close)`;
- `low <= min(open, close)`;
- `high >= low`;
- candles are strictly ordered by ascending `timeMs`;
- no two candles share the same `timeMs`;
- `volume`, when present, is finite and non-negative.

### 11.2 Adapter behavior

Venue adapters, not `MarketChart`, resolve malformed server data. A shared helper may:

- reject rows with missing or non-finite required values;
- sort rows by time;
- keep the final value for duplicate timestamps;
- coerce absent volume to `null` rather than inventing activity;
- report diagnostics in development and test builds.

### 11.3 Timestamp identity

`timeMs` is the stable identity for update and viewport preservation. Array position is an implementation detail and may change when older history is prepended.

### 11.4 Update shapes

The component must correctly handle:

1. full replacement after timeframe or symbol change;
2. replacement of the current last candle at the same timestamp;
3. append of one or more new candles;
4. prepend of older history;
5. corrected historical candles with stable timestamps;
6. transition from loading/error/empty to ready.

---

## 12. Layer model

### 12.1 Primary series layer

Exactly one primary series renders in v1:

- `candles`: wick plus body using positive/negative semantic colors;
- `line`: close values connected by one path, with no curve that invents values.

Switching mode preserves the current viewport. Selection remains on the same timestamp if that candle still exists.

### 12.2 Volume layer

- Anchored to the lower portion of the same plot.
- Uses candle direction to distinguish positive and negative bars.
- Does not add a second pane in v1.
- Hidden automatically when no visible candle has usable volume.
- Does not change price-domain calculation.

### 12.3 Current-price layer

- Draws a horizontal rule at the latest close.
- Displays a right-edge label using `formatPrice`.
- Uses the positive or negative direction tone for the latest candle.
- Stays based on the latest candle even while a historical candle is selected.

### 12.4 Marker layer

- Receives display-ready markers from the parent.
- Positions each marker at the candle with the same timestamp.
- Omits markers whose timestamp does not identify an available candle.
- Supports multiple markers at one candle by grouping them into one visible anchor.
- Returns the exact selected marker identifier.
- Keeps business details out of the chart engine.

### 12.5 Crosshair layer

- Appears after long-press activation or keyboard selection.
- Uses the selected candle's x position.
- Shows a horizontal price guide only if it remains legible on the mobile plot.
- Never obscures the complete candle body with an opaque surface.

### 12.6 Axis layer

- Price labels appear on the right.
- Time labels appear at the bottom.
- Labels use parent formatters.
- Tick density responds to available width.
- Labels must not overlap, clip, or imply unsupported precision.

---

## 13. Rendering behavior

### 13.1 Plot domain

The price domain uses visible candles only and includes their highs and lows. It adds a small deterministic vertical padding so the highest wick and lowest wick never touch the plot boundary.

### 13.2 Horizontal geometry

The horizontal scale uses candle slots, not raw pixel interpolation between irregular timestamps. Time labels still show the candle timestamps. This keeps widths stable for venue candle sets with missing intervals while avoiding fake candles.

### 13.3 Candle geometry

- Wick width stays visually crisp at supported pixel ratios.
- Body width scales with slot width within a clamped minimum and maximum.
- A candle whose open equals close renders a visible one-pixel body.
- Up and down meaning uses both color and geometry/readout text.

### 13.4 Line geometry

- The line connects close values in candle order.
- No spline smoothing in v1.
- No filled area by default unless design review explicitly adds it.
- The selected value uses a visible point marker.

### 13.5 Clipping

All price, volume, marker stems, and crosshair marks clip to the plot bounds. Axis labels and marker detail surfaces render outside the clip only in reserved space.

### 13.6 Pixel density

Rendering accounts for device pixel ratio and must remain crisp on common iOS, Android, and web densities.

---

## 14. Interaction contract

### 14.1 Gesture state machine

The internal interaction states are:

- `idle`;
- `press-pending`;
- `panning`;
- `pinching`;
- `inspecting`;
- `marker-pressed`.

Only one state owns an input stream at a time. A second touch immediately promotes a pending press to pinch and cancels long-press activation.

### 14.2 Pan

- One-finger horizontal drag pans time.
- A movement beyond 6 logical pixels cancels pending long press.
- Vertical movement must not accidentally scrub a candle before activation.
- Panning clamps at the earliest and latest available candle.
- Panning away from the latest edge disables live following.
- Normal pan does not change zoom.

### 14.3 Pinch zoom

- Two-finger pinch zooms around the midpoint between the fingers.
- Zoom clamps between `minimumVisibleCandles` and the complete data length.
- Pinch cancels pending selection.
- The candle under the pinch midpoint remains approximately anchored.
- Ending pinch leaves the resulting viewport in place.

### 14.4 Pointer-wheel zoom

On web or pointer-enabled platforms:

- wheel/trackpad vertical delta changes horizontal zoom;
- the pointer x position is the zoom anchor;
- default page scrolling is prevented only while the pointer is over the plot and the chart consumes the zoom;
- zoom uses the same clamps as pinch.

### 14.5 Long-press inspection

- A stationary press activates inspection after 330 ms.
- Activation selects the nearest candle to the pointer x position.
- Dragging after activation scrubs through candles.
- Values update at most once per animation frame.
- Release keeps the final candle pinned.
- A tap elsewhere in the plot clears the pinned candle unless it hits a marker.

### 14.6 Marker selection

- A short tap within a marker hit target selects the marker.
- Marker hit targets are at least 44 logical pixels even if the visible mark is smaller.
- Selecting a marker also selects its mapped candle.
- The component emits `onMarkerPress(marker)` once per completed tap.
- Panning that begins on a marker cancels marker activation after the drag threshold.
- The parent decides whether selection opens a sheet, navigates, or only updates a detail row.

### 14.7 Double tap

- Two taps within the platform-recognized interval reset the chart.
- Reset restores the latest auto-fit viewport.
- Reset clears candle and marker selection.
- Reset restores live following.
- Reset does not change mode, timeframe, or layer visibility.

### 14.8 Keyboard

When the chart has focus on web or a keyboard-capable device:

- Left Arrow selects the previous candle.
- Right Arrow selects the next candle.
- Arrow selection scrolls into view when necessary.
- Escape clears candle and marker selection.
- End jumps to the latest edge and clears selection.
- Enter/Space activates a focused marker through the platform accessibility action.

---

## 15. Selection and readout

The chart draws the selected state, but the parent owns the full textual inspector. This matches the approved mock while keeping product content outside the engine.

### 15.1 Default readout

With no pinned selection, the callback selection is null. The parent reads the final item in `candles` and may label it “Latest candle” or “Live.”

### 15.2 Candle selection

`onSelectionChange` emits:

- the selected candle;
- its current array index;
- `marker: null`.

The Phoenix parent displays time plus Open, High, Low, and Close using Phoenix price formatting.

### 15.3 Marker selection

`onSelectionChange` emits the mapped candle and marker. The parent replaces the OHLC inspector with display-ready marker detail, as shown in the approved mock.

### 15.4 Clear selection

Clearing emits `candle: null`, `candleIndex: null`, and `marker: null`. The parent then returns its readout to the latest candle.

### 15.5 Data changes while selected

- Same timestamp still present: keep the selection and emit the updated candle.
- Timestamp removed: clear selection.
- Older history prepended: selection follows timestamp, not old index.
- New live candle appended: pinned historical selection remains pinned.

---

## 16. Viewport and live-edge behavior

### 16.1 Initial fit

Ready data initially shows the latest `min(initialVisibleCandles, data.length)` candles and reports `atLiveEdge: true`.

### 16.2 Live edge

The viewport counts as live when its end is within one quarter of a candle slot from the latest available slot. This avoids flicker from fractional gesture coordinates.

### 16.3 Last-candle replacement

If the latest candle changes at the same timestamp:

- the viewport stays unchanged;
- scales recompute from visible OHLC values;
- pinned selection at that timestamp updates;
- `atLiveEdge` does not change.

### 16.4 New-candle append while live

If one or more candles append while the user is at live:

- keep the visible candle count;
- move the viewport end to the newest candle;
- preserve selection only if explicitly pinned;
- report `atLiveEdge: true`.

### 16.5 New-candle append while historical

If candles append while the user is away from live:

- preserve the visible start and end timestamps;
- do not move the viewport;
- report `atLiveEdge: false`;
- remain historical until the user invokes a supported reset gesture or the parent changes `resetSignal`.

### 16.6 Older-history prepend

Preserve the viewport by timestamp. Prepending must not visually jump the candles the user was inspecting.

### 16.7 Return to live

The shared chart does not render a fixed product button. It returns to the latest fitted viewport through double tap, the web `End` key, or an external `resetSignal` change. Phoenix v1/v2 intentionally does not add a visible “Jump to live” action; this product decision supersedes the earlier mock exploration while keeping the generic reset contract available to future consumers.

### 16.8 Timeframe or symbol change

The parent supplies a new series identity by remount key or explicit reset signal. The chart clears selection and applies initial fit. A normal data refresh for the same series must not reset the viewport.

---

## 17. Parent-owned controls

The Phoenix screen initially exposes:

- chart mode: Candles / Line;
- timeframe: 1H / 1D / 1W / 1M;
- volume visibility;
- marker visibility when markers exist.

The exact Phoenix mapping remains:

| Label | Phoenix interval | Requested count |
|---|---:|---:|
| 1H | `1m` | 60 |
| 1D | `15m` | 96 |
| 1W | `1h` | 168 |
| 1M | `4h` | 180 |

Changing a parent control:

- clears pinned selection;
- retains the chosen mode when timeframe changes;
- retains layer choices when timeframe changes;
- starts the parent loading lifecycle for a new query;
- resets to latest fit when ready data arrives.

The chart receives only the resulting props. It does not render or inspect the control row.

---

## 18. Data and state lifecycle

### 18.1 Loading

- Parent passes `status.kind = 'loading'`.
- Chart renders a reduced-motion-aware skeleton inside the plot bounds.
- Axes and stale series do not remain visible.
- Accessibility label announces that chart data is loading.
- Controls may stay visible but the parent decides whether they are disabled.

### 18.2 Ready

- At least two valid candles render a price series.
- A single valid candle may render a current-value state but not a misleading line.
- Volume appears only when enabled and available.
- Marker layer appears only when enabled and non-empty.

### 18.3 Empty

- Parent supplies title and optional description.
- Chart renders no axes or price geometry.
- No retry action appears unless product explicitly models the state as error.

### 18.4 Error

- Parent supplies title and optional description.
- Chart renders a retry action only when `onRetry` exists.
- Retry label defaults to “Retry” but is parent-overridable.
- Tapping retry calls the parent once and does not change status internally.

### 18.5 Stale data

Staleness is a product/data concern. If a screen intentionally renders stale candles, it passes ready data and displays a stale badge outside the chart. The chart does not infer staleness from timestamps.

---

## 19. Phoenix v1 integration

### 19.1 Existing source

`fetchPhoenixCandles(symbol, interval, count)` already returns ascending `PhoenixCandle[]` with:

- `time`;
- `open`;
- `high`;
- `low`;
- `close`;
- `volume`;
- optional quote volume, trade count, and external source.

### 19.2 Adapter

Phoenix maps data without business transformation:

```ts
function toMarketCandle(candle: PhoenixCandle): MarketCandle {
  return {
    timeMs: candle.time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  };
}
```

Phoenix-only fields remain outside the shared chart unless a future generic layer has a real cross-product use case.

### 19.3 Refactor target

`PhoenixPriceChart.tsx` becomes the Phoenix container rather than the renderer. It:

- owns timeframe and mode state;
- fetches candles;
- maps Phoenix data;
- maps Phoenix story/demo events into generic marker display data;
- renders the control row and textual inspector;
- passes callbacks to update the market-detail price readout;
- renders `MarketChart`.

### 19.4 Market detail behavior

`PhoenixMarketDetailScreen.tsx` continues to receive:

- latest price changes through the Phoenix container;
- selected candle price/time while inspecting;
- null selection when inspection clears.

No order-form behavior changes in this release.

### 19.5 Existing story markers

Bitcoin demo/story events may be adapted into generic chart markers for parity. The generic chart must not import `BTC_DEMO_EVENTS`, `mapPhoenixChartEvents`, or Phoenix types.

---

## 20. Visual design contract

The implementation follows the approved mock and existing myboon semantic tokens.

### 20.1 Palette

- screen/background: `#073B4C` through `semantic.background.screen`;
- ground: `#063343` through the semantic theme;
- surface/lift: existing teal surface tokens;
- border: `#185A70` or semantic equivalent;
- primary text: `#F5FAFC` or semantic equivalent;
- positive: `#06D6A0`;
- negative: `#EF476F`;
- secondary chart accent: existing cyan/primary token;
- selected/event accent: `#FFD166` where the parent chooses accent tone.

Hardcoded colors inside shared chart code are prohibited when a semantic token exists.

### 20.2 Typography

- Numerical readouts use the app's monospaced numerical style.
- Axes use the smallest readable existing token, never below the app's 9px floor.
- Values use tabular numerals where supported.
- The shared chart does not choose title or header typography.

### 20.3 Density

- Minimum touch targets are 44 logical pixels.
- Plot height is configurable; Phoenix starts at a reviewed mobile height.
- Axis reserves space for the longest formatted visible value.
- Marker bubbles clamp within the chart width.

### 20.4 Motion

- Gestures move geometry directly; no decorative entrance animation.
- Mode changes may use a short geometry transition only if it remains responsive.
- Reduced-motion preference removes non-essential transitions and skeleton shimmer.
- No looping pulse on the latest price.

---

## 21. Accessibility contract

### 21.1 Accessible summary

The component exposes the parent-provided `accessibilityLabel` plus a concise current state, for example: “BTC perpetual price chart, candlestick mode, 96 candles, latest price 64,218 dollars.”

### 21.2 Adjustable actions

The chart exposes platform accessibility actions equivalent to:

- increment: next candle;
- decrement: previous candle;
- activate: activate the current marker or begin candle inspection;
- escape/dismiss: clear selection;
- jump to end when supported.

### 21.3 Selected value

The accessibility value includes:

- formatted time;
- open;
- high;
- low;
- close;
- marker label when a marker is selected.

### 21.4 Color independence

Positive and negative candles differ through accessible text and body direction, not only green/red color. Marker labels and tones are announced.

### 21.5 Focus and order

- Parent controls precede the chart in native focus order.
- The chart is one adjustable region rather than one focus target per candle.
- Any consumer-provided reset-to-live action follows the chart or sits in a predictable overlay order without trapping focus.

### 21.6 Dynamic announcements

Scrubbing must not flood screen readers. Announce a value only after keyboard/action selection or after a throttled settled touch selection, not for every raw move event.

---

## 22. Performance requirements

### 22.1 Supported v1 range

- Target up to 2,000 normalized candles in memory.
- Render only visible candles plus a small overscan.
- Initial Phoenix requests remain 60–180 candles.
- Target common plot widths from 320 to 768 logical pixels.

### 22.2 Interaction budget

- Pan and pinch should visually update at 60 fps on supported recent devices.
- No more than one React state commit per animation frame during a gesture.
- Parent callbacks may be throttled separately from internal drawing.
- Formatter functions must not execute once per candle on every pointer move.

### 22.3 Computation

- Visible min/max is calculated from the visible slice, not the full series on every frame.
- Geometry helpers are pure and separately testable.
- Marker-to-candle mapping is memoized by candle and marker identity.
- Paths and candle shapes are recomputed only when data, dimensions, mode, layers, or viewport change.

### 22.4 Dependencies

V1 uses installed dependencies:

- `react-native-svg` for visual marks;
- `react-native-gesture-handler` for composed gestures;
- the app's existing Reanimated installation remains available, but the v1 chart does not require Reanimated-owned chart state.

Adding Skia, a web canvas abstraction, TradingView, or another native renderer requires a separate architecture decision with bundle-size and platform review.

---

## 23. Failure and edge cases

The implementation must define and test:

- zero candles;
- one candle;
- all candles at the same close;
- extremely small decimal prices;
- large notional values;
- zero volume across the range;
- missing volume;
- gaps in time;
- duplicate timestamps rejected by adapter;
- invalid OHLC rejected by adapter;
- markers before or after the available range;
- multiple markers on one candle;
- a selected candle removed by refresh;
- history prepended while viewing the middle;
- latest candle replaced while live;
- multiple candles appended while historical;
- width changing during orientation or responsive layout;
- app backgrounding during an active gesture;
- pointer cancellation;
- reduced-motion mode;
- right-to-left app layout while price/time values remain semantically ordered.

---

## 24. Proposed file map

```text
apps/hybrid-expo/features/charts/
  market-chart.tsx
  market-chart.types.ts
  market-chart.normalization.ts
  market-chart.geometry.ts
  market-chart.viewport.ts
  market-chart.markers.ts
  market-chart.accessibility.ts
  market-chart.boundary.test.ts
  market-chart.normalization.test.ts
  market-chart.markers.test.ts
  market-chart.accessibility.test.ts
  market-chart.geometry.test.ts
  market-chart.viewport.test.ts
  index.ts

apps/hybrid-expo/features/perps/
  PhoenixPriceChart.tsx              # becomes consumer/container
  phoenix.chart-adapter.ts           # Phoenix -> normalized chart types
  phoenix.chart-adapter.test.ts
  phoenix.chart-config.ts
  phoenix.chart-config.test.ts
```

Gesture composition and SVG layers are intentionally consolidated in `market-chart.tsx`; normalization, geometry, viewport, marker, and accessibility rules remain pure and independently testable without rendering React Native UI.

---

## 25. Implementation sequence

### Phase 0 — Contract lock

1. Review this PRD against the approved mock.
2. Confirm the public type names and parent/component boundary.
3. Confirm Phoenix remains the first and only release consumer.
4. Record any change to locked decisions in this document.

### Phase 1 — Pure engine

1. Add normalized candle and marker types.
2. Add candle validation/normalization helper for adapters.
3. Add viewport calculation and timestamp-preservation functions.
4. Add scale and visible-domain geometry functions.
5. Cover pure functions with unit tests.

### Phase 2 — Static rendering

1. Add chart frame and measurement.
2. Add grid and axes.
3. Add candlestick layer.
4. Add line layer.
5. Add volume layer.
6. Add current-price layer.
7. Verify narrow and wide layouts.

### Phase 3 — Interaction

1. Add pan and clamp behavior.
2. Add pinch and pointer-wheel zoom.
3. Add long-press, scrub, and pinned selection.
4. Add marker hit testing and selection.
5. Add double-tap/external reset.
6. Add live-edge callbacks.
7. Add keyboard and accessibility actions.

### Phase 4 — Presentation states

1. Add loading skeleton.
2. Add empty state.
3. Add error and retry action.
4. Add reduced-motion behavior.

### Phase 5 — Phoenix migration

1. Add Phoenix adapter.
2. Convert `PhoenixPriceChart` to a container.
3. Preserve existing callbacks into `PhoenixMarketDetailScreen`.
4. Adapt existing demo/story markers.
5. Add Candles/Line controls.
6. Add Volume/Markers controls where data exists.
7. Remove replaced Phoenix rendering code only after parity tests pass.

### Phase 6 — QA and release

1. Run unit, lint, type, and existing market tests.
2. Run device gesture checks on iOS and Android.
3. Run responsive and keyboard checks on web.
4. Compare behavior to the approved mock.
5. Verify no order-entry regression in Phoenix market detail.

---

## 26. Test strategy

### 26.1 Pure unit tests

Geometry tests:

- maps first and last visible candle to plot bounds;
- calculates price domain from visible highs/lows;
- handles a flat-price domain;
- clamps candle body width;
- maps x coordinate to nearest visible candle;
- maps price to y and back within tolerance;
- reserves axis and volume bounds correctly.

Viewport tests:

- initial fit uses latest candles;
- pan clamps at both ends;
- zoom anchors the requested ratio;
- minimum and maximum visible counts apply;
- append while live follows latest;
- append while historical preserves timestamps;
- prepend preserves timestamps;
- external reset restores latest fit;
- live-edge threshold does not flicker.

Normalization tests:

- sorts ascending input;
- deduplicates by timestamp deterministically;
- rejects non-finite OHLC;
- rejects invalid high/low relationships;
- preserves missing volume as null;
- does not mutate source rows.

Marker tests:

- maps exact timestamps;
- rejects timestamps that do not identify a candle;
- rejects out-of-range markers;
- groups same-candle markers;
- selects the intended marker inside overlapping hit targets.

### 26.2 Component tests

- renders loading, empty, error, and ready states;
- calls retry once;
- renders candle mode and line mode;
- hides optional layers when disabled;
- emits selection and clear events;
- emits live-edge viewport changes;
- preserves selected timestamp across immutable data replacement;
- clears selection on series identity reset;
- exposes the correct accessibility role, label, value, and actions.

### 26.3 Phoenix integration tests

- adapter maps all required Phoenix fields;
- timeframe controls call the existing interval/count pairs;
- changing timeframe clears selection and loads new data;
- latest price callback continues to update the detail screen;
- scrub callback continues to replace the displayed price/time;
- error retry invokes Phoenix loading;
- story markers remain optional and selectable;
- order composer state is unaffected by chart gestures.

### 26.4 Manual device matrix

| Platform | Required checks |
|---|---|
| iOS phone | pan, pinch, long press, pinned selection, double tap, VoiceOver |
| Android phone | pan, pinch, long press, pinned selection, double tap, TalkBack |
| Narrow web | responsive labels, pointer pan, wheel zoom, keyboard |
| Desktop web | pointer hit targets, double click/tap reset, resize |

### 26.5 Visual regression views

Capture at minimum:

- positive candles with volume;
- negative candles with volume;
- line mode;
- pinned crosshair;
- selected marker near left edge;
- selected marker near right edge;
- historical viewport without a fixed reset-to-live button;
- loading;
- empty;
- error;
- 320px width;
- large accessibility text where supported.

---

## 27. Acceptance criteria

### Component boundary

1. `MarketChart` imports no venue, wallet, route, API, or analytics module.
2. A screen can render the chart using only normalized candles, configuration, and callbacks.
3. Timeframe and mode controls remain outside the shared component.
4. The chart never mutates consumer data.

### Rendering

5. Valid OHLCV data renders as candlesticks.
6. The same data renders as a close-price line when `mode = 'line'`.
7. Switching mode preserves viewport and timestamp selection.
8. Volume can be shown or hidden without affecting the price scale.
9. Current price renders from the latest candle.
10. Marker visibility is configurable.
11. Axes remain readable at 320px width.
12. Flat, tiny, and large price ranges do not produce NaN or clipped geometry.

### Interaction

13. One-finger drag pans horizontally.
14. Pinch zooms around the finger midpoint.
15. Wheel zoom works around the pointer on web.
16. Long press activates after approximately 330 ms.
17. Dragging after long press scrubs candles.
18. Release leaves the selected candle pinned.
19. Tapping elsewhere clears the selection.
20. Marker tap selects the mapped candle and emits the marker.
21. Double tap resets to latest fit.
22. Keyboard arrows, Escape, and End perform their documented actions.

### Live updates

23. Replacing the current candle does not reset the viewport.
24. Appending a candle while live keeps the user at live.
25. Appending a candle while historical does not move the viewport.
26. Prepending history preserves the visible timestamp window.
27. The parent can detect `atLiveEdge: false` and reset through `resetSignal`.

### States and accessibility

28. Loading, empty, error, and ready states match the approved behavior.
29. Retry is rendered only when the parent supplies `onRetry`.
30. The chart exposes a single understandable adjustable accessibility region.
31. Selected OHLC and marker values are available to assistive technology.
32. Reduced motion removes non-essential animation.
33. Touch targets for interactive markers and actions are at least 44 logical pixels.

### Phoenix proof

34. Phoenix 1H, 1D, 1W, and 1M ranges use real existing OHLCV data.
35. Phoenix latest-price and scrub callbacks continue to work.
36. Phoenix can switch between Candles and Line.
37. Phoenix can toggle Volume and available Markers.
38. Phoenix loading/error behavior remains recoverable.
39. Phoenix trading and order-form behavior has no chart-caused regression.
40. The approved mock and production behavior have no unexplained interaction drift.

---

## 28. Success measures

V1 is foundational, so success is measured by correctness and adoption rather than short-term engagement.

### Required release measures

- zero chart-caused crash in the Phoenix detail smoke suite;
- no NaN/Infinity geometry in test fixtures;
- gesture behavior passes the manual device matrix;
- existing Phoenix market tests stay green;
- no new native chart dependency;
- one shared component replaces the venue renderer without moving data ownership into the core.

### Follow-up measures

- time required to add a second real consumer;
- number of consumer-specific changes required in shared core;
- interaction error reports grouped by platform;
- render-frame regression when visible candle count increases;
- accessibility audit findings.

No retention or trading-volume claim is attached to v1.

---

## 29. Telemetry boundary

The shared chart emits neutral callbacks only. It does not log analytics directly.

Parents may record:

- chart mode changed;
- timeframe changed;
- first pan or zoom in a session;
- inspection started;
- marker opened;
- reset to live invoked;
- chart retry requested;
- chart data load failed.

Do not record every scrubbed candle, raw pointer coordinate, wallet identifier, or marker detail. Analytics payloads use product-approved identifiers and privacy rules.

---

## 30. Risks and mitigations

### Risk 1 — “Dumb” becomes monolithic

Every new screen may ask the chart to own its controls, formatting, and data policy.

Mitigation: enforce the ownership section in review; add generic render layers only when at least one concrete screen requires them.

### Risk 2 — Gesture conflicts with screen scroll

A vertically scrolling market screen can fight the chart for touch ownership.

Mitigation: compose gestures deliberately; claim horizontal pan after threshold; cancel pending long press on scroll-like motion; test inside the real detail screen.

### Risk 3 — SVG performance

Large candle sets can create too many React Native SVG nodes.

Mitigation: render visible candles only, overscan modestly, cap v1 supported input, and profile before considering a heavier renderer.

### Risk 4 — Viewport reset bugs

Live updates can repeatedly snap a user out of historical inspection.

Mitigation: use timestamp-anchored pure viewport rules and explicit tests for replace, append, and prepend.

### Risk 5 — Marker scope explosion

Wallet, story, holder, trade, and thesis features may each demand bespoke marker UI.

Mitigation: core renders a stable anchor and emits selection; the parent renders rich details and actions.

### Risk 6 — Inconsistent formatters

Bad price precision can make the chart appear wrong even when geometry is correct.

Mitigation: require parent formatters and add fixtures for tiny meme-token prices, large perpetual prices, and probability values.

### Risk 7 — Spot data misrepresentation

Momentum statistics could be passed as candles to ship Spot quickly.

Mitigation: Spot remains blocked on the provider decision in `SPOT-P2-05`; adapters must receive actual timestamped OHLC history.

---

## 31. Rollout and rollback

### Rollout

1. Land shared pure functions and tests without changing production UI.
2. Land the component behind the Phoenix container.
3. Enable for internal/dev builds.
4. Complete the manual device matrix.
5. Replace the old Phoenix renderer for the normal Phoenix path.
6. Monitor crash and error diagnostics through the next app build.

### Rollback

The Phoenix container remains the seam. During rollout, a temporary local feature flag may choose the previous renderer without changing API or market-detail code. The flag is removed after the shared chart is stable; it is not a permanent remote config requirement.

Rollback never changes candle fetching, trading, or wallet state.

---

## 32. Future extensions, explicitly after v1

Possible additions use the same engine only after a concrete product requirement:

- holder or wallet activity markers;
- user-swap markers;
- story/thesis overlays;
- market-cap display using parent-transformed values;
- comparison line layers;
- moving averages;
- indicator panes;
- interval-aware lazy history loading;
- selectable y-axis behavior;
- log scale;
- percentage scale;
- annotations tied to canonical entities;
- saved viewport or layout preferences.

Each extension must answer:

1. Is this rendering or product meaning?
2. Can the parent prepare display-ready data?
3. Does it fit an existing layer without coupling to a venue?
4. What is the mobile interaction and accessibility equivalent?
5. What performance bound changes?

---

## 33. Resolved implementation questions

1. The public name is `MarketChart`.
2. `seriesKey` is an explicit required prop; consumers do not need to remount the component.
3. `formatAxisPrice` formats compact y-axis/current-price labels and defaults to `formatPrice`.
4. V1 draws both vertical and horizontal crosshair rules. The parent inspector remains the complete textual readout; no second floating price bubble is added.
5. Repeated taps cycle exact markers in a same-candle group and emit the selected marker to the parent.
6. The visible-only batched SVG implementation does not require Reanimated-owned chart state in v1.

---

## 34. Definition of done

Engineering implementation is complete when:

- implementation exists for all 40 acceptance criteria, with automatable behavior covered by the branch test suite;
- the pure viewport and geometry suite is green;
- the Phoenix adapter and integration suite is green;
- the Expo lint/type checks for touched files pass;
- the old Phoenix rendering engine is removed or has a documented temporary rollback flag;
- no venue or API logic exists in `features/charts/`;
- documentation names the next consumer but does not silently migrate it.

Release sign-off additionally requires the owner-run checks intentionally excluded from this implementation session:

- iOS, Android, and web smoke checks are recorded;
- the rendered component matches the approved mock's behavior;
- screen-reader and keyboard actions are manually verified;
- product signs off on Candles, Line, volume, marker, pinned selection, and live-edge behavior.

### 34.1 Implementation verification record — 2026-09-05

- `pnpm --filter hybrid-expo test:charts`: passed, including normalization, visible geometry, batched paths, viewport/live updates, markers, accessibility values, Phoenix adapters/configuration, and architecture boundaries.
- `pnpm --filter hybrid-expo test:format`: passed, including active and pre-aborted request-signal forwarding.
- `pnpm --filter hybrid-expo test:markets`: passed with existing Phoenix chart-event fixtures.
- `pnpm --filter hybrid-expo lint`: passed.
- `pnpm --filter hybrid-expo exec tsc --noEmit`: passed.
- `pnpm --filter hybrid-expo exec expo export --platform web`: passed bundling and static generation for all 22 routes.
- `pnpm --filter hybrid-expo test`: passed all 317 tests in the complete hybrid Expo suite.
- No visual or manual test was run by Codex, per owner instruction.

---

## Appendix A — Phoenix acceptance fixture

A deterministic fixture should include:

- 96 candles at 15-minute intervals;
- a mix of rising, falling, and flat bodies;
- non-zero and zero volume;
- one same-timestamp last-candle replacement;
- one appended candle;
- four markers;
- two markers mapped to the same candle;
- one out-of-range marker;
- a price large enough to require compact axis labels.

The fixture is shared by geometry, component, screenshot, and Phoenix adapter tests so visual and behavioral expectations do not drift.

---

## Appendix B — Example Phoenix container composition

```tsx
<ChartControls
  mode={mode}
  timeframe={timeframe}
  showVolume={showVolume}
  showMarkers={showMarkers}
  onModeChange={setMode}
  onTimeframeChange={setTimeframe}
  onVolumeChange={setShowVolume}
  onMarkersChange={setShowMarkers}
/>

<MarketChart
  seriesKey={`${market.symbol}:${timeframe.interval}:${timeframe.count}`}
  candles={chartCandles}
  mode={mode}
  status={chartStatus}
  layers={{
    volume: showVolume,
    currentPrice: true,
    markers: showMarkers,
  }}
  markers={chartMarkers}
  formatPrice={formatPhoenixPrice}
  formatAxisPrice={formatPhoenixAxisPrice}
  formatTime={formatChartTime}
  formatVolume={formatCompactVolume}
  accessibilityLabel={`${market.displayName} price chart`}
  onSelectionChange={handleChartSelection}
  onViewportChange={handleChartViewport}
  onMarkerPress={handleMarkerPress}
  onRetry={loadCandles}
  resetSignal={resetSignal}
/>

<PhoenixChartInspector
  candle={selection.candle ?? chartCandles.at(-1) ?? null}
  marker={selection.marker}
/>
```

This is illustrative, not a mandate for the exact component names or JSX structure. The ownership and event direction are mandatory.

---

## Appendix C — Review checklist

### Product review

- Does v1 match the approved interaction mock?
- Is any screen-level meaning leaking into the component?
- Are any TradingView expectations implied but not delivered?
- Are the non-goals clear enough to reject scope creep?

### Design review

- Are chart values legible at 320px?
- Are positive/negative and selected states clear without color alone?
- Does the marker detail remain inside safe bounds?
- Does reduced motion preserve meaning?

### Engineering review

- Are viewport operations timestamp-stable?
- Can pure geometry be tested without React Native?
- Are only visible SVG marks mounted?
- Are callbacks throttled independently from drawing?
- Does the Phoenix adapter own all Phoenix-specific conversion?

### QA review

- Does every gesture have an accessible equivalent?
- Are gesture conflicts tested in the actual scrolling screen?
- Are append, replace, prepend, and reset all covered?
- Are error and empty states distinguishable?

---

## Appendix D — Glossary

**Candle** — Timestamped open, high, low, close, and optional volume values for one market interval.

**Live edge** — A viewport whose right boundary is at the newest available candle.

**Pinned selection** — A selected candle that remains selected after the inspecting gesture ends.

**Viewport** — The subset of candle slots currently visible in the plot.

**Layer** — One independent visual concern drawn into the shared coordinate system.

**Marker** — Display-ready metadata anchored to a candle with the exact same timestamp.

**Screen owner** — The product container that chooses data, controls, formatting, copy, callbacks, and business behavior around `MarketChart`.

**Dumb component** — A renderer with local presentation state but no product, venue, network, wallet, or persistence policy.

**Series identity** — The market plus interval combination whose viewport should be reset when it changes.

**Normalized data** — Venue data converted to the shared candle invariants before it reaches the chart.
