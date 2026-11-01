# locked/fonts

Fonts used by overlays and graphics.

LOCKED assets are made once, approved, and reused every episode. Never regenerated per episode.

## Brand fonts (awaiting approval)

Same families and weights as apps/web/src/app/layout.tsx (next/font/google). Files are the latin woff2 subsets from @fontsource v5.3.0 (npm), which repackages Google Fonts. Licence: SIL OFL 1.1.

| Role | Family | Weights | Files |
|---|---|---|---|
| headline | Space Grotesk | 300, 400, 500, 700 | space-grotesk-latin-*-normal.woff2 |
| body | Inter | 400, 500, 600 | inter-latin-*-normal.woff2 |
| mono | Geist Mono | 400, 500 | geist-mono-latin-*-normal.woff2 |

Loaded in Remotion by `loadBrandFonts()` in src/brand.ts. The Expo app uses system fonts (it lists @expo-google-fonts/jetbrains-mono as a dependency but never loads it).
