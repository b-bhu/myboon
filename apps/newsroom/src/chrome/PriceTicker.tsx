import { useCurrentFrame, useVideoConfig } from "remotion";
import { colors, fonts, ticker } from "../brand";
import { formatChange, formatPrice, TickerItem, useTickerData } from "../ticker";
import { layout } from "./layout";

const ITEM_W = 380; // fixed slot width per item keeps loop length exact

const Item: React.FC<{ i: TickerItem }> = ({ i }) => {
  const c = i.changePct > 0 ? ticker.up : i.changePct < 0 ? ticker.down : ticker.flat;
  const arrow = i.changePct > 0 ? "▲" : i.changePct < 0 ? "▼" : "■";
  return (
    <div style={{ width: ITEM_W, flexShrink: 0, display: "flex", alignItems: "center", gap: 14, fontFamily: fonts.mono, fontSize: 28, fontWeight: 500 }}>
      <span style={{ color: colors.bone }}>{i.symbol}</span>
      <span style={{ color: colors.textDim }}>{formatPrice(i.price)}</span>
      <span style={{ color: c }}>{arrow} {formatChange(i.changePct)}</span>
    </div>
  );
};

export const TickerStrip: React.FC<{ items: TickerItem[] }> = ({ items }) => {
  const f = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const loopW = items.length * ITEM_W;
  const copies = Math.ceil(width / loopW) + 1;
  const x = -((f / fps) * layout.tickerSpeed % loopW);
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: layout.tickerHeight, background: colors.walletCore, borderTop: `1px solid ${colors.borderMuted}`, overflow: "hidden" }}>
      <div style={{ position: "absolute", top: 0, bottom: 0, left: layout.margin, display: "flex", transform: `translateX(${x}px)` }}>
        {Array.from({ length: copies }).flatMap((_, k) => items.map((i, n) => <Item key={`${k}-${n}`} i={i} />))}
      </div>
    </div>
  );
};

export const PriceTicker: React.FC<{ slug: string }> = ({ slug }) => {
  const items = useTickerData(slug);
  return items ? <TickerStrip items={items} /> : null;
};
