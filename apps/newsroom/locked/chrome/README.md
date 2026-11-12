# locked/chrome

Overlay graphics: logo, lower third, price ticker, BREAKING bar designs.

LOCKED assets are made once, approved, and reused every episode. Never regenerated per episode.

## Brand kit (awaiting approval)

Copied unchanged from the app, not redrawn:

| File | Source |
|---|---|
| myboon-wordmark-header.png (420x218, transparent) | apps/web/public/branding/ (identical to apps/hybrid-expo/assets/branding/) |
| myboon-wordmark-small@2x.png (111x88) | apps/web/public/branding/ |
| myboon-app-icon-v2.svg | apps/hybrid-expo/assets/branding/ |
| myboon-app-icon-foreground-v2.svg | apps/hybrid-expo/assets/branding/ |
| myboon-app-icon-monochrome-v2.svg | apps/hybrid-expo/assets/branding/ |
| myboon-favicon.svg | apps/web/src/app/icon.svg |

Note: the SVGs use live `<text>` in Avenir Next (not outlined paths). Avenir is not on the render box, so they fall back to another sans. Use the PNG wordmark on air until an outlined vector exists.
Colours: src/brand.ts, from apps/web/src/lib/tokens.ts (matches expo tokens).
