import { AbsoluteFill, Img } from "remotion";
import { colors, fonts, logos, loadBrandFonts, radius } from "./brand";

loadBrandFonts();

export const BrandKitPreview: React.FC = () => (
  <AbsoluteFill style={{ background: colors.walletCore, padding: 80, color: colors.bone, gap: 40 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 48 }}>
      <Img src={logos.wordmark} style={{ height: 160 }} />
      <Img src={logos.icon} style={{ height: 160, borderRadius: radius.md * 4 }} />
    </div>
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
      {Object.entries(colors).map(([k, v]) => (
        <div key={k} style={{ width: 190 }}>
          <div style={{ height: 90, background: v, borderRadius: radius.md, border: `1px solid ${colors.borderMuted}` }} />
          <div style={{ fontFamily: fonts.mono, fontSize: 18, marginTop: 6 }}>{k}</div>
          <div style={{ fontFamily: fonts.mono, fontSize: 16, color: colors.textDim }}>{v}</div>
        </div>
      ))}
    </div>
    <div style={{ fontFamily: fonts.headline, fontWeight: 700, fontSize: 64 }}>Space Grotesk 700 — Bitcoin ETFs see outflows</div>
    <div style={{ fontFamily: fonts.body, fontWeight: 500, fontSize: 44, color: colors.textDim }}>Inter 500 — Every market move explained as it happens</div>
    <div style={{ fontFamily: fonts.mono, fontSize: 40 }}>
      Geist Mono 400 — BTC <span style={{ color: colors.positive }}>▲ 2.41%</span> ETH <span style={{ color: colors.live }}>▼ 1.08%</span>
    </div>
  </AbsoluteFill>
);
